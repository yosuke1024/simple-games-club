/**
 * Field validation for the request bodies of club.md §5. Every function
 * returns the accepted value or throws a 400 — handlers read validated
 * values only.
 */
import { invalidRequest } from './http/errors.js';
import type { Outcome, Role } from './db/store.js';

const CONTROL = /[\p{Cc}\p{Cf}]/u;

function stringField(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string') throw invalidRequest(`${name} must be a string`);
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < min || length > max) {
    throw invalidRequest(`${name} must be ${min}..${max} characters`);
  }
  if (CONTROL.test(trimmed)) throw invalidRequest(`${name} contains control characters`);
  return trimmed;
}

export const nickname = (value: unknown): string => stringField(value, 'nickname', 1, 24);
export const clubName = (value: unknown): string => stringField(value, 'name', 1, 40);
export const seed = (value: unknown): string => stringField(value, 'seed', 1, 80);
export const boardDigest = (value: unknown): string => stringField(value, 'boardDigest', 1, 64);
export const gameId = (value: unknown): string => {
  const id = stringField(value, 'gameId', 1, 40);
  if (!/^[a-z0-9-]+$/.test(id)) throw invalidRequest('gameId must be a lower-case game id');
  return id;
};
export const secretField = (value: unknown, name: string): string =>
  stringField(value, name, 1, 512);

/** `title`: absent or null means none; an empty string is a title of nothing. */
export const title = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  return stringField(value, 'title', 0, 60);
};

export const role = (value: unknown): Role => {
  if (value === undefined) return 'member';
  if (value === 'member' || value === 'owner') return value;
  throw invalidRequest(`role must be 'member' or 'owner'`);
};

export const outcome = (value: unknown): Outcome => {
  if (value === 'completed' || value === 'played') return value;
  throw invalidRequest(`outcome must be 'completed' or 'played'`);
};

/** `contractVersion` is checked for shape here; whether the version is known is the handler's 501. */
export const contractVersion = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalidRequest('contractVersion must be a positive integer');
  }
  return value;
};

/** `params` / `facts`: a JSON object the server does not interpret, within the size ceiling. */
export function smallObject(
  value: unknown,
  name: string,
  maxBytes: number,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRequest(`${name} must be a JSON object`);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
    throw invalidRequest(`${name} exceeds ${maxBytes} bytes`);
  }
  return value as Record<string, unknown>;
}

/** `referralUrl`: null clears it; otherwise an https URL (club.md §8-4). */
export function httpsUrlOrNull(value: unknown, name: string): string | null {
  if (value === null) return null;
  const raw = stringField(value, name, 1, 512);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRequest(`${name} must be a URL`);
  }
  if (url.protocol !== 'https:') throw invalidRequest(`${name} must use https`);
  return url.toString();
}
