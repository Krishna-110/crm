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

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ error: err.message });
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
