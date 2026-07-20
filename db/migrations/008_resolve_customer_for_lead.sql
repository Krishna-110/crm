-- =====================================================================================
-- MIGRATION 008 — resolve_or_create_customer_for_lead
-- Target: medcrm database after migrations 001-007.
-- Run as the schema-owner / migration role.
--
-- follow_ups.customer_id is NOT NULL, but a lead's customer_id is only ever populated
-- by convert_lead_to_order() — most follow-ups happen BEFORE conversion (a "call back
-- tomorrow" reminder from a sales call), so the follow-ups endpoint needs the same
-- resolve-or-create-by-normalized-mobile logic convert_lead_to_order already has
-- inlined, exposed as its own callable step rather than duplicated in application code.
-- =====================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION resolve_or_create_customer_for_lead(p_lead_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lead        leads%ROWTYPE;
  v_customer_id uuid;
  v_actor       uuid := app_current_user_id();
BEGIN
  SELECT * INTO v_lead FROM leads WHERE id = p_lead_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_or_create_customer_for_lead: lead % not found', p_lead_id;
  END IF;

  IF app_current_role() = 'caller' AND v_lead.assigned_caller_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'resolve_or_create_customer_for_lead: caller may only act on their own lead';
  END IF;

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

  RETURN v_customer_id;
END;
$$;

COMMENT ON FUNCTION resolve_or_create_customer_for_lead IS
  'Shared resolve-or-create-customer step (same logic as the first half of convert_lead_to_order) for any endpoint that needs a customer_id for a lead that may not be converted yet, e.g. scheduling a follow-up. Caller-ownership enforced explicitly since SECURITY DEFINER bypasses RLS.';

REVOKE ALL ON FUNCTION resolve_or_create_customer_for_lead(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_or_create_customer_for_lead(uuid) TO app_user;

COMMIT;
