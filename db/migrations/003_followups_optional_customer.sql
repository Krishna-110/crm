-- =====================================================================================
-- MIGRATION 003 — Allow follow-ups on leads that are not customers yet
-- Target: a database already created from schema.sql + migrations/001 (PostgreSQL 15+).
-- Run as the schema-owner / migration role.
--
-- WHY: a caller should be able to schedule a follow-up on a fresh, unmatched lead before
-- it has been promoted to a customer record. Previously follow_ups.customer_id was
-- NOT NULL, forcing a customer to exist first. This makes it optional.
--
-- Safe with the existing safeguards, verified against the schema:
--   * RLS (follow_ups_select/insert/update) keys on assigned_caller_id, not customer_id —
--     visibility/ownership is unaffected by a null customer_id.
--   * check_followup_customer_consistency() already tolerates the null case: it only
--     raises when the linked lead/renewal HAS a customer_id that DIFFERS from the
--     follow-up's. Null follow-up customer_id + null lead customer_id (the "not a
--     customer yet" case) passes cleanly.
--   * customer_name stays NOT NULL — the app supplies the lead's captured customer_name,
--     exactly as it already does for the FollowUp record.
-- =====================================================================================

BEGIN;

ALTER TABLE follow_ups ALTER COLUMN customer_id DROP NOT NULL;

COMMENT ON COLUMN follow_ups.customer_id IS
  'Optional. Null when the follow-up is on a lead not yet matched to a customer. When set, must agree with the linked lead/renewal customer (check_followup_customer_consistency).';

COMMIT;
