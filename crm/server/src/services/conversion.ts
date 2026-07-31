import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../lib/errors.js';
import { normalizeIndianMobile } from '../lib/mobile.js';
import { isAdmin, type Actor } from '../auth/scope.js';
import { lineTotal, nextOrderNumber, payableAmount } from './orders.js';
import { auditCreate, auditUpdate } from './audit.js';

/**
 * Converting a lead into an order.
 *
 * This was `convert_lead_to_order`, a SECURITY DEFINER PL/pgSQL routine. Being DEFINER meant
 * it ran with the owner's privileges and so had to re-implement the caller-ownership check
 * itself — reading a session variable to find out who was asking. That indirection is the
 * single thing that made the old design fragile: on a connection where the variable had not
 * been set it read NULL, the check never matched, and the guard silently passed.
 *
 * Here the actor is a parameter. There is no second source of truth about who is calling.
 *
 * Everything happens in one interactive transaction: customer resolution, the order, its
 * lines, stock deduction, the lead's status change and the activity record. A partial
 * conversion — an order with no lines, or stock deducted for an order that failed — is the
 * failure mode worth designing against.
 */
export async function convertLeadToOrder(
  actor: Actor,
  leadId: string,
  fallbackUnitPrice: Prisma.Decimal | number = 0,
) {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      include: { medicines: { orderBy: { createdAt: 'asc' } } },
    });
    if (!lead) throw ApiError.notFound('Lead not found');

    // Ownership. A caller may convert only their own lead.
    if (!isAdmin(actor) && lead.assignedCallerId !== actor.userId) {
      throw ApiError.forbidden('You may only convert your own leads');
    }
    if (lead.status === 'converted') {
      throw ApiError.badRequest('This lead has already been converted');
    }

    // ── 1. resolve or create the customer ────────────────────────────────────────────────
    // Deduped on the normalised mobile, so "+91 98765 43210" and "09876543210" find the same
    // person rather than creating a second record.
    let customerId = lead.customerId;
    if (!customerId) {
      const mobile = normalizeIndianMobile(lead.mobile);
      const existing = mobile
        ? await tx.customer.findFirst({ where: { primaryMobile: mobile, deletedAt: null } })
        : null;

      if (existing) {
        customerId = existing.id;
      } else {
        const customer = await tx.customer.create({
          data: {
            fullName: lead.customerName,
            primaryMobile: mobile ?? lead.mobile,
            alternateMobile: lead.alternateNumber,
            address: lead.address,
            city: lead.city,
            state: lead.state,
            pincode: lead.pincode,
            doctorName: lead.doctorName,
          },
        });
        customerId = customer.id;
        await auditCreate(tx, actor, 'customers', customer);
      }
      await tx.lead.update({ where: { id: lead.id }, data: { customerId } });
    }

    const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });

    // ── 2. the order ─────────────────────────────────────────────────────────────────────
    // A lead marked sold with a payment screenshot arrives already paid.
    const paid = lead.status === 'sold' && !!lead.paymentScreenshot?.trim();

    const order = await tx.order.create({
      data: {
        orderNumber: await nextOrderNumber(tx),
        customerId,
        leadId: lead.id,
        customerName: customer.fullName,
        shippingAddress: [lead.address, lead.city, lead.state, lead.pincode].filter(Boolean).join(', '),
        stage: 'confirmed',
        paymentStatus: paid ? 'paid' : 'pending',
        createdBy: actor.userId,
      },
    });

    // ── 3. one line per requested medicine ───────────────────────────────────────────────
    // Falls back to the lead's single denormalised medicine when no rows exist — older leads
    // predate the lead_medicines table and must still be convertible.
    const requested = lead.medicines.length
      ? lead.medicines.map((m) => ({ productId: m.productId, name: m.medicineName, quantity: 1 }))
      : lead.medicineRequired
        ? [{ productId: null, name: lead.medicineRequired, quantity: Math.max(lead.quantity ?? 1, 1) }]
        : [];

    if (requested.length === 0) {
      throw ApiError.badRequest('This lead has no medicines to convert');
    }

    let total = new Prisma.Decimal(0);
    for (const item of requested) {
      const product = item.productId
        ? await tx.product.findUnique({ where: { id: item.productId } })
        : null;
      const unitPrice = product?.unitPrice ?? new Prisma.Decimal(fallbackUnitPrice);
      const total_ = lineTotal(item.quantity, unitPrice);
      total = total.add(total_);

      await tx.orderItem.create({
        data: {
          orderId: order.id,
          productId: item.productId,
          medicineNameSnapshot: item.name,
          quantity: item.quantity,
          unitPriceSnapshot: unitPrice,
          lineTotal: total_,
        },
      });

      // Stock floors at zero rather than blocking the sale. A pharmacy fulfils and restocks;
      // it does not refuse a customer because a counter is stale.
      if (product) {
        await tx.product.update({
          where: { id: product.id },
          data: { stockQuantity: Math.max(product.stockQuantity - item.quantity, 0) },
        });
      }
    }

    const priced = await tx.order.update({
      where: { id: order.id },
      data: {
        totalAmount: total,
        payableAmount: payableAmount(total, order.discountType, order.discountValue),
      },
      include: { items: true },
    });
    await auditCreate(tx, actor, 'orders', priced);

    // ── 4. close the lead ────────────────────────────────────────────────────────────────
    const converted = await tx.lead.update({
      where: { id: lead.id },
      data: { status: 'converted' },
    });
    await auditUpdate(tx, actor, 'leads', lead, converted);

    await tx.leadActivity.create({
      data: {
        leadId: lead.id,
        activityType: 'status_change',
        description: `Lead converted to order ${priced.orderNumber}`,
        createdBy: actor.userId,
      },
    });

    return priced;
  });
}
