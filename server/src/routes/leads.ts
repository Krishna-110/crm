import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { dbFor, withDbSession } from '../scopedPrisma.js';
import { ApiError } from '../errors.js';
import { assertLeadAssignable, isAdmin } from '../scope.js';
import {
  serializeLead,
  serializeLeadActivity,
  serializeLeadMedicine,
  serializeFollowUp,
  serializeOrder,
  serializeOrderItem,
} from '../serializers.js';

export const leadsRouter = Router();

// The LATERAL + json_agg pair becomes a nested include. Prisma issues one query per
// relation and joins in memory rather than a single LATERAL query — same shape, different
// plan. Ordering is preserved exactly: medicines ascending, activities DESCENDING.
const WITH_CHILDREN = {
  lead_medicines: { orderBy: { created_at: 'asc' } },
  lead_activities: { orderBy: { created_at: 'desc' } },
} satisfies Prisma.leadsInclude;

type LeadWithChildren = Prisma.leadsGetPayload<{ include: typeof WITH_CHILDREN }>;
type Db = ReturnType<typeof dbFor>;

function toLead(lead: LeadWithChildren) {
  return serializeLead(
    lead,
    lead.lead_medicines.map(serializeLeadMedicine),
    lead.lead_activities.map(serializeLeadActivity),
  );
}

/** Shared with routes/followUps.ts. Takes a scoped client so the caller's scope applies. */
export async function fetchLeadById(db: Db, id: string) {
  const lead = await db.leads.findFirst({ where: { id, deleted_at: null }, include: WITH_CHILDREN });
  return lead ? toLead(lead) : null;
}

