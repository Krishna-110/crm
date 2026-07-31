/**
 * Seed data.
 *
 * Dates are RELATIVE to the moment of seeding, never absolute. The previous project seeded
 * fixed 2026 dates, which meant every date-derived assertion — renewal status, follow-up
 * buckets, "leads this month" — silently changed meaning as the calendar moved, and had to
 * be patched by sliding every timestamp at load time. Anchoring to now() removes that whole
 * class of problem: the fixture always sits the same distance from today.
 *
 * Run: npm run db:seed   (or automatically via `prisma migrate reset`)
 */
import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/** Days relative to now, so the fixture never rots. */
const at = (days: number, hour = 10): Date => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

const LOOKUPS = {
  leadStatus: [
    ['new', 'New'], ['contacted', 'Contacted'], ['follow_up_pending', 'Follow-up Pending'],
    ['interested', 'Interested'], ['call_back_later', 'Call Back Later'],
    ['no_response', 'No Response'], ['not_interested', 'Not Interested'],
    ['converted', 'Converted'], ['sold', 'Sold'],
  ],
  leadSource: [
    ['website', 'Website'], ['referral', 'Referral'], ['walk_in', 'Walk-in'], ['phone', 'Phone'],
    ['social_media', 'Social Media'], ['advertisement', 'Advertisement'], ['other', 'Other'],
  ],
  orderStage: [
    ['lead', 'Lead'], ['confirmed', 'Confirmed'], ['medicine_prepared', 'Medicine Prepared'],
    ['packed', 'Packed'], ['shipped', 'Shipped'], ['delivered', 'Delivered'],
  ],
  paymentStatus: [['pending', 'Pending'], ['partial', 'Partial'], ['paid', 'Paid'], ['refunded', 'Refunded']],
  followUpType: [['call', 'Call'], ['reminder', 'Reminder'], ['callback', 'Callback']],
  followUpStatus: [['pending', 'Pending'], ['completed', 'Completed'], ['missed', 'Missed']],
};

/**
 * The catalogue, carried over from the previous database: seven pharma lines plus the
 * eighteen Ayurvedic products that were entered by hand and are real curated data.
 */
const PRODUCTS: [sku: string, generic: string, brand: string, form: string, price: number, stock: number][] = [
  ['MED-001', 'Metformin', 'Glycomet', 'tablet', 25.5, 99],
  ['MED-002', 'Amlodipine', 'Amlopres', 'tablet', 45, 100],
  ['MED-003', 'Atorvastatin', 'Atorva', 'tablet', 120, 92],
  ['MED-004', 'Insulin Glargine', 'Lantus', 'injection', 899, 100],
  ['MED-005', 'Levothyroxine', 'Eltroxin', 'tablet', 65, 100],
  ['MED-006', 'Azithromycin', 'Azithral', 'tablet', 85, 100],
  ['MED-007', 'Paracetamol', 'Paracetamol', 'tablet', 15, 100],
  ['MED-101', 'Tejasvi Ark', 'Tejasvi Ark', 'other', 0, 0],
  ['MED-102', 'Tejasvi Kadha', 'Tejasvi Kadha', 'other', 0, 0],
  ['MED-103', 'Vedic Shiv Amrit Ark', 'Vedic Shiv Amrit Ark', 'other', 0, 0],
  ['MED-104', 'Vedic Shiv Amrit Syrup', 'Vedic Shiv Amrit Syrup', 'syrup', 0, 0],
  ['MED-105', 'Anus Care 1', 'Anus Care 1', 'other', 0, 0],
  ['MED-106', 'Anus Care 2', 'Anus Care 2', 'other', 0, 0],
  ['MED-107', 'Anus Care Cream', 'Anus Care Cream', 'other', 0, 0],
  ['MED-108', 'Kamaking Capsule', 'Kamaking Capsule', 'capsule', 0, 0],
  ['MED-109', 'Kamaking Oil', 'Kamaking Oil', 'other', 0, 0],
  ['MED-110', 'Asthma Powder', 'Asthma Powder', 'other', 0, 0],
  ['MED-111', 'Asthma Tab', 'Asthma Tab', 'tablet', 0, 0],
  ['MED-112', 'Ashwashila Malt', 'Ashwashila Malt', 'other', 0, 0],
  ['MED-113', 'Weight Gain Powder', 'Weight Gain Powder', 'other', 0, 0],
  ['MED-114', 'Weight Loss Powder', 'Weight Loss Powder', 'other', 0, 0],
  ['MED-115', 'Kidney Kaya Syrup', 'Kidney Kaya Syrup', 'syrup', 0, 0],
  ['MED-116', 'Lady Gold Ark', 'Lady Gold Ark', 'other', 0, 0],
  ['MED-117', 'Sansamrit', 'Sansamrit', 'other', 0, 0],
  ['MED-118', 'Dardantak Powder', 'Dardantak Powder', 'other', 0, 0],
];

