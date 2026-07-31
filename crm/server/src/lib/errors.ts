import type { NextFunction, Request, Response } from 'express';

/**
 * HTTP errors and the Prisma-to-status mapping.
 *
 * Much smaller than its predecessor, for one reason: the database no longer raises errors of
 * its own. The old version had to unwrap Prisma's P2010 envelope to find a PL/pgSQL SQLSTATE
 * buried at `meta.driverAdapterError.cause.code`, because otherwise every trigger rejection
 * surfaced as a 500. With no triggers, a rule violation is an ApiError thrown by a service —
 * it already knows its own status code.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string) {
    return new ApiError(400, message);
  }
  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message);
  }
  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message);
  }
  static notFound(message = 'Not found') {
    return new ApiError(404, message);
  }
  static conflict(message: string) {
    return new ApiError(409, message);
  }
}

/** Prisma's documented error codes, mapped to the status the API returns. */
const PRISMA_STATUS: Record<string, number> = {
  P2002: 409, // unique constraint
  P2003: 400, // foreign key constraint
  P2025: 404, // record required but not found
  P2000: 400, // value too long for column
  P2011: 400, // null constraint violation
};

/** Friendlier text for the unique constraints a user can actually hit. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  users_email_key: 'A user with that email address already exists',
  users_employee_id_key: 'A user with that employee ID already exists',
  products_sku_key: 'A medicine with that SKU already exists',
  orders_order_number_key: 'That order number is already in use',
};

type PrismaLikeError = {
  code?: string;
  meta?: {
    modelName?: unknown;
    driverAdapterError?: { cause?: { originalMessage?: unknown; constraint?: { fields?: unknown } } };
  };
};

function isPrismaError(err: unknown): err is PrismaLikeError {
  return typeof err === 'object' && err !== null && typeof (err as PrismaLikeError).code === 'string';
}

/**
 * The friendlier message for a unique violation, if we have one.
 *
 * Prisma 7 does not populate `meta.target`. The index name is only available inside the
 * driver adapter's original Postgres message, so it is read from there — with the model and
 * field names as a fallback in case that wording changes.
 */
function constraintMessage(err: PrismaLikeError): string | undefined {
  const cause = err.meta?.driverAdapterError?.cause;

  const original = typeof cause?.originalMessage === 'string' ? cause.originalMessage : '';
  const named = /constraint "([^"]+)"/.exec(original)?.[1];
  if (named && CONSTRAINT_MESSAGES[named]) return CONSTRAINT_MESSAGES[named];

  const fields = Array.isArray(cause?.constraint?.fields) ? (cause!.constraint!.fields as string[]) : [];
  const model = String(err.meta?.modelName ?? '').toLowerCase();
  if (model && fields.length) {
    const key = `${model}s_${fields.join('_')}_key`;
    if (CONSTRAINT_MESSAGES[key]) return CONSTRAINT_MESSAGES[key];
  }
  return undefined;
}

/**
 * Terminal error handler. Must be registered last.
 *
 * Anything unrecognised becomes a 500 with a generic body — internal messages and stack
 * traces stay in the log rather than going to the client.
 */
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // express.json() throws a SyntaxError on a malformed body. Without this it reaches the
  // catch-all below and a client's bad JSON is reported as a server fault — a 500 that says
  // "we broke" when the request was never valid.
  if (
    err instanceof SyntaxError &&
    'status' in err &&
    (err as SyntaxError & { status?: number }).status === 400 &&
    'body' in err
  ) {
    res.status(400).json({ error: 'Malformed JSON in request body' });
    return;
  }

  if (isPrismaError(err)) {
    const status = PRISMA_STATUS[err.code!];
    if (status) {
      const message =
        status === 409
          ? (constraintMessage(err) ?? 'That value is already in use')
          : status === 404
            ? 'Not found'
            : 'Invalid request';
      res.status(status).json({ error: message });
      return;
    }
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * Wraps an async route so a rejected promise reaches the error middleware.
 *
 * Express 5 forwards rejections automatically, but only for handlers it recognises as
 * returning a promise. Being explicit costs nothing and removes the question.
 */
export function route<T extends Request>(
  handler: (req: T, res: Response) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req as T, res).catch(next);
  };
}

/**
 * A required route parameter, as a string.
 *
 * Express 5 types params as `string | string[] | undefined` because a route pattern can
 * repeat a name. Ours never do, so this narrows once here rather than casting at every call
 * site — and turns a malformed URL into a 400 instead of a type assertion that lies.
 */
export function param(req: { params: Record<string, unknown> }, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw ApiError.badRequest(`${name} is required in the path`);
  }
  return value;
}
