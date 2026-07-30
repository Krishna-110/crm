-- =====================================================================================
-- MIGRATION 012 — remove leads.priority, replaced by the multi-medicine picker at
-- lead creation (restored alongside the disease field added in migration 011).
-- Target: medcrm database after migrations 001-011.
--
-- NOTE: schema.sql (frozen at its original state, per this project's convention of not
-- back-editing it from later migrations) documents priority as a native lead_priority
-- enum. Migration 002 (enum_to_lookup) already converted the live column to plain text
-- with fk_leads_priority -> lead_priorities(code) before this migration ever runs, and
-- that lookup table has no other dependents (server/src/routes/misc.ts LOOKUP_TABLES
-- also needs its now-dangling leadPriorities entry removed).
--
-- priority is referenced by two indexes and by mv_lead_status_breakdown (both its
-- defining query and its unique index), so those are rebuilt without it before the
-- column itself can be dropped. The dashboard's own query already aggregates the mv
-- with `GROUP BY status` only (server/src/routes/misc.ts), ignoring the priority
-- dimension entirely, so this is a no-op for the app's actual output.
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 1. Indexes referencing priority.
-- -------------------------------------------------------------------------------------
DROP INDEX ix_leads_priority;

DROP INDEX ix_leads_open;
CREATE INDEX ix_leads_open ON leads (assigned_caller_id)
  WHERE deleted_at IS NULL AND NOT is_terminal_lead_status(status);

-- -------------------------------------------------------------------------------------
-- 2. mv_lead_status_breakdown — rebuild without priority, then populate immediately
--    (WITH NO DATA leaves it empty until refreshed; the scheduler's next CONCURRENTLY
--    refresh needs at least one prior plain REFRESH to succeed).
-- -------------------------------------------------------------------------------------
DROP MATERIALIZED VIEW mv_lead_status_breakdown;

CREATE MATERIALIZED VIEW mv_lead_status_breakdown AS
SELECT
  status,
  lead_source,
  count(*) AS lead_count,
  count(*) FILTER (WHERE next_follow_up_at IS NOT NULL AND next_follow_up_at < now()) AS overdue_follow_up_count
FROM leads
WHERE deleted_at IS NULL
GROUP BY status, lead_source
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_lead_status_breakdown ON mv_lead_status_breakdown (status, lead_source);

-- DROP + CREATE loses the object-level grant issued in schema.sql; reinstate it.
GRANT SELECT ON mv_lead_status_breakdown TO app_user;

REFRESH MATERIALIZED VIEW mv_lead_status_breakdown;

-- -------------------------------------------------------------------------------------
-- 3. Drop the column (this also drops fk_leads_priority, which lives on it), then the
--    now-unreferenced lookup table.
-- -------------------------------------------------------------------------------------
ALTER TABLE leads DROP COLUMN priority;
DROP TABLE lead_priorities;

COMMIT;
