-- =====================================================================================
-- MIGRATION 006 — auth bootstrap helpers
-- Target: medcrm database after migrations 001-005.
-- Run as the schema-owner / migration role (needs CREATE FUNCTION).
--
-- RLS on users/sessions default-denies every query until app.current_user_id/
-- app.current_role are set (SECTION 9) — but those GUCs are exactly what the login and
-- token-verification requests are trying to establish in the first place. These two
-- SECURITY DEFINER helpers break that chicken-and-egg problem, mirroring the existing
-- set_app_session() bootstrap pattern. Both are deliberately narrow (return only what
-- the app layer needs) and neither is left executable by PUBLIC, since Postgres grants
-- new functions to PUBLIC by default and auth_login_lookup returns password hashes.
-- =====================================================================================

BEGIN;

-- auth_login_lookup — used only by POST /api/auth/login, before any session exists.
-- Excludes inactive/deleted users at the lookup itself (not in the app layer) so a
-- wrong-password attempt and a right-password-but-inactive-account attempt are
-- indistinguishable to the caller: both simply come back NOT FOUND -> 401.
CREATE OR REPLACE FUNCTION auth_login_lookup(p_email text)
RETURNS TABLE(user_id uuid, password_hash text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, password_hash
  FROM users
  WHERE email = p_email::citext AND status = 'active' AND deleted_at IS NULL;
$$;
COMMENT ON FUNCTION auth_login_lookup IS 'SECURITY DEFINER bootstrap for POST /api/auth/login: looks up the password hash before any app.current_user_id/app.current_role session context exists. Active+non-deleted only. Never grant to PUBLIC (returns password hashes).';

-- auth_session_lookup — used by the requireAuth middleware on every authenticated
-- request, before set_app_session() has run for that request's transaction.
CREATE OR REPLACE FUNCTION auth_session_lookup(p_token_hash text)
RETURNS TABLE(user_id uuid, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.user_id, s.expires_at
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash
    AND s.expires_at > now()
    AND u.status = 'active'
    AND u.deleted_at IS NULL;
$$;
COMMENT ON FUNCTION auth_session_lookup IS 'SECURITY DEFINER bootstrap for the requireAuth middleware: resolves a bearer token to a user id before set_app_session() has run for the request. Unexpired + active + non-deleted only.';

REVOKE ALL ON FUNCTION auth_login_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_session_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login_lookup(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_session_lookup(text) TO app_user;

COMMIT;
