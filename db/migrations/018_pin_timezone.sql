-- 018_pin_timezone.sql
--
-- Pins the database's session timezone to Asia/Kolkata.
--
-- WHY
-- ---
-- A surprising amount of this app's user-visible arithmetic is evaluated in whatever
-- timezone the PostgreSQL *server* happens to be configured with:
--
--   * compute_renewal_status()      (schema.sql) -- `p_expiry_date::date < CURRENT_DATE`
--   * renewals_view.days_remaining  (schema.sql) -- `expiry_date::date - CURRENT_DATE`
--   * the dashboard's period boundaries (server/src/routes/misc.ts) -- CURRENT_DATE and
--     date_trunc('week'|'month', CURRENT_DATE)
--
-- None of those say which timezone they mean. They inherit it from postgresql.conf, which
-- defaults to the host OS. On the development machine that is IST, so everything agreed and
-- the dependency was invisible. On a UTC host — which is the default for most CI runners and
-- cloud databases — CURRENT_DATE is a different calendar day for the first 5.5 hours of
-- every IST day.
--
-- That matters because server/src/serializers.ts derives the SAME values in TypeScript and
-- is explicitly IST (Intl with timeZone: 'Asia/Kolkata'), since Prisma 7 cannot read
-- renewals_view usefully. So on a UTC host the SQL and the TypeScript would disagree about
-- what "today" is: a renewal could read `overdue` in one place and `due_today` in the other,
-- and the dashboard's "today" bucket would cover a different day from the renewals list.
-- Nothing would error. The numbers would just quietly be wrong.
--
-- Setting it on the database rather than in the connection string means every consumer gets
-- it — Prisma, maintPool, the scheduler, psql, and any future service — instead of each one
-- having to remember.
--
-- Applies to NEW sessions; existing connections keep their current setting until they
-- reconnect. Uses current_database() so the same migration works for medcrm and medcrm_test.
--
-- CAVEAT when applying to an EXISTING database that was built under a different timezone.
-- ensure_monthly_partition() derives its month boundaries from date_trunc('month', ...) on a
-- timestamptz, so the month a given instant falls into depends on the session timezone.
-- Changing the timezone of a database whose partitions were created under the old one can
-- therefore produce an overlap the next time a partition is created:
--
--   ERROR: partition "lead_activities_2026_04" would overlap partition "lead_activities_2026_05"
--
-- This was reproduced deliberately by flipping this migration to UTC mid-build. A fresh
-- install is unaffected, because every partition is then created under one consistent
-- timezone. If you hit it on an existing database, the fix is to drop and recreate the
-- affected empty future partitions under the new timezone — check pg_class/pg_inherits for
-- the actual bounds before doing so.

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone = %L', current_database(), 'Asia/Kolkata');
END $$;

-- Verify on a fresh session with:  SHOW timezone;   -- expect Asia/Kolkata
