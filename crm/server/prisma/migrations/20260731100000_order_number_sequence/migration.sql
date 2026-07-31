-- Order numbers are ORD-YYYY-NNNN, and the NNNN comes from here.
--
-- A sequence rather than counting existing orders: a count is racy under concurrent
-- conversions and would collide on orders.order_number's unique index. A sequence is a
-- plain database object — not procedural code — so it does not reintroduce the PL/pgSQL
-- this schema deliberately avoids.
--
-- Prisma has no declarative syntax for a standalone sequence, so this migration is
-- hand-written. It is additive and safe to replay.
CREATE SEQUENCE IF NOT EXISTS order_number_seq AS bigint START WITH 1 INCREMENT BY 1;

-- Keep the sequence ahead of anything the seed already created.
SELECT setval(
  'order_number_seq',
  GREATEST((SELECT count(*) FROM orders), 1),
  true
);
