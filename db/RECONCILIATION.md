# App ↔ Database Reconciliation Analysis

Cross-checked the **actual running CRM behavior** (reducer operations, page flows, data formats)
against the designed schema. The schema was generated from the frontend *types*, but the app's
*runtime behavior* and *data formats* are the real contract. Findings below.

## Operation coverage (every dispatch the UI actually fires)

| App operation (where) | Schema support | Verdict |
|---|---|---|
| `LOGIN` (Login) | `set_app_session()` + `sessions` | ✅ |
| `LOGOUT` (TopNav) | session teardown (app-layer) | ✅ |
| `ADD_LEAD` / `UPDATE_LEAD` / `DELETE_LEAD` (Leads, LeadDetail) | `leads` (+ soft delete) | ⚠️ phone format (see F1) |
| `ADD_LEAD_ACTIVITY` ×3 (LeadDetail) | `lead_activities` | ✅ |
| `ADD_ORDER` (LeadDetail → convert) | `orders` + `order_items` | ❌ blocked (see F2) |
| `UPDATE_ORDER` ×2 (Orders → advance stage / payment) | `orders.stage` / `payment_status` | ✅ |
| `UPDATE_RENEWAL` (Renewals → renew) | `renewals.renewed_at` (derived status) | ✅ |
| `ADD_FOLLOW_UP` (Renewals → schedule reminder) | `follow_ups` (customer+lead+renewal) | ✅ (renewal always has customer) |
| `UPDATE_FOLLOW_UP` (Calendar → mark complete) | `follow_ups.status` | ✅ |
| `ADD_USER` / `UPDATE_USER` ×2 / `DELETE_USER` (Users) | `users` (+ trigger counter) | ⚠️ phone format (F1) |
| `MARK_NOTIFICATION_READ` (TopNav) | `notifications.is_read` | ✅ |
| `SET_SEARCH_QUERY` (TopNav) | `global_search` view (tsvector) | ✅ |
| Dashboard: status breakdown, caller performance | `mv_lead_status_breakdown`, `mv_caller_performance` | ✅ (fan-out bug already fixed) |

Reducer actions **never fired by any UI** (dead or backend-generated): `ASSIGN_LEAD`,
`ADD_RENEWAL`, `ADD_NOTIFICATION`. Schema supports all three; renewals/notifications are
expected to be backend-generated (on order delivery / on domain events), not user-created.

**Status: both fixes applied in `migrations/001_app_reconciliation.sql` and verified** against a
clean install (`schema.sql` → `seed.sql` → `migrations/001`) via `tests/reconciliation_test.sql` —
all assertions pass. See `README.md` for install order.

## Findings requiring DB changes

### F1 — CRITICAL: phone/mobile CHECK constraints reject the app's real data format
The app stores phone numbers in **display format**: `+91 98201 45678`, alternates like
`+91 22 2567 8901` / `022-24567890`. But:
- `chk_customers_primary_mobile` / `chk_leads_mobile` require a bare `^[6-9][0-9]{9}$` →
  **every lead & customer insert from the app is rejected** (proven by test insert).
- The "loose" patterns on `users.phone` / `*.alternate_*` cap at `{7,15}` chars → a formatted
  alternate like `+91 22 2567 8901` (16 chars) **also fails**.

**Fix applied:** a `normalize_indian_mobile()` function + BEFORE triggers canonicalize
`customers.primary_mobile` and `leads.mobile` to 10 digits (also *improves* dedupe: `+91 98201 45678`
and `9820145678` now collapse to the same identity key). Loose patterns widened `{7,15}` → `{7,20}`.

### F2 — HIGH: convert-lead-to-order can't run against the schema
The app's headline flow (`handleConvertToOrder`) builds an order with **no `customer_id`** and a
**free-text medicine line, price 0, no `product_id`**. But `orders.customer_id` and
`order_items.product_id` are `NOT NULL` → the flow fails for any lead not pre-matched to a
customer/catalogued product (which is most of them).

**Fix applied:**
- `order_items.product_id` made **nullable** (an uncatalogued line is legitimate — a snapshot
  name + price is enough; the app sells things not yet in the catalog). `medicine_name_snapshot`
  stays `NOT NULL` so a line always has a name.
- Added `convert_lead_to_order(lead_id)` — a `SECURITY DEFINER` function that atomically
  resolves-or-creates the customer (dedupe by normalized mobile), server-generates a proper
  `ORD-YYYY-NNNN` number (via sequence, replacing the client-side `Date.now()` id), creates the
  order + line, flips the lead to `converted`, and logs the activity — mirroring the app flow but
  satisfying every constraint. Includes a caller-ownership guard (a caller can only convert their
  own lead).

## Decisions — now resolved

- **ENUM → lookup tables** ✅ DONE (`migrations/002_enum_to_lookup.sql`). The 7 business-workflow
  enums (lead status/priority/source, order stage, payment status, follow-up type/status) are now
  admin-editable lookup tables keyed by `code`: add a value with an INSERT, retire with
  `is_active=false` — no deploy. FK enforces validity; RLS makes them admin-editable only (callers
  read-only). The system enums (roles, activity type, notification types, audit action) and the
  derived `renewal_status` stay native — they're code/RLS-coupled, not business taxonomies.
- **`follow_ups.customer_id`** ✅ DONE (`migrations/003_followups_optional_customer.sql`). Now
  nullable — a follow-up can be scheduled on a lead not yet matched to a customer. RLS
  (`assigned_caller_id`-based) and the consistency trigger already tolerate the null case.

## Still open (frontend work, deferred until backend setup)

- **Frontend TS types are behind the schema** — to wire the app to this DB, the frontend needs
  `customers`/`products`/`order_items` concepts, `follow_up.customer_id/renewal_id` (drop the
  `leadId` hack), and `password_hash`. That's **frontend** work — you asked to hold off until the
  backend is set up.
