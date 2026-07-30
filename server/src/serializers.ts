// Maps DB rows (snake_case, pg-typed) to the exact camelCase shapes in src/types/index.ts.
// node-postgres returns timestamptz as Date and numeric as string by default; every
// timestamp in the frontend contract is a YYYY-MM-DD date string (d10) except
// LeadActivity.createdAt / Notification.createdAt, which keep full ISO precision (iso).

type Row = Record<string, any>;

// The DB session (and this app's business domain) runs in Asia/Kolkata. A plain
// UTC-based toISOString().slice(0,10) would shift the calendar date backward for any
// instant between 00:00-05:29 IST (e.g. midnight IST on 2026-07-20 is 18:30 UTC on
// 2026-07-19) — this formats using IST wall-clock so the date always matches what the
// row meant when it was written.
const APP_TIMEZONE = 'Asia/Kolkata';
const dateOnlyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function d10(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return dateOnlyFormatter.format(date);
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function num(value: string | number | null | undefined): number {
  return value == null ? 0 : Number(value);
}

// Whole days between two IST calendar dates. Both sides are reduced to a YYYY-MM-DD
// wall-clock date in Asia/Kolkata first and then compared as UTC midnights, so the result
// is a pure calendar-day difference with no DST/offset drift — the same thing Postgres
// computes with `expiry_date::date - CURRENT_DATE`.
function istDayDiff(from: Date, to: Date): number {
  const a = Date.parse(`${dateOnlyFormatter.format(from)}T00:00:00Z`);
  const b = Date.parse(`${dateOnlyFormatter.format(to)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

export function serializeUser(row: Row) {
  return {
    id: row.id,
    name: row.name,
    employeeId: row.employee_id,
    phone: row.phone,
    email: row.email,
    role: row.role,
    status: row.status,
    assignedLeads: row.assigned_leads_count ?? 0,
    lastLogin: row.last_login_at ? d10(row.last_login_at) : '',
    avatar: row.avatar_url ?? undefined,
  };
}

export function serializeLeadActivity(row: Row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    type: row.activity_type,
    description: row.description,
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
  };
}

export function serializeLeadMedicine(row: Row) {
  return {
    id: row.id,
    name: row.medicine_name,
    days: row.days,
  };
}

export function serializeLead(row: Row, medicines: unknown[], activities: unknown[]) {
  return {
    id: row.id,
    customerName: row.customer_name,
    mobile: row.mobile,
    alternateNumber: row.alternate_number ?? undefined,
    address: row.address,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    medicines,
    doctorName: row.doctor_name ?? undefined,
    disease: row.disease ?? undefined,
    assignedCaller: row.assigned_caller_id ?? undefined,
    leadSource: row.lead_source,
    status: row.status,
    createdDate: d10(row.created_at),
    lastFollowUp: d10(row.last_follow_up_at),
    nextFollowUp: d10(row.next_follow_up_at),
    notes: row.notes ?? undefined,
    paymentScreenshot: row.payment_screenshot ?? undefined,
    activities,
  };
}

export function serializeMedicine(row: Row) {
  return {
    id: row.id,
    name: row.brand_name ?? row.generic_name,
    genericName: row.generic_name ?? undefined,
    dosageForm: row.dosage_form ?? undefined,
    unitPrice: num(row.unit_price),
    stockQuantity: row.stock_quantity ?? 0,
    isActive: row.is_active,
    createdDate: d10(row.created_at),
  };
}

// orders.lead_id is nullable at the schema level, but this app only ever creates
// orders via convert_lead_to_order(), so every row the app produces has one.
export function serializeOrder(row: Row, medicines: unknown[]) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    leadId: row.lead_id,
    customerName: row.customer_name,
    address: row.shipping_address,
    medicines,
    totalAmount: num(row.total_amount),
    discountType: row.discount_type,
    discountValue: num(row.discount_value),
    payableAmount: num(row.payable_amount),
    paymentStatus: row.payment_status,
    stage: row.stage,
    createdDate: d10(row.created_at),
    updatedDate: d10(row.updated_at),
  };
}

export function serializeOrderItem(row: Row) {
  return {
    name: row.medicine_name_snapshot,
    quantity: row.quantity,
    price: num(row.unit_price_snapshot),
  };
}

/**
 * Accepts either a `renewals_view` row (which supplies days_remaining/status) or a plain
 * `renewals` row, deriving those two fields when absent.
 *
 * The derivation exists because Prisma 7 refuses @id on views and Postgres reports every
 * view column as nullable, which leaves renewals_view with a bare findMany() and no
 * orderBy/where — and, more importantly, outside the reach of the scoping extension in a
 * useful way. routes/renewals.ts therefore queries the `renewals` model instead.
 *
 * This mirrors the view's own SQL exactly:
 *   days_remaining = expiry_date::date - CURRENT_DATE
 *   status         = compute_renewal_status(renewal_date, expiry_date, renewed_at)
 * with every comparison done on IST calendar dates, because CURRENT_DATE is evaluated in
 * the database session's Asia/Kolkata timezone — comparing against a UTC "today" would be
 * a day off for roughly the first six hours of every IST day.
 */
export function serializeRenewal(row: Row) {
  const now = new Date();
  const expiry = row.expiry_date instanceof Date ? row.expiry_date : row.expiry_date ? new Date(row.expiry_date) : null;
  const renewal = row.renewal_date instanceof Date ? row.renewal_date : row.renewal_date ? new Date(row.renewal_date) : null;

  const daysRemaining =
    row.days_remaining != null ? Number(row.days_remaining) : expiry ? istDayDiff(expiry, now) : 0;

  let status = row.status as string | undefined;
  if (!status) {
    if (row.renewed_at) status = 'renewed';
    else if (expiry && istDayDiff(expiry, now) < 0) status = 'overdue';
    else if (renewal && istDayDiff(renewal, now) <= 0) status = 'due_today';
    else status = 'upcoming';
  }

  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    medicineName: row.medicine_name,
    orderDate: d10(row.order_date),
    renewalDate: d10(row.renewal_date),
    expiryDate: d10(row.expiry_date),
    daysRemaining,
    assignedCaller: row.assigned_caller_id ?? undefined,
    status,
  };
}

export function serializeFollowUp(row: Row) {
  return {
    id: row.id,
    leadId: row.lead_id ?? undefined,
    customerName: row.customer_name,
    scheduledDate: d10(row.scheduled_at),
    type: row.type,
    status: row.status,
    notes: row.notes ?? undefined,
  };
}

export function serializeNotification(row: Row) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    type: row.type,
    read: row.is_read,
    createdAt: iso(row.created_at),
  };
}
