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

/**
 * A display name (club.md §17-1): NFC, trimmed, runs of whitespace collapsed to
 * one space; no control, format (zero-width joiners included), private-use,
 * surrogate or unassigned code point; at least one letter or number; 1..24
 * code points. There is no word list, on purpose.
 */
const NICKNAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
export const nickname = (value: unknown): string => {
  if (typeof value !== 'string') throw invalidRequest('nickname must be a string');
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const length = [...name].length;
  if (length < 1 || length > 24) throw invalidRequest('nickname must be 1..24 characters');
  if (NICKNAME_FORBIDDEN.test(name)) throw invalidRequest('nickname contains unusable characters');
  if (!LETTER_OR_NUMBER.test(name)) throw invalidRequest('nickname needs a letter or a number');
  return name;
};
export const clubName = (value: unknown): string => stringField(value, 'name', 1, 40);
export const seed = (value: unknown): string => stringField(value, 'seed', 1, 80);
/** A ranking result's seed may be empty: an arcade run has no board to name (club.md §16-1). */
export const seedOrEmpty = (value: unknown): string => stringField(value, 'seed', 0, 80);
export const boardDigest = (value: unknown): string => stringField(value, 'boardDigest', 1, 64);
/** `boardDigest` on a ranking result may be null: not every game has a digest (club.md §16). */
export const boardDigestOrNull = (value: unknown): string | null =>
  value === null ? null : boardDigest(value);
/** `paramsKey`: the table's mode key. The client's contract computes it; only its shape is checked. */
export const paramsKey = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value)) {
    throw invalidRequest('paramsKey must be 1..40 characters of a-z, 0-9 and -');
  }
  return value;
};
/** `?top=`: absent means the default; otherwise a positive integer, capped. */
export const top = (value: string | null, fallback: number, max: number): number => {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw invalidRequest('top must be a positive integer');
  }
  return Math.min(Number(value), max);
};
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

/** `daily`: absent or null means none; otherwise a real calendar date, `YYYY-MM-DD`. */
export const daily = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalidRequest('daily must be a date, YYYY-MM-DD');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw invalidRequest('daily must be a real calendar date');
  }
  return value;
};

/** The `?daily=` filter: unlike the body field, it must be present when the parameter is. */
export const dailyQuery = (value: string | null): string => {
  const parsed = daily(value);
  if (parsed === null) throw invalidRequest('daily must be a date, YYYY-MM-DD');
  return parsed;
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
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
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