// Best-effort catalog match by exact (case-insensitive) name; null means free-text /
// uncatalogued. The original used `ILIKE $1` with no wildcards, i.e. case-insensitive
// equality rather than a pattern match — hence `equals` + insensitive mode, not `contains`.
async function matchProductId(db: Db, name: string): Promise<string | null> {
  const product = await db.products.findFirst({
    where: {
      is_active: true,
      OR: [
        { brand_name: { equals: name, mode: 'insensitive' } },
        { generic_name: { equals: name, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  return product?.id ?? null;
}

type MedicineInput = { name: string; days: number | string };

async function insertLeadMedicines(db: Db, leadId: string, medicines: MedicineInput[]) {
  for (const m of medicines) {
    const productId = await matchProductId(db, m.name);
    await db.lead_medicines.create({
      data: { lead_id: leadId, product_id: productId, medicine_name: m.name, days: Number(m.days) || 1 },
    });
  }
}

const LEAD_FIELD_MAP = {
  customerName: 'customer_name',
  mobile: 'mobile',
  alternateNumber: 'alternate_number',
  address: 'address',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  doctorName: 'doctor_name',
  disease: 'disease',
  assignedCaller: 'assigned_caller_id',
  leadSource: 'lead_source',
  status: 'status',
  notes: 'notes',
  paymentScreenshot: 'payment_screenshot',
  nextFollowUp: 'next_follow_up_at',
  lastFollowUp: 'last_follow_up_at',
} as const;

leadsRouter.get('/', async (req, res) => {
  const db = dbFor(req.actor);
  const leads = await db.leads.findMany({
    where: { deleted_at: null },
    include: WITH_CHILDREN,
    orderBy: { created_at: 'desc' },
  });
  res.json(leads.map(toLead));
});

leadsRouter.post('/', async (req, res) => {
  const actor = req.actor!;
  const body = req.body ?? {};

  for (const field of ['customerName', 'mobile', 'address', 'city', 'state', 'pincode', 'disease']) {
    if (!body[field]) throw ApiError.badRequest(`${field} is required`);
  }
  const medicines: MedicineInput[] = Array.isArray(body.medicines) ? body.medicines : [];
  if (medicines.length === 0) throw ApiError.badRequest('at least one medicine is required');

  // A caller's lead is force-assigned to them; only an admin may assign to someone else.
  const assignedCallerId = isAdmin(actor) ? body.assignedCaller || null : actor.userId;
  assertLeadAssignable(actor, assignedCallerId);

  const lead = await withDbSession(actor, async (tx) => {
    const created = await tx.leads.create({
      data: {
        customer_name: body.customerName,
        mobile: body.mobile,
        alternate_number: body.alternateNumber ?? null,
        address: body.address,
        city: body.city,
        state: body.state,
        pincode: body.pincode,
        // medicine_required is a denormalised summary kept so leads.search_vector still
        // matches on medicine names; quantity is a legacy NOT NULL-era column.
        medicine_required: medicines.map((m) => m.name).join(', '),
        quantity: 1,
        disease: body.disease,
        doctor_name: body.doctorName ?? null,
        assigned_caller_id: assignedCallerId,
        lead_source: body.leadSource ?? 'other',
        notes: body.notes ?? null,
        created_by: actor.userId,
      },
      select: { id: true },
    });

    await insertLeadMedicines(tx as Db, created.id, medicines);
    await tx.lead_activities.create({
      data: {
        lead_id: created.id,
        activity_type: 'created',
        description: `Lead created — ${body.disease}`,
        created_by: actor.userId,
      },
    });

    return fetchLeadById(tx as Db, created.id);
  });

  res.status(201).json(lead);
});

leadsRouter.patch('/:id', async (req, res) => {
  const actor = req.actor!;
  const body = req.body ?? {};

  const lead = await withDbSession(actor, async (tx) => {
    const before = await tx.leads.findFirst({
      where: { id: req.params.id, deleted_at: null },
      select: { status: true, assigned_caller_id: true, address: true, pincode: true, payment_screenshot: true },
    });
    if (!before) throw ApiError.notFound('Lead not found');

    const targetStatus = 'status' in body ? body.status : before.status;
    if (targetStatus === 'sold') {
      const address = 'address' in body ? body.address : before.address;
      const pincode = 'pincode' in body ? body.pincode : before.pincode;
      const paymentScreenshot =
        'paymentScreenshot' in body ? body.paymentScreenshot : before.payment_screenshot;

      if (!address || !String(address).trim()) {
        throw ApiError.badRequest('Address is required when Lead Status is Sold');
      }
      if (!pincode || !String(pincode).trim()) {
        throw ApiError.badRequest('Pincode is required when Lead Status is Sold');
      }
      if (!paymentScreenshot || !String(paymentScreenshot).trim()) {
        throw ApiError.badRequest('Payment Screenshot is required when Lead Status is Sold');
      }
    }

    // A caller must not be able to reassign a lead away from themselves.
    if ('assignedCaller' in body) assertLeadAssignable(actor, body.assignedCaller ?? null);

    const data: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(LEAD_FIELD_MAP)) {
      // `key in body`, so an explicit null clears the column — Prisma would skip undefined.
      if (key in body) data[field] = body[key] ?? null;
    }
    if (Object.keys(data).length > 0) {
      const { count } = await tx.leads.updateMany({
        where: { id: req.params.id, deleted_at: null },
        data: data as Prisma.leadsUpdateManyMutationInput,
      });
      if (count === 0) throw ApiError.notFound('Lead not found');
    }

    if (Array.isArray(body.medicines)) {
      await tx.lead_medicines.deleteMany({ where: { lead_id: req.params.id } });
      await insertLeadMedicines(tx as Db, req.params.id, body.medicines);
      await tx.leads.updateMany({
        where: { id: req.params.id },
        data: { medicine_required: body.medicines.map((m: MedicineInput) => m.name).join(', ') },
      });
    }

    if ('status' in body && body.status !== before.status) {
      await tx.lead_activities.create({
        data: {
          lead_id: req.params.id,
          activity_type: 'status_change',
          description: `Status changed from ${before.status} to ${body.status}`,
          created_by: actor.userId,
        },
      });
    }
    if ('assignedCaller' in body && body.assignedCaller !== before.assigned_caller_id) {
      const caller = body.assignedCaller
        ? await tx.users.findUnique({ where: { id: body.assignedCaller }, select: { name: true } })
        : null;
      await tx.lead_activities.create({
        data: {
          lead_id: req.params.id,
          activity_type: 'assignment',
          description: `Assigned to ${caller?.name ?? 'Unassigned'}`,
          created_by: actor.userId,
        },
      });
    }

    return fetchLeadById(tx as Db, req.params.id);
  });

  res.json(lead);
});

leadsRouter.delete('/:id', async (req, res) => {
  const actor = req.actor!;

  // Soft delete, so this is an UPDATE and falls under leads_update (admin OR own lead)
  // rather than the admin-only leads_delete policy. prevent_caller_lead_lifecycle_changes
  // separately blocks callers from soft-deleting even their OWN lead, surfacing as
  // P0001 -> 403. That trigger reads app_current_role(), so it only fires because this
  // runs inside withDbSession — on a bare Prisma connection the GUC is NULL, the
  // `IF app_current_role() = 'caller'` branch is skipped, and the delete silently
  // succeeds. Do not take this out of the session.
  const count = await withDbSession(actor, async (tx) => {
    const r = await tx.leads.updateMany({
      where: { id: req.params.id, deleted_at: null },
      data: { deleted_at: new Date(), updated_by: actor.userId },
    });
    return r.count;
  });
  if (count === 0) throw ApiError.notFound('Lead not found');
  res.status(204).end();
});

leadsRouter.post('/:id/activities', async (req, res) => {
  const actor = req.actor!;
  const body = req.body ?? {};

  const description = body.description;
  if (!description) throw ApiError.badRequest('description is required');

  const medicineInput = body.medicine;
  if (medicineInput !== undefined && medicineInput !== null) {
    if (typeof medicineInput.name !== 'string' || !medicineInput.name.trim()) {
      throw ApiError.badRequest('medicine name is required');
    }
    if (!Number.isFinite(Number(medicineInput.days)) || Number(medicineInput.days) <= 0) {
      throw ApiError.badRequest('medicine days must be a positive number');
    }
  }

  const result = await withDbSession(actor, async (tx) => {
    // Was an INSERT ... SELECT that both proved the lead existed (and was visible) and
    // supplied the FK; split into an explicit scoped lookup so the 404 is unambiguous.
    const lead = await tx.leads.findFirst({
      where: { id: req.params.id, deleted_at: null },
      select: { id: true },
    });
    if (!lead) throw ApiError.notFound('Lead not found');

    const activity = await tx.lead_activities.create({
      data: {
        lead_id: lead.id,
        activity_type: 'comment',
        description,
        created_by: actor.userId,
      },
    });

    let medicine = null;
    if (medicineInput) {
      await insertLeadMedicines(tx as Db, lead.id, [
        { name: medicineInput.name.trim(), days: medicineInput.days },
      ]);

      const all = await tx.lead_medicines.findMany({
        where: { lead_id: lead.id },
        orderBy: { created_at: 'asc' },
      });
      await tx.leads.updateMany({
        where: { id: lead.id },
        data: { medicine_required: all.map((m) => m.medicine_name).join(', ') },
      });
      const newest = all[all.length - 1];
      if (newest) medicine = serializeLeadMedicine(newest);
    }

    return { activity: serializeLeadActivity(activity), medicine };
  });

  res.status(201).json(result);
});

leadsRouter.post('/:id/convert', async (req, res) => {
  const actor = req.actor!;
  const unitPrice = Number(req.body?.unitPrice) || 0;

  // withDbSession, not a plain transaction: convert_lead_to_order() enforces its own
  // "a caller may only convert their own lead" check via app_current_role(), which is
  // unset on a bare Prisma connection — the guard would silently pass for everyone and
  // created_by would be NULL. See scopedPrisma.withDbSession.
  const result = await withDbSession(actor, async (tx) => {
    const rows = await tx.$queryRaw<{ order_id: string }[]>`
      SELECT convert_lead_to_order(${req.params.id}::uuid, ${unitPrice}::numeric) AS order_id
    `;
    const orderId = rows[0]?.order_id;
    if (!orderId) throw ApiError.notFound('Lead not found');

    const order = await tx.orders.findFirst({
      where: { id: orderId, deleted_at: null },
      include: { order_items: { orderBy: { created_at: 'asc' } } },
    });
    const lead = await fetchLeadById(tx as unknown as Db, req.params.id);
    return {
      order: order ? serializeOrder(order, order.order_items.map(serializeOrderItem)) : null,
      lead,
    };
  });

  res.json(result);
});

leadsRouter.post('/:id/follow-ups', async (req, res) => {
  const actor = req.actor!;
  const body = req.body ?? {};
  if (!body.scheduledDate) throw ApiError.badRequest('scheduledDate is required');

  // Same reasoning as /convert: resolve_or_create_customer_for_lead() carries its own
  // caller-ownership guard that depends on the session GUC.
  const result = await withDbSession(actor, async (tx) => {
    const rows = await tx.$queryRaw<{ customer_id: string }[]>`
      SELECT resolve_or_create_customer_for_lead(${req.params.id}::uuid) AS customer_id
    `;
    const customerId = rows[0]?.customer_id;

    const lead = await tx.leads.findFirst({
      where: { id: req.params.id },
      select: { id: true, customer_name: true },
    });
    if (!lead) throw ApiError.notFound('Lead not found');

    const followUp = await tx.follow_ups.create({
      data: {
        customer_id: customerId ?? null,
        customer_name: lead.customer_name,
        lead_id: lead.id,
        scheduled_at: new Date(body.scheduledDate),
        type: body.type ?? 'call',
        status: 'pending',
        notes: body.notes ?? null,
        created_by: actor.userId,
      },
    });

    await tx.leads.updateMany({
      where: { id: lead.id },
      data: { next_follow_up_at: new Date(body.scheduledDate) },
    });
    await tx.lead_activities.create({
      data: {
        lead_id: lead.id,
        activity_type: 'follow_up',
        description: `Follow-up scheduled for ${body.scheduledDate}`,
        created_by: actor.userId,
      },
    });

    return {
      followUp: serializeFollowUp(followUp),
      lead: await fetchLeadById(tx as unknown as Db, lead.id),
    };
  });

  res.status(201).json(result);
});
