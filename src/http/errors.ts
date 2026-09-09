/**
 * The error model of club.md §5-1: `{ error: { code, message } }`, one HTTP
 * status per code. `message` is for a developer reading a log; the client
 * shows its own catalog string for `code`.
 */
export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'already_submitted'
  | 'board_mismatch'
  | 'invite_expired'
  | 'setup_key_used'
  | 'last_owner'
  | 'too_many_owners'
  | 'too_many_members'
  | 'too_large'
  | 'rate_limited'
  | 'unsupported_version'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const invalidRequest = (message: string): ApiError =>
  new ApiError(400, 'invalid_request', message);
export const unauthorized = (message = 'a valid member token is required'): ApiError =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'owner role is required'): ApiError =>
  new ApiError(403, 'forbidden', message);
export const notFound = (message: string): ApiError => new ApiError(404, 'not_found', message);
export const conflict = (
  code: Extract<
    ErrorCode,
    | 'already_submitted'
    | 'board_mismatch'
    | 'invite_expired'
    | 'setup_key_used'
    | 'last_owner'
    | 'too_many_owners'
    | 'too_many_members'
  >,
  message: string,
): ApiError => new ApiError(409, code, message);
export const tooLarge = (message: string): ApiError => new ApiError(413, 'too_large', message);
export const rateLimited = (): ApiError =>
  new ApiError(429, 'rate_limited', 'too many requests; wait a minute');
export const unsupportedVersion = (version: unknown): ApiError =>
  new ApiError(501, 'unsupported_version', `contractVersion ${String(version)} is not supported`);
