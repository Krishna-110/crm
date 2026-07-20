-- =====================================================================================
-- MIGRATION 001 — App ↔ Schema reconciliation
-- Target: a database already created from schema.sql (PostgreSQL 15+).
-- Run as the schema-owner / migration role (needs ALTER TABLE + CREATE FUNCTION).
-- Idempotent where practical (guards on catalog lookups); safe to re-run.
--
-- Addresses two findings from analysing the actual running CRM against the schema
-- (see db/RECONCILIATION.md): F1 phone-format rejection, F2 convert-to-order blocked.
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- F1 — Accept the phone/mobile formats the application actually produces.
--
-- The app writes display-format numbers: '+91 98201 45678', alternates like
-- '+91 22 2567 8901' / '022-24567890'. The strict identity CHECK ('^[6-9][0-9]{9}$')
-- rejected every lead/customer insert; the loose {7,15} CHECK rejected 16-char
-- formatted alternates. Fix: normalize the two identity columns to canonical 10-digit
-- (which also improves dedupe), and widen the loose patterns to {7,20}.
-- -------------------------------------------------------------------------------------

-- Canonicalize an Indian mobile number to bare 10 digits.
--   '+91 98201 45678' -> '9820145678'    (strip +91 country code)
--   '098201 45678'    -> '9820145678'    (strip trunk 0)
--   '9820145678'      -> '9820145678'    (unchanged)
-- Anything that does not reduce to a plausible 10-digit number is returned as-is so the
-- downstream CHECK still rejects genuine garbage rather than this function hiding it.
CREATE OR REPLACE FUNCTION normalize_indian_mobile(p_raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_digits text;
BEGIN
  IF p_raw IS NULL THEN RETURN NULL; END IF;
  v_digits := regexp_replace(p_raw, '\D', '', 'g');          -- keep digits only
  IF length(v_digits) = 12 AND left(v_digits, 2) = '91' THEN -- +91 country code
    v_digits := right(v_digits, 10);
  ELSIF length(v_digits) = 11 AND left(v_digits, 1) = '0' THEN -- trunk 0
    v_digits := right(v_digits, 10);
  END IF;
  RETURN v_digits;
END;
$$;

-- Trigger wrappers. Named with a numeric prefix so they fire BEFORE the existing
-- name-sorted check triggers (e.g. trg_leads_check_caller_customer_link), which compare
-- leads.mobile against customers.primary_mobile — both sides must already be normalized
-- for that equality to hold.
CREATE OR REPLACE FUNCTION normalize_customers_primary_mobile() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.primary_mobile := normalize_indian_mobile(NEW.primary_mobile);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION normalize_leads_mobile() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.mobile := normalize_indian_mobile(NEW.mobile);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_00_customers_normalize_mobile ON customers;
CREATE TRIGGER trg_00_customers_normalize_mobile
  BEFORE INSERT OR UPDATE OF primary_mobile ON customers
  FOR EACH ROW EXECUTE FUNCTION normalize_customers_primary_mobile();

DROP TRIGGER IF EXISTS trg_00_leads_normalize_mobile ON leads;
CREATE TRIGGER trg_00_leads_normalize_mobile
  BEFORE INSERT OR UPDATE OF mobile ON leads
  FOR EACH ROW EXECUTE FUNCTION normalize_leads_mobile();

-- Widen the loose patterns so formatted alternates / landlines with a country code fit.
ALTER TABLE users            DROP CONSTRAINT IF EXISTS chk_users_phone_format;
ALTER TABLE users            ADD  CONSTRAINT chk_users_phone_format
  CHECK (phone ~ '^[0-9+ ()-]{7,20}$');

ALTER TABLE customers        DROP CONSTRAINT IF EXISTS chk_customers_alternate_mobile;
ALTER TABLE customers        ADD  CONSTRAINT chk_customers_alternate_mobile
  CHECK (alternate_mobile IS NULL OR alternate_mobile ~ '^[0-9+ ()-]{7,20}$');

ALTER TABLE leads            DROP CONSTRAINT IF EXISTS chk_leads_alternate_number;
ALTER TABLE leads            ADD  CONSTRAINT chk_leads_alternate_number
  CHECK (alternate_number IS NULL OR alternate_number ~ '^[0-9+ ()-]{7,20}$');


-- -------------------------------------------------------------------------------------
-- F2 — Make the convert-lead-to-order flow executable against the schema.
-- -------------------------------------------------------------------------------------

-- An order line for a medicine not (yet) in the catalog is legitimate — the app converts
-- a lead whose medicine is free text. Keep the snapshot name/price NOT NULL so the line
-- is still meaningful; only the product_id link becomes optional.
ALTER TABLE order_items ALTER COLUMN product_id DROP NOT NULL;

-- Server-side order-number generation (replaces the app's client-side Date.now() id).
CREATE SEQUENCE IF NOT EXISTS order_number_seq;

-- Initialize the sequence past any order numbers that already exist (seed data or a
-- prior run), so generated numbers never collide with the ux_orders_order_number unique
-- index. is_called=false => the next nextval() returns exactly this value. Never moves
-- the sequence backward if it is already ahead of the data.
SELECT setval(
  'order_number_seq',
  GREATEST(
    (SELECT last_value FROM order_number_seq),
    (SELECT COALESCE(MAX(substring(order_number from '\d+$')::bigint), 0) + 1 FROM orders)
  ),
  false
);

CREATE OR REPLACE FUNCTION generate_order_number() RETURNS text
LANGUAGE sql AS $$
  SELECT 'ORD-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('order_number_seq')::text, 4, '0');
$$;

-- convert_lead_to_order — mirrors the app's handleConvertToOrder, but satisfies every
-- constraint: resolves/creates the customer, creates order + line, flips the lead to
-- 'converted', logs the activity. SECURITY DEFINER so its internal writes run with the
-- owner's rights (like set_app_session); an explicit ownership guard keeps a caller
-- from converting a lead that is not theirs, since DEFINER bypasses RLS.
CREATE OR REPLACE FUNCTION convert_lead_to_order(
  p_lead_id      uuid,
  p_unit_price   numeric DEFAULT 0        -- used only when the line has no catalog product
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lead        leads%ROWTYPE;
  v_customer_id uuid;
  v_order_id    uuid;
  v_actor       uuid := app_current_user_id();
BEGIN
  SELECT * INTO v_lead FROM leads WHERE id = p_lead_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'convert_lead_to_order: lead % not found', p_lead_id;
  END IF;

  -- Ownership guard (DEFINER bypasses RLS, so enforce the caller rule explicitly).
  IF app_current_role() = 'caller' AND v_lead.assigned_caller_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'convert_lead_to_order: caller may only convert their own lead';
  END IF;

  IF v_lead.status = 'converted' THEN
    RAISE EXCEPTION 'convert_lead_to_order: lead % is already converted', p_lead_id;
  END IF;

  -- 1. Resolve or create the customer, deduping on the normalized mobile.
  v_customer_id := v_lead.customer_id;
  IF v_customer_id IS NULL THEN
    SELECT id INTO v_customer_id
    FROM customers
    WHERE primary_mobile = normalize_indian_mobile(v_lead.mobile) AND deleted_at IS NULL;

    IF v_customer_id IS NULL THEN
      INSERT INTO customers (full_name, primary_mobile, alternate_mobile,
                             address, city, state, pincode, doctor_name, created_by)
      VALUES (v_lead.customer_name, v_lead.mobile, v_lead.alternate_number,
              v_lead.address, v_lead.city, v_lead.state, v_lead.pincode,
              v_lead.doctor_name, v_actor)
      RETURNING id INTO v_customer_id;
    END IF;

    UPDATE leads SET customer_id = v_customer_id WHERE id = p_lead_id;
  END IF;

  -- 2. Create the order (customer_name/shipping_address are point-in-time snapshots;
  --    the customer_name trigger will keep it in sync with the canonical record).
  INSERT INTO orders (order_number, customer_id, lead_id, customer_name,
                      shipping_address, stage, payment_status, created_by)
  VALUES (generate_order_number(), v_customer_id, p_lead_id,
          (SELECT full_name FROM customers WHERE id = v_customer_id),
          concat_ws(', ', v_lead.address, v_lead.city, v_lead.state, v_lead.pincode),
          'confirmed', 'pending', v_actor)
  RETURNING id INTO v_order_id;

  -- 3. Create the order line — catalog product if the lead had one, else uncatalogued
  --    (free-text snapshot). Prefer the catalog price over the app's placeholder 0.
  INSERT INTO order_items (order_id, product_id, medicine_name_snapshot,
                           quantity, unit_price_snapshot)
  VALUES (v_order_id, v_lead.requested_product_id, v_lead.medicine_required, v_lead.quantity,
          COALESCE((SELECT unit_price FROM products WHERE id = v_lead.requested_product_id),
                   p_unit_price));

  -- 4. Flip the lead to converted and log the activity (matches the app's timeline entry).
  UPDATE leads SET status = 'converted', updated_by = v_actor WHERE id = p_lead_id;
  INSERT INTO lead_activities (lead_id, activity_type, description, created_by)
  VALUES (p_lead_id, 'status_change',
          'Lead converted to order ' || (SELECT order_number FROM orders WHERE id = v_order_id),
          v_actor);

  RETURN v_order_id;
END;
$$;

COMMENT ON FUNCTION convert_lead_to_order IS
  'Atomic lead->order conversion mirroring the frontend handleConvertToOrder, satisfying all schema constraints (customer resolve/create, uncatalogued line support, server-generated order number). Caller-ownership enforced explicitly since SECURITY DEFINER bypasses RLS.';

GRANT EXECUTE ON FUNCTION convert_lead_to_order(uuid, numeric) TO app_user;
GRANT EXECUTE ON FUNCTION generate_order_number() TO app_user;
GRANT EXECUTE ON FUNCTION normalize_indian_mobile(text) TO app_user;

COMMIT;
