/** An error the HTTP layer maps to a status code. Messages are safe to show to the operator. */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'authentication required');

/** Raised by a store when a UNIQUE idempotency_key already exists. */
export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';

  constructor(readonly idempotencyKey: string) {
    super(`tool call with idempotency key ${idempotencyKey} already exists`);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
