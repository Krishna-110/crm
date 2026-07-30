-- =====================================================================================
-- MIGRATION 011 — replace "medicines at lead creation" with a "disease" field
-- Target: medcrm database after migrations 001-010.
--
-- Leads no longer capture medicines up front. Instead, a lead now records the disease/
-- condition the customer has (free text); medicines get added progressively afterward,
-- one at a time, alongside a comment on the lead (see the extended POST
-- /leads/:id/activities contract in server/src/routes/leads.ts). Those additions still
-- land in the existing lead_medicines table — untouched by this migration — so display
-- (Medicines Required) and convert_lead_to_order() behave exactly as before once at
-- least one medicine has been added via a comment.
-- =====================================================================================

BEGIN;

ALTER TABLE leads ADD COLUMN disease text;

COMMENT ON COLUMN leads.disease IS 'Free-text disease/condition captured at lead creation, replacing the old up-front medicine picker. Medicines are added later via comments (see lead_medicines).';

COMMIT;
