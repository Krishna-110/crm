import type { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }

  static notFound(message = 'Not found') {
    return new ApiError(404, message);
  }

  static badRequest(message: string) {
    return new ApiError(400, message);
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message);
  }

  static conflict(message: string) {
    return new ApiError(409, message);
  }
}

// Postgres error codes we translate into a specific HTTP status. Anything else falls
// through to a generic 500 rather than leaking internals to the client.
const PG_CODE_STATUS: Record<string, number> = {
  P0001: 403, // RAISE EXCEPTION from a trigger or plpgsql function (ownership/lifecycle guards)
  '42501': 403, // insufficient_privilege (RLS WITH CHECK / REVOKEd grant)
  '23505': 409, // unique_violation
  '23514': 400, // check_violation
  '23503': 400, // foreign_key_violation
  '22P02': 400, // invalid_text_representation (bad uuid/enum literal)
};

// Postgres's own message for a constraint violation names the constraint, not the
// field ("new row ... violates check constraint chk_leads_mobile") — meaningless to an
// end user. Map the constraints reachable from user input to a message that says what
// to actually fix.
const CONSTRAINT_MESSAGES: Record<string, string> = {
  chk_leads_mobile: 'Mobile number must be a 10-digit Indian mobile number starting with 6-9 (e.g. 9876543210).',
  chk_customers_primary_mobile: 'Mobile number must be a 10-digit Indian mobile number starting with 6-9 (e.g. 9876543210).',
  chk_leads_pincode: 'Pincode must be exactly 6 digits.',
  chk_customers_pincode: 'Pincode must be exactly 6 digits.',
  chk_leads_alternate_number: 'Alternate number must be 7-20 characters using digits, spaces, +, -, or parentheses.',
  chk_customers_alternate_mobile: 'Alternate number must be 7-20 characters using digits, spaces, +, -, or parentheses.',
  chk_users_phone_format: 'Phone number must be 7-20 characters using digits, spaces, +, -, or parentheses.',
  products_unit_price_check: 'Unit price cannot be negative.',
  products_stock_quantity_check: 'Stock quantity cannot be negative.',
  orders_discount_type_check: "Discount type must be 'none', 'flat', or 'percentage'.",
  orders_discount_value_check: 'Discount value cannot be negative.',
  chk_orders_discount_percentage_range: 'A percentage discount cannot exceed 100.',
  order_items_unit_price_snapshot_check: 'Unit price cannot be negative.',
  lead_medicines_days_check: 'Days must be a positive number.',
  leads_quantity_check: 'Quantity must be a positive number.',
  order_items_quantity_check: 'Quantity must be a positive number.',
  ux_users_employee_id: 'That employee ID is already in use.',
  ux_users_email: 'That email address is already in use.',
  ux_products_sku: 'That medicine SKU is already in use.',
  ux_customers_primary_mobile: 'A customer with that mobile number already exists.',
  ux_orders_order_number: 'That order number is already in use.',
};

// RAISE EXCEPTION messages from trigger functions are often prefixed with the
// function's own name for log readability ("convert_lead_to_order: lead % not
// found") — meaningful in a server log, not to the person who clicked a button.
function stripFunctionPrefix(message: string): string {
  return message.replace(/^[a-z][a-z0-9_]*: /, '');
}

interface PgLikeError {
  code?: string;
  constraint?: string;
  message: string;
}

function isPgError(err: unknown): err is PgLikeError {
  return typeof err === 'object' && err !== null && 'code' in err && typeof (err as PgLikeError).code === 'string';
}

// Prisma's own error codes. These are NOT Postgres SQLSTATEs — and critically, a
// PrismaClientKnownRequestError also carries a string `.code`, so it satisfies isPgError()
// above. Prisma errors must therefore be handled BEFORE the raw-pg branch, or a unique
// violation would fall through to a generic 500 instead of a 409.
const PRISMA_CODE_STATUS: Record<string, number> = {
  P2000: 400, // value too long for column
  P2002: 409, // unique constraint failed
  P2003: 400, // foreign key constraint failed
  P2011: 400, // null constraint violation
  P2025: 404, // record required but not found (update/delete on a missing row)
};

