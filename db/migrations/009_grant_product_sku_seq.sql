-- =====================================================================================
-- MIGRATION 009 — grant app_user USAGE on product_sku_seq
-- Target: medcrm database after migrations 001-008.
-- Run as the schema-owner / migration role.
--
-- Found via browser E2E testing: POST /api/medicines as admin failed with "permission
-- denied for sequence product_sku_seq". Migration 005 created the sequence but never
-- granted it — unlike tables, creating a sequence does not extend any existing table
-- GRANT to cover it, and nextval()/currval() require their own explicit USAGE grant.
-- The earlier PowerShell verification suite never caught this because it only
-- exercised the caller's 403 (correctly blocked by RLS) and never a successful
-- admin-authored creation, so this bug was masked until the real medicines-catalog
-- flow was tried in the browser.
-- =====================================================================================

BEGIN;

GRANT USAGE ON SEQUENCE product_sku_seq TO app_user;

COMMIT;
