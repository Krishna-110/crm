-- =====================================================================================
-- MIGRATION 014 — convert_lead_to_order sets payment_status to 'paid' when lead is sold
-- =====================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION convert_lead_to_order(
  p_lead_id      uuid,
  p_unit_price   numeric DEFAULT 0
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lead           leads%ROWTYPE;
  v_customer_id    uuid;
  v_order_id       uuid;
  v_actor          uuid := app_current_user_id();
  v_medicine       lead_medicines%ROWTYPE;
  v_line_count     integer := 0;
  v_payment_status text := 'pending';
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

  -- Set payment_status to 'paid' if the lead was marked 'sold' with a payment screenshot
  IF v_lead.status = 'sold' AND v_lead.payment_screenshot IS NOT NULL AND trim(v_lead.payment_screenshot) <> '' THEN
    v_payment_status := 'paid';
  END IF;

  -- 2. Create the order
  INSERT INTO orders (order_number, customer_id, lead_id, customer_name,
                      shipping_address, stage, payment_status, created_by)
  VALUES (generate_order_number(), v_customer_id, p_lead_id,
          (SELECT full_name FROM customers WHERE id = v_customer_id),
          concat_ws(', ', v_lead.address, v_lead.city, v_lead.state, v_lead.pincode),
          'confirmed', v_payment_status, v_actor)
  RETURNING id INTO v_order_id;

  -- 3. One order line per requested medicine.
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

  -- Fallback for a lead with no lead_medicines rows
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

  -- 4. Flip the lead to converted and log the activity
  UPDATE leads SET status = 'converted', updated_by = v_actor WHERE id = p_lead_id;
  INSERT INTO lead_activities (lead_id, activity_type, description, created_by)
  VALUES (p_lead_id, 'status_change',
          'Lead converted to order ' || (SELECT order_number FROM orders WHERE id = v_order_id),
          v_actor);

  RETURN v_order_id;
END;
$$;

COMMIT;
