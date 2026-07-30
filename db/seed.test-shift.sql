-- seed.test-shift.sql
--
-- Makes the seed fixture TIME-INVARIANT by sliding every timestamp forward so that the
-- data sits the same distance from "today" no matter when the tests run.
--
-- WHY
-- ---
-- db/seed.sql uses absolute 2026 dates, but renewal status, follow-up status and every
-- dashboard period bucket derive from now(). Left alone, assertions rot on a calendar:
-- "leads created this month" reads 9 on 2026-07-31 and 0 on 2026-08-01, and renewal
-- statuses flip as expiry dates pass. Shifting by (CURRENT_DATE - anchor) keeps the whole
-- fixture's SHAPE fixed — 3 overdue renewals stay 3 overdue, forever.
--
-- This runs against the TEST database only. It deliberately does not fork seed.sql:
-- one seed stays the single source of truth, and this slides it.

-- The anchor below ('2026-07-31') is the date db/seed.sql was authored against; every
-- literal in that file is relative to it. Change both together or the shape shifts.
DO $$
DECLARE
  v_offset int := CURRENT_DATE - DATE '2026-07-31';
  v_month  date;
  r        record;
  v_sets   text;
BEGIN
  IF v_offset = 0 THEN
    RAISE NOTICE 'seed shift: offset is 0 days, nothing to do';
    RETURN;
  END IF;

  -- Partition key columns are being moved, so the destination partitions must already
  -- exist. Postgres supports cross-partition UPDATE row movement, but not into a range
  -- that has no partition. Cover a generous window around the shifted data.
  FOR i IN -36..12 LOOP
    v_month := date_trunc('month', CURRENT_DATE + make_interval(months => i))::date;
    PERFORM ensure_monthly_partition('lead_activities', v_month);
    PERFORM ensure_monthly_partition('notifications', v_month);
    PERFORM ensure_monthly_partition('audit_log', v_month);
  END LOOP;

  -- Triggers must not fire: several tables have a BEFORE UPDATE trigger that stamps
  -- updated_at = now(), which would immediately undo the shift for that column. Replica
  -- mode also suspends FK checks, which keeps the per-table order from mattering.
  SET session_replication_role = replica;

  -- Columns come from the catalog rather than a hardcoded list so this keeps working as
  -- the schema changes. Partition CHILDREN are excluded (pg_inherits): rows are reachable
  -- through the parent, and updating both would shift them twice.
  FOR r IN
    SELECT c.relname AS table_name,
           array_agg(a.attname ORDER BY a.attnum) AS cols
    FROM pg_class c
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid
    JOIN pg_type t       ON t.oid = a.atttypid
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attgenerated = ''                      -- skip GENERATED ALWAYS (search_vector)
      AND t.typname IN ('timestamptz', 'timestamp', 'date')
      AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
    GROUP BY c.relname
  LOOP
    -- One UPDATE per table setting every timestamp column at once.
    SELECT string_agg(format('%I = %I + make_interval(days => %s)', col, col, v_offset), ', ')
      INTO v_sets
      FROM unnest(r.cols) AS col;

    EXECUTE format('UPDATE %I SET %s', r.table_name, v_sets);
  END LOOP;

  SET session_replication_role = DEFAULT;

  RAISE NOTICE 'seed shift: moved all timestamps by % days', v_offset;
END $$;
