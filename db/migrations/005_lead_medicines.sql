-- =====================================================================================
-- MIGRATION 005 — lead_medicines (multi-medicine leads) + supporting fixes
-- Target: medcrm database after migrations 001-004.
-- Run as the schema-owner / migration role (needs ALTER TABLE + CREATE TABLE + CREATE FUNCTION).
--
-- Addresses the frontend/schema contract gap found while building the Node backend:
-- Lead.medicines is a {id,name,days}[] array in the app, but leads still only carries a
-- single medicine_required/quantity pair. This migration adds a proper child table,
-- backfills it from the legacy columns, relaxes the legacy columns to optional, and
-- rewrites convert_lead_to_order() to emit one order line per requested medicine.
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 1. lead_medicines — one row per medicine requested on a lead.
-- -------------------------------------------------------------------------------------
CREATE TABLE lead_medicines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  product_id     uuid NULL REFERENCES products(id) ON DELETE SET NULL,
  medicine_name  text NOT NULL,
  days           integer NOT NULL CHECK (days > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lead_medicines IS 'Child table for Lead.medicines ({id,name,days}[] in the frontend). product_id is a best-effort catalog match resolved by the app; NULL means free-text/uncatalogued.';

CREATE INDEX ix_lead_medicines_lead_id ON lead_medicines (lead_id);

CREATE TRIGGER trg_lead_medicines_set_updated_at
  BEFORE UPDATE ON lead_medicines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---- RLS: visibility/writes inherited via parent lead, same shape as lead_activities ----
ALTER TABLE lead_medicines ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_medicines FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_medicines_select ON lead_medicines FOR SELECT
USING (
  is_admin_or_above()
  OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_medicines.lead_id AND l.assigned_caller_id = app_current_user_id())
);

CREATE POLICY lead_medicines_insert ON lead_medicines FOR INSERT
WITH CHECK (
  is_admin_or_above()
  OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_medicines.lead_id AND l.assigned_caller_id = app_current_user_id())
);

CREATE POLICY lead_medicines_update ON lead_medicines FOR UPDATE
USING (
  is_admin_or_above()
  OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_medicines.lead_id AND l.assigned_caller_id = app_current_user_id())
)
WITH CHECK (
  is_admin_or_above()
  OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_medicines.lead_id AND l.assigned_caller_id = app_current_user_id())
);

CREATE POLICY lead_medicines_delete ON lead_medicines FOR DELETE
USING (
  is_admin_or_above()
  OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_medicines.lead_id AND l.assigned_caller_id = app_current_user_id())
);

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_medicines TO app_user;

-- -------------------------------------------------------------------------------------
-- 2. Backfill — one lead_medicines row per existing lead from the legacy columns.
--    NOT EXISTS guard makes this idempotent (safe to re-run after a partial failure).
-- -------------------------------------------------------------------------------------
INSERT INTO lead_medicines (lead_id, product_id, medicine_name, days)
SELECT l.id, l.requested_product_id, l.medicine_required, GREATEST(COALESCE(l.quantity, 1), 1)
FROM leads l
WHERE NOT EXISTS (SELECT 1 FROM lead_medicines lm WHERE lm.lead_id = l.id);

-- -------------------------------------------------------------------------------------
-- 3. Legacy columns become optional — lead_medicines is now the source of truth.
--    leads.search_vector's coalesce(medicine_required,'') already tolerates NULL; the
--    app keeps writing a comma-joined summary into medicine_required so full-text search
--    still matches on medicine name.
-- -------------------------------------------------------------------------------------
ALTER TABLE leads ALTER COLUMN medicine_required DROP NOT NULL;
ALTER TABLE leads ALTER COLUMN quantity DROP NOT NULL;

-- -------------------------------------------------------------------------------------
-- 4. convert_lead_to_order — replace the single-line-item version (migration 001) with
--    one that loops over lead_medicines. Falls back to the legacy columns for any lead
--    that somehow has zero child rows (shouldn't happen post-backfill, but the function
--    should never silently create a zero-line order).
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION convert_lead_to_order(
  p_lead_id      uuid,
  p_unit_price   numeric DEFAULT 0        -- used only when a line has no catalog product
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lead        leads%ROWTYPE;
  v_customer_id uuid;
  v_order_id    uuid;
  v_actor       uuid := app_current_user_id();
  v_medicine    lead_medicines%ROWTYPE;
  v_line_count  integer := 0;
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

  -- 3. One order line per requested medicine. quantity is a placeholder 1 per line
  --    (lead_medicines.days is a course duration, not a unit count — the schema has no
  --    per-medicine unit quantity yet). Catalog price wins over the app's placeholder.
  FOR v_medicine IN SELECT * FROM lead_medicines WHERE lead_id = p_lead_id ORDER BY created_at LOOP
    INSERT INTO order_items (order_id, product_id, medicine_name_snapshot,
                             quantity, unit_price_snapshot)
    VALUES (v_order_id, v_medicine.product_id, v_medicine.medicine_name, 1,
            COALESCE((SELECT unit_price FROM products WHERE id = v_medicine.product_id),
                     p_unit_price));
    v_line_count := v_line_count + 1;
  END LOOP;

  -- Fallback for a lead with no lead_medicines rows (pre-migration data that somehow
  -- missed the backfill, or a row inserted directly against the legacy columns).
  IF v_line_count = 0 THEN
    IF v_lead.medicine_required IS NULL THEN
      RAISE EXCEPTION 'convert_lead_to_order: lead % has no medicines to convert', p_lead_id;
    END IF;
    INSERT INTO order_items (order_id, product_id, medicine_name_snapshot,
                             quantity, unit_price_snapshot)
    VALUES (v_order_id, v_lead.requested_product_id, v_lead.medicine_required,
            GREATEST(COALESCE(v_lead.quantity, 1), 1),
            COALESCE((SELECT unit_price FROM products WHERE id = v_lead.requested_product_id),
                     p_unit_price));
  END IF;

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
  'Atomic lead->order conversion mirroring the frontend handleConvertToOrder: one order_items row per lead_medicines row (falls back to the legacy medicine_required/quantity columns if a lead somehow has none), customer resolve/create, server-generated order number. Caller-ownership enforced explicitly since SECURITY DEFINER bypasses RLS.';

-- CREATE OR REPLACE preserves the GRANT EXECUTE already issued in migration 001.

-- -------------------------------------------------------------------------------------
-- 5. renewals_update — was admin-only; the caller "mark renewed" workflow needs the
--    assigned caller to update their own renewal too.
-- -------------------------------------------------------------------------------------
DROP POLICY IF EXISTS renewals_update ON renewals;
CREATE POLICY renewals_update ON renewals FOR UPDATE
USING (is_admin_or_above() OR assigned_caller_id = app_current_user_id())
WITH CHECK (is_admin_or_above() OR assigned_caller_id = app_current_user_id());

-- -------------------------------------------------------------------------------------
-- 6. Server-generated medicine SKUs — the frontend Medicine type has no sku field, so
--    the backend synthesizes one (MED-NNNNN) on product creation.
-- -------------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS product_sku_seq;

COMMIT;
