-- Migration 013: Rename 'closed' lead status to 'sold' and add payment_screenshot to leads

BEGIN;

-- 1. Rename 'closed' to 'sold' in lead_statuses lookup table
UPDATE lead_statuses
SET code = 'sold', label = 'Sold'
WHERE code = 'closed';

-- Insert 'sold' if not existing
INSERT INTO lead_statuses (code, label, sort_order)
VALUES ('sold', 'Sold', 9)
ON CONFLICT (code) DO NOTHING;

-- 2. Update existing leads with status 'closed' to 'sold'
UPDATE leads
SET status = 'sold'
WHERE status = 'closed';

-- 3. Update terminal lead status helper function
CREATE OR REPLACE FUNCTION is_terminal_lead_status(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_status IN ('converted','closed','sold','not_interested');
$$;

-- 4. Add payment_screenshot column to leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS payment_screenshot text;

COMMIT;
