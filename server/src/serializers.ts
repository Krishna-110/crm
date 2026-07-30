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

// Expects a row from renewals_view (adds days_remaining/status over the base table).
export function serializeRenewal(row: Row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    medicineName: row.medicine_name,
    orderDate: d10(row.order_date),
    renewalDate: d10(row.renewal_date),
    expiryDate: d10(row.expiry_date),
    daysRemaining: Number(row.days_remaining),
    assignedCaller: row.assigned_caller_id ?? undefined,
    status: row.status,
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
