-- =====================================================================================
-- MIGRATION 015 — order-level discount (flat ₹ or percentage)
--
-- total_amount stays exactly as-is (the subtotal, maintained by the existing
-- update_order_total() trigger off order_items — untouched by this migration).
-- payable_amount is a GENERATED column deriving the actual amount owed from
-- total_amount + discount_type + discount_value, so it recomputes automatically
-- whenever total_amount changes (line items added/removed) with zero changes needed
-- to that trigger, and whenever discount_type/discount_value are edited directly.
-- =====================================================================================

BEGIN;

ALTER TABLE orders
  ADD COLUMN discount_type text NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none', 'flat', 'percentage')),
  ADD COLUMN discount_value numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_value >= 0);

ALTER TABLE orders ADD CONSTRAINT chk_orders_discount_percentage_range
  CHECK (discount_type <> 'percentage' OR discount_value <= 100);

-- Added as a second statement so discount_type/discount_value are guaranteed to
-- already exist as real columns before this expression references them.
ALTER TABLE orders ADD COLUMN payable_amount numeric(14,2) GENERATED ALWAYS AS (
  GREATEST(
    CASE discount_type
      WHEN 'flat' THEN total_amount - discount_value
      WHEN 'percentage' THEN total_amount * (1 - discount_value / 100)
      ELSE total_amount
    END,
    0
  )
) STORED;

COMMENT ON COLUMN orders.discount_type IS 'none | flat (discount_value is a ₹ amount) | percentage (discount_value is 0-100).';
COMMENT ON COLUMN orders.payable_amount IS 'The actual amount owed after discount, floored at 0. Always derived from total_amount/discount_type/discount_value — never written directly.';

COMMIT;