interface PrismaLikeError {
  name: string;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

function isPrismaKnownError(err: unknown): err is PrismaLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as PrismaLikeError).name === 'string' &&
    (err as PrismaLikeError).name.startsWith('PrismaClient') &&
    typeof (err as PrismaLikeError).code === 'string'
  );
}

// Prisma has no `.constraint` field. The offending index/constraint name instead shows up
// in `meta.target` (usually string[] of column names, but the raw constraint name for
// index-level violations) or `meta.constraint`. Normalise both so the existing
// CONSTRAINT_MESSAGES table keeps producing friendly text.
function prismaConstraintName(err: PrismaLikeError): string | undefined {
  const raw = err.meta?.constraint ?? err.meta?.target;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) return raw.join('_');
  return undefined;
}

// A Postgres error raised inside $queryRaw — a RAISE EXCEPTION from a trigger or one of the
// SECURITY DEFINER ownership guards, a constraint violation, an RLS denial — does not
// surface as a bare pg error. Prisma reports it as P2010 ("raw query failed") and buries
// the real SQLSTATE under the driver adapter, e.g.
//
//   { code: 'P2010',
//     meta: { driverAdapterError: { cause: { code: 'P0001', message: 'convert_lead_to_order: …' } } } }
//
// Without unwrapping, every one of those degrades to a generic 500 — which is exactly how
// a caller's blocked lead conversion first showed up. Both the nested and flat shapes are
// checked so this keeps working if the adapter's error envelope changes.
function unwrapRawPgError(err: PrismaLikeError): PgLikeError | undefined {
  const meta = err.meta;
  if (!meta) return undefined;

  const adapterError = meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined;
  const cause = adapterError?.cause;

  const pick = (source: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = source?.[key];
    return typeof value === 'string' ? value : undefined;
  };

  const code = pick(cause, 'code') ?? pick(cause, 'originalCode') ?? pick(meta, 'code');
  if (!code) return undefined;

  return {
    code,
    message: pick(cause, 'originalMessage') ?? pick(cause, 'message') ?? pick(meta, 'message') ?? err.message,
    constraint: pick(cause, 'constraint') ?? pick(meta, 'constraint'),
  };
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Prisma first — see the comment on PRISMA_CODE_STATUS for why order matters here.
  if (isPrismaKnownError(err)) {
    const unwrapped = unwrapRawPgError(err);
    if (unwrapped?.code) {
      const pgStatus = PG_CODE_STATUS[unwrapped.code];
      if (pgStatus) {
        let message = (unwrapped.constraint && CONSTRAINT_MESSAGES[unwrapped.constraint]) || unwrapped.message;
        if (unwrapped.code === 'P0001') message = stripFunctionPrefix(message);
        res.status(pgStatus).json({ error: message });
        return;
      }
    }

    const prismaStatus = PRISMA_CODE_STATUS[err.code];
    if (prismaStatus) {
      const constraint = prismaConstraintName(err);
      const friendly = constraint ? CONSTRAINT_MESSAGES[constraint] : undefined;
      // Prisma's own messages leak schema internals ("Invalid `prisma.users.create()`
      // invocation ... Unique constraint failed on the fields: (`email`)"), so fall back
      // to a terse generic rather than echoing them at the user.
      const fallback =
        err.code === 'P2002'
          ? 'That value is already in use.'
          : err.code === 'P2025'
            ? 'Not found'
            : 'That request could not be completed.';
      res.status(prismaStatus).json({ error: friendly ?? fallback });
      return;
    }

    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  if (isPgError(err) && err.code) {
    const pgStatus = PG_CODE_STATUS[err.code];
    if (pgStatus) {
      let message = (err.constraint && CONSTRAINT_MESSAGES[err.constraint]) || err.message;
      if (err.code === 'P0001') message = stripFunctionPrefix(message);
      res.status(pgStatus).json({ error: message });
      return;
    }
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