/** Demo credentials, documented in the README. Development only. */
const ADMIN_PASSWORD = 'admin123';
const CALLER_PASSWORD = 'caller123';

async function main() {
  console.log('seeding...');

  // ── lookups ────────────────────────────────────────────────────────────────────────────
  // Written out per model rather than through a generic helper: Prisma's delegate types are
  // model-specific, so a shared helper needs an `unknown` cast that defeats the point of
  // having them. Six short loops stay fully type-checked.
  const seedLookup = async <T extends { code: string; label: string; sortOrder: number }>(
    upsert: (args: {
      where: { code: string };
      create: T;
      update: { label: string; sortOrder: number };
    }) => Promise<unknown>,
    rows: string[][],
  ) => {
    for (const [i, row] of rows.entries()) {
      const [code, label] = row as [string, string];
      await upsert({
        where: { code },
        create: { code, label, sortOrder: i } as T,
        update: { label, sortOrder: i },
      });
    }
  };

  await seedLookup((a) => prisma.leadStatus.upsert(a), LOOKUPS.leadStatus);
  await seedLookup((a) => prisma.leadSource.upsert(a), LOOKUPS.leadSource);
  await seedLookup((a) => prisma.orderStage.upsert(a), LOOKUPS.orderStage);
  await seedLookup((a) => prisma.paymentStatus.upsert(a), LOOKUPS.paymentStatus);
  await seedLookup((a) => prisma.followUpType.upsert(a), LOOKUPS.followUpType);
  await seedLookup((a) => prisma.followUpStatus.upsert(a), LOOKUPS.followUpStatus);
  console.log('  lookups');

  // ── users ──────────────────────────────────────────────────────────────────────────────
  // Real bcrypt digests. The previous seed shipped placeholder strings that only looked like
  // hashes, so a database built from the documented steps could not be logged into at all.
  const [adminHash, callerHash] = await Promise.all([
    bcrypt.hash(ADMIN_PASSWORD, 10),
    bcrypt.hash(CALLER_PASSWORD, 10),
  ]);

  const people: [employeeId: string, name: string, email: string, phone: string, role: UserRole, status: UserStatus][] = [
    ['EMP001', 'Aarav Sharma', 'aarav.sharma@medicrm.in', '9810011111', UserRole.admin, UserStatus.active],
    ['EMP002', 'Priya Mehta', 'priya.mehta@medicrm.in', '9810022222', UserRole.admin, UserStatus.active],
    ['EMP004', 'Sneha Iyer', 'sneha.iyer@medicrm.in', '9812345678', UserRole.caller, UserStatus.active],
    ['EMP005', 'Vikram Singh', 'vikram.singh@medicrm.in', '9820055555', UserRole.caller, UserStatus.active],
    ['EMP006', 'Ananya Desai', 'ananya.desai@medicrm.in', '9820066666', UserRole.caller, UserStatus.active],
    ['EMP007', 'Arjun Nair', 'arjun.nair@medicrm.in', '9820077777', UserRole.caller, UserStatus.active],
    // Deliberately inactive, so negative-login behaviour is testable.
    ['EMP008', 'Kavya Reddy', 'kavya.reddy@medicrm.in', '9820088888', UserRole.caller, UserStatus.inactive],
  ];

  const users: Record<string, string> = {};
  for (const [employeeId, name, email, phone, role, status] of people) {
    const u = await prisma.user.upsert({
      where: { email },
      create: {
        employeeId, name, email, phone, role, status,
        passwordHash: role === UserRole.admin ? adminHash : callerHash,
      },
      update: { name, phone, role, status, passwordHash: role === UserRole.admin ? adminHash : callerHash },
    });
    users[email] = u.id;
  }
  console.log(`  users (${people.length})`);

  // ── catalogue ──────────────────────────────────────────────────────────────────────────
  for (const [sku, genericName, brandName, dosageForm, unitPrice, stockQuantity] of PRODUCTS) {
    await prisma.product.upsert({
      where: { sku },
      create: { sku, genericName, brandName, dosageForm, unitPrice, stockQuantity },
      update: { genericName, brandName, dosageForm, unitPrice, stockQuantity },
    });
  }
  console.log(`  products (${PRODUCTS.length})`);

  // ── pipeline ───────────────────────────────────────────────────────────────────────────
  const sneha = users['sneha.iyer@medicrm.in']!;
  const vikram = users['vikram.singh@medicrm.in']!;
  const ananya = users['ananya.desai@medicrm.in']!;
  const arjun = users['arjun.nair@medicrm.in']!;
  const admin = users['aarav.sharma@medicrm.in']!;

  if ((await prisma.lead.count()) === 0) {
    const atorva = await prisma.product.findUniqueOrThrow({ where: { sku: 'MED-003' } });
    const glycomet = await prisma.product.findUniqueOrThrow({ where: { sku: 'MED-001' } });

    const leads: [name: string, mobile: string, city: string, disease: string, status: string, caller: string, createdDaysAgo: number][] = [
      ['Ramesh Gupta', '9876543210', 'Mumbai', 'Diabetes Type 2', 'contacted', sneha, 12],
      ['Deepa Nambiar', '9876123450', 'Kochi', 'Hypertension', 'call_back_later', sneha, 9],
      ['Rajesh Patel', '9898765432', 'Ahmedabad', 'Thyroid', 'sold', sneha, 6],
      ['Sunita Verma', '9823456789', 'Pune', 'Diabetes Type 1', 'not_interested', vikram, 20],
      ['Suresh Rao', '9765432109', 'Bengaluru', 'Cholesterol', 'new', vikram, 3],
      ['Anil Kumar', '9812345670', 'Delhi', 'Asthma', 'interested', ananya, 8],
      ['Kiran Shetty', '9988776655', 'Mangaluru', 'Hypertension', 'new', ananya, 2],
      ['Meena Joshi', '9845123456', 'Nashik', 'Thyroid', 'contacted', arjun, 15],
      ['Farah Khan', '9966554433', 'Hyderabad', 'Diabetes Type 2', 'new', null as unknown as string, 1],
    ];

    for (const [customerName, mobile, city, disease, status, caller, ago] of leads) {
      const lead = await prisma.lead.create({
        data: {
          customerName, mobile, city, disease, status,
          address: `${city} main road`, state: city === 'Mumbai' ? 'Maharashtra' : 'Karnataka',
          pincode: '400001', leadSource: 'website', quantity: 1,
          medicineRequired: 'Atorvastatin',
          assignedCallerId: caller ?? null,
          createdBy: admin,
          createdAt: at(-ago),
        },
      });
      await prisma.leadMedicine.create({
        data: { leadId: lead.id, productId: atorva.id, medicineName: atorva.brandName!, days: 30 },
      });
      await prisma.leadActivity.create({
        data: { leadId: lead.id, activityType: 'created', description: `Lead created — ${disease}`, createdBy: admin, createdAt: at(-ago) },
      });
      if (caller) {
        await prisma.leadAssignment.create({ data: { leadId: lead.id, callerId: caller, assignedBy: admin, assignedAt: at(-ago) } });
      }
    }

    // Counters are the application's job now, so the seed maintains them explicitly.
    for (const id of [sneha, vikram, ananya, arjun]) {
      await prisma.user.update({
        where: { id },
        data: { assignedLeadsCount: await prisma.lead.count({ where: { assignedCallerId: id, deletedAt: null } }) },
      });
    }
    console.log(`  leads (${leads.length}) + activities + assignments`);

    // One converted customer with an order and a renewal, so the pipeline has a worked example.
    const customer = await prisma.customer.create({
      data: { fullName: 'Ramesh Gupta', primaryMobile: '9876543210', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    });
    const qty = 2;
    const line = Number(glycomet.unitPrice) * qty;
    const order = await prisma.order.create({
      data: {
        orderNumber: 'ORD-0001', customerId: customer.id, customerName: customer.fullName,
        shippingAddress: 'Mumbai main road', totalAmount: line, payableAmount: line,
        paymentStatus: 'paid', stage: 'delivered', createdBy: admin, createdAt: at(-10),
        items: {
          create: [{
            productId: glycomet.id, medicineNameSnapshot: glycomet.brandName!,
            quantity: qty, unitPriceSnapshot: glycomet.unitPrice, lineTotal: line,
          }],
        },
      },
    });
    await prisma.renewal.create({
      data: {
        customerId: customer.id, customerName: customer.fullName, orderId: order.id,
        productId: glycomet.id, medicineName: glycomet.brandName!,
        orderDate: at(-10), renewalDate: at(20), expiryDate: at(26),
        assignedCallerId: sneha, createdBy: admin,
      },
    });
    await prisma.followUp.create({
      data: {
        customerId: customer.id, customerName: customer.fullName,
        scheduledAt: at(2), type: 'call', status: 'pending', assignedCallerId: sneha, createdBy: admin,
      },
    });
    await prisma.notification.create({
      data: { recipientUserId: sneha, title: 'New Lead Assigned', message: 'A lead has been assigned to you.', type: 'info' },
    });
    console.log('  customer + order + renewal + follow-up + notification');
  }

  const counts = {
    users: await prisma.user.count(),
    products: await prisma.product.count(),
    leads: await prisma.lead.count(),
    orders: await prisma.order.count(),
    renewals: await prisma.renewal.count(),
    followUps: await prisma.followUp.count(),
  };
  console.log('done:', JSON.stringify(counts));
  console.log(`\n  admin:  aarav.sharma@medicrm.in / ${ADMIN_PASSWORD}`);
  console.log(`  caller: sneha.iyer@medicrm.in / ${CALLER_PASSWORD}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
