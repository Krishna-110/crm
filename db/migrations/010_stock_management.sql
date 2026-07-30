-- =====================================================================================
-- MIGRATION 010 — stock management for products (the "Medicines" catalog becomes "Stock")
-- Target: medcrm database after migrations 001-009.
--
-- Adds a stock_quantity counter to products (the additive extension point the original
-- schema.sql comment on `products` explicitly anticipated — "can be added additively
-- whenever real inventory tracking is built"). Existing catalog rows are backfilled with
-- a starting count so the existing lead->order conversion flow keeps working with real
-- demo/seed data instead of dropping straight to zero.
--
-- convert_lead_to_order() is rewritten to deduct stock automatically per converted
-- medicine line, floored at zero (GREATEST) rather than blocking the conversion — a
-- pharmacy still fulfills and then restocks, it doesn't refuse a sale because a counter
-- is behind reality. Manual "add stock" / "set exact stock" actions are exposed by the
-- application through ordinary UPDATE statements guarded by the existing admin-only
-- products_update RLS policy — no new policy needed.
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 1. products.stock_quantity
-- -------------------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0);

COMMENT ON COLUMN products.stock_quantity IS 'Current on-hand units. Increased by admin "add stock"/"set stock" actions, decreased automatically by convert_lead_to_order() per unit converted (floored at 0, never blocks the conversion).';

-- One-time backfill so pre-existing catalog rows do not start at 0 and immediately read
-- as out-of-stock / silently no-op every future deduction. New products created after
-- this migration default to 0 unless the creator specifies an opening stock.
UPDATE products SET stock_quantity = 100 WHERE deleted_at IS NULL;

-- -------------------------------------------------------------------------------------
-- 2. convert_lead_to_order — same shape as migration 005's version, plus a stock
--    decrement alongside each order_items insert (both the per-medicine loop and the
--    legacy-column fallback).
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
  --    Stock is decremented by the same placeholder quantity, floored at 0.
  FOR v_medicine IN SELECT * FROM lead_medicines WHERE lead_id = p_lead_id ORDER BY created_at LOOP
    INSERT INTO order_items (order_id, product_id, medicine_name_snapshot,
                             quantity, unit_price_snapshot)
    VALUES (v_order_id, v_medicine.product_id, v_medicine.medicine_name, 1,
            COALESCE((SELECT unit_price FROM products WHERE id = v_medicine.product_id),
                     p_unit_price));

    IF v_medicine.product_id IS NOT NULL THEN
      UPDATE products SET stock_quantity = GREATEST(stock_quantity - 1, 0)
      WHERE id = v_medicine.product_id;
    END IF;

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

    IF v_lead.requested_product_id IS NOT NULL THEN
      UPDATE products SET stock_quantity = GREATEST(stock_quantity - GREATEST(COALESCE(v_lead.quantity, 1), 1), 0)
      WHERE id = v_lead.requested_product_id;
    END IF;
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
  'Atomic lead->order conversion mirroring the frontend handleConvertToOrder: one order_items row per lead_medicines row (falls back to the legacy medicine_required/quantity columns if a lead somehow has none), customer resolve/create, server-generated order number, automatic stock deduction per line (floored at 0). Caller-ownership enforced explicitly since SECURITY DEFINER bypasses RLS.';

-- CREATE OR REPLACE preserves the GRANT EXECUTE already issued in migration 001.

COMMIT;
