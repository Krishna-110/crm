\set ON_ERROR_STOP on

\echo '=== The 7 business enums are gone; 6 system enums remain ==='
SELECT typname FROM pg_type
WHERE typtype = 'e'
  AND typname IN ('lead_status','lead_priority','lead_source','order_stage','payment_status',
                  'follow_up_type','follow_up_status','user_role','user_status','lead_activity_type',
                  'notification_type','notification_entity_type','audit_action','renewal_status')
ORDER BY typname;

\echo '=== Lookup tables populated (expect 9/4/7/6/4/3/3) ==='
SELECT 'lead_statuses' t, count(*) FROM lead_statuses
UNION ALL SELECT 'lead_priorities', count(*) FROM lead_priorities
UNION ALL SELECT 'lead_sources', count(*) FROM lead_sources
UNION ALL SELECT 'order_stages', count(*) FROM order_stages
UNION ALL SELECT 'payment_statuses', count(*) FROM payment_statuses
UNION ALL SELECT 'follow_up_types', count(*) FROM follow_up_types
UNION ALL SELECT 'follow_up_statuses', count(*) FROM follow_up_statuses
ORDER BY 1;

\echo '=== Existing lead data still valid + FK-linked (join lookups) ==='
SELECT l.status, ls.label AS status_label, l.priority, lp.label AS priority_label
FROM leads l
JOIN lead_statuses ls ON ls.code = l.status
JOIN lead_priorities lp ON lp.code = l.priority
LIMIT 3;

\echo '=== ADD a new status at runtime (no deploy), then use it on a lead — should succeed ==='
INSERT INTO lead_statuses (code, label, sort_order) VALUES ('quotation_sent','Quotation Sent',10);
UPDATE leads SET status = 'quotation_sent' WHERE id = '40000000-0000-0000-0000-000000000005'
RETURNING id, status;

\echo '=== A bogus status is now rejected by the FK (was previously an enum error) ==='
DO $$
BEGIN
  UPDATE leads SET status = 'banana' WHERE id = '40000000-0000-0000-0000-000000000005';
  RAISE EXCEPTION 'BUG: bogus status was accepted';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'Correctly rejected bogus status via FK (foreign_key_violation)';
END $$;

\echo '=== RETIRE a status (is_active=false) — existing rows keep working, code preserved ==='
UPDATE lead_sources SET is_active = false WHERE code = 'advertisement';
SELECT count(*) AS leads_still_on_retired_source FROM leads WHERE lead_source = 'advertisement';

\echo '=== F(003): schedule a follow-up on an UNMATCHED lead (no customer_id) — should succeed ==='
-- LEAD ...009 (Kiran Shetty) has customer_id = NULL in the seed
INSERT INTO follow_ups (customer_id, customer_name, lead_id, assigned_caller_id, scheduled_at, type, status, notes)
VALUES (NULL, 'Kiran Shetty', '40000000-0000-0000-0000-000000000009',
        '10000000-0000-0000-0000-000000000006', now() + interval '2 days', 'call', 'pending',
        'Follow-up on a lead not yet promoted to a customer')
RETURNING id, customer_id, lead_id, type, status;
