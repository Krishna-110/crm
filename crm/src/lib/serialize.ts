import { Prisma } from '@prisma/client';
import { APP_TIMEZONE, daysRemaining, renewalStatus } from './dates.js';

/**
 * Database rows to API responses.
 *
 * The API shape is fixed by the existing frontend and must not drift — these functions are
 * the contract. They are thinner than their predecessors because the models are already
 * camelCase, so most fields pass straight through; what remains is genuine translation:
 * dates to display strings, Decimals to numbers, and the few names where the API word
 * differs from the column (`assignedCaller`, `name` for a product's brand).
 */

const dateOnly = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD in IST, or '' — the frontend renders empty for a missing date. */
const d10 = (d: Date | null | undefined): string => (d ? dateOnly.format(d) : '');

/** Decimal columns arrive as Prisma.Decimal; the API sends plain numbers. */
const num = (v: Prisma.Decimal | number | null | undefined): number => (v == null ? 0 : Number(v));

type User = {
  id: string; name: string; employeeId: string; phone: string; email: string;
  role: string; status: string; assignedLeadsCount: number;
  lastLoginAt: Date | null; avatarUrl: string | null;
};

export const serializeUser = (u: User) => ({
  id: u.id,
  name: u.name,
  employeeId: u.employeeId,
  phone: u.phone,
  email: u.email,
  role: u.role,
  status: u.status,
  assignedLeads: u.assignedLeadsCount,
  lastLogin: d10(u.lastLoginAt),
  avatar: u.avatarUrl ?? undefined,
});

type LeadMedicine = { id: string; medicineName: string; days: number };
export const serializeLeadMedicine = (m: LeadMedicine) => ({
  id: m.id,
  name: m.medicineName,
  days: m.days,
});

type LeadActivity = {
  id: string; leadId: string; activityType: string; description: string;
  createdAt: Date; createdBy: string | null;
};
export const serializeLeadActivity = (a: LeadActivity) => ({
  id: a.id,
  leadId: a.leadId,
  type: a.activityType,
  description: a.description,
  createdAt: a.createdAt.toISOString(),
  createdBy: a.createdBy,
});

type Lead = {
  id: string; customerName: string; mobile: string; alternateNumber: string | null;
  address: string; city: string; state: string; pincode: string;
  doctorName: string | null; disease: string; assignedCallerId: string | null;
  leadSource: string; status: string; createdAt: Date;
  lastFollowUpAt: Date | null; nextFollowUpAt: Date | null;
  notes: string | null; paymentScreenshot: string | null;
  medicines?: LeadMedicine[]; activities?: LeadActivity[];
};

export const serializeLead = (l: Lead) => ({
  id: l.id,
  customerName: l.customerName,
  mobile: l.mobile,
  alternateNumber: l.alternateNumber ?? undefined,
  address: l.address,
  city: l.city,
  state: l.state,
  pincode: l.pincode,
  medicines: (l.medicines ?? []).map(serializeLeadMedicine),
  doctorName: l.doctorName ?? undefined,
  disease: l.disease ?? undefined,
  assignedCaller: l.assignedCallerId ?? undefined,
  leadSource: l.leadSource,
  status: l.status,
  createdDate: d10(l.createdAt),
  lastFollowUp: d10(l.lastFollowUpAt),
  nextFollowUp: d10(l.nextFollowUpAt),
  notes: l.notes ?? undefined,
  paymentScreenshot: l.paymentScreenshot ?? undefined,
  activities: (l.activities ?? []).map(serializeLeadActivity),
});

type Product = {
  id: string; brandName: string | null; genericName: string; dosageForm: string | null;
  unitPrice: Prisma.Decimal; stockQuantity: number; isActive: boolean; createdAt: Date;
};
/** The API calls a product a "medicine", and its brand name is the display name. */
export const serializeMedicine = (p: Product) => ({
  id: p.id,
  name: p.brandName ?? p.genericName,
  genericName: p.genericName ?? undefined,
  dosageForm: p.dosageForm ?? undefined,
  unitPrice: num(p.unitPrice),
  stockQuantity: p.stockQuantity,
  isActive: p.isActive,
  createdDate: d10(p.createdAt),
});

type OrderItem = { medicineNameSnapshot: string; quantity: number; unitPriceSnapshot: Prisma.Decimal };
export const serializeOrderItem = (i: OrderItem) => ({
  name: i.medicineNameSnapshot,
  quantity: i.quantity,
  price: num(i.unitPriceSnapshot),
});

type Order = {
  id: string; orderNumber: string; leadId: string | null; customerName: string;
  shippingAddress: string; totalAmount: Prisma.Decimal; discountType: string;
  discountValue: Prisma.Decimal; payableAmount: Prisma.Decimal; paymentStatus: string;
  stage: string; createdAt: Date; updatedAt: Date; items?: OrderItem[];
};
export const serializeOrder = (o: Order) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  leadId: o.leadId,
  customerName: o.customerName,
  address: o.shippingAddress,
  medicines: (o.items ?? []).map(serializeOrderItem),
  totalAmount: num(o.totalAmount),
  discountType: o.discountType,
  discountValue: num(o.discountValue),
  payableAmount: num(o.payableAmount),
  paymentStatus: o.paymentStatus,
  stage: o.stage,
  createdDate: d10(o.createdAt),
  updatedDate: d10(o.updatedAt),
});

type Renewal = {
  id: string; customerId: string; customerName: string; medicineName: string;
  orderDate: Date; renewalDate: Date; expiryDate: Date;
  assignedCallerId: string | null; renewedAt: Date | null;
};
/**
 * `daysRemaining` and `status` are derived, not stored — see lib/dates.ts. Storing them
 * would need a nightly job and would be wrong for a day whenever that job failed.
 */
export const serializeRenewal = (r: Renewal) => ({
  id: r.id,
  customerId: r.customerId,
  customerName: r.customerName,
  medicineName: r.medicineName,
  orderDate: d10(r.orderDate),
  renewalDate: d10(r.renewalDate),
  expiryDate: d10(r.expiryDate),
  daysRemaining: daysRemaining(r.expiryDate),
  assignedCaller: r.assignedCallerId ?? undefined,
  status: renewalStatus(r.renewalDate, r.expiryDate, r.renewedAt),
});

type FollowUp = {
  id: string; leadId: string | null; customerName: string; scheduledAt: Date;
  type: string; status: string; notes: string | null;
};
export const serializeFollowUp = (f: FollowUp) => ({
  id: f.id,
  leadId: f.leadId ?? undefined,
  customerName: f.customerName,
  scheduledDate: d10(f.scheduledAt),
  type: f.type,
  status: f.status,
  notes: f.notes ?? undefined,
});

type Notification = {
  id: string; title: string; message: string; type: string; isRead: boolean; createdAt: Date;
};
export const serializeNotification = (n: Notification) => ({
  id: n.id,
  title: n.title,
  message: n.message,
  type: n.type,
  read: n.isRead,
  createdAt: n.createdAt.toISOString(),
});
