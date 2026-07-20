\set ON_ERROR_STOP on

\echo '=== F1a: customer insert with app format "+91 98201 45678" now succeeds + normalizes ==='
INSERT INTO customers (full_name, primary_mobile) VALUES ('App Format Cust','+91 98201 45678')
RETURNING full_name, primary_mobile;

\echo '=== F1b: lead insert with app format mobile + 16-char formatted alternate now succeeds ==='
INSERT INTO leads (customer_name, mobile, alternate_number, address, city, state, pincode, medicine_required, quantity)
VALUES ('App Format Lead','+91 98765 43210','+91 22 2567 8901','12 Test Rd','Mumbai','Maharashtra','400050','Metformin 500mg',30)
RETURNING customer_name, mobile, alternate_number;

\echo '=== F1c: dedupe — the normalized form of "+91 98201 45678" collides with bare "9820145678" ==='
-- (unique index on primary_mobile) — this insert MUST fail with a unique violation, proving dedupe works
DO $$
BEGIN
  INSERT INTO customers (full_name, primary_mobile) VALUES ('Dup Attempt','9820145678');
  RAISE EXCEPTION 'DEDUP BROKEN: bare 9820145678 did not collide with normalized +91 98201 45678';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'Dedup works: bare form collided with the normalized +91 form (unique_violation)';
END $$;

\echo '=== F2: convert an unmatched lead (no customer_id, free-text medicine) to an order ==='
-- Pick a real un-converted, customer-less lead from the seed (LEAD ...009 Kiran Shetty, customer_id NULL)
SELECT set_app_session('10000000-0000-0000-0000-000000000001');  -- admin (top role), to bypass caller ownership
SELECT
  (SELECT count(*) FROM orders) AS orders_before,
  (SELECT customer_id FROM leads WHERE id = '40000000-0000-0000-0000-000000000009') AS lead_customer_before,
  (SELECT status::text FROM leads WHERE id = '40000000-0000-0000-0000-000000000009') AS lead_status_before;

SELECT convert_lead_to_order('40000000-0000-0000-0000-000000000009') AS new_order_id;

\echo '=== F2 verify: order created, customer materialized, lead flipped, line + total present ==='
SELECT
  (SELECT count(*) FROM orders) AS orders_after,
  (SELECT customer_id IS NOT NULL FROM leads WHERE id = '40000000-0000-0000-0000-000000000009') AS lead_now_has_customer,
  (SELECT status::text FROM leads WHERE id = '40000000-0000-0000-0000-000000000009') AS lead_status_after;

SELECT o.order_number, o.customer_name, o.stage::text, o.total_amount,
       oi.medicine_name_snapshot, oi.product_id IS NULL AS uncatalogued_line, oi.quantity
FROM orders o JOIN order_items oi ON oi.order_id = o.id
WHERE o.lead_id = '40000000-0000-0000-0000-000000000009';

\echo '=== F2 activity logged? ==='
SELECT activity_type::text, description
FROM lead_activities
WHERE lead_id = '40000000-0000-0000-0000-000000000009' AND activity_type = 'status_change'
ORDER BY created_at DESC LIMIT 1;
