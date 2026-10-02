/**
 * Tokens and ids. Sizes are the contract's (club.md §5-1): invite and owner
 * links 128 bit, member tokens 256 bit. The setup key is 256 bit too, but the
 * client generates that one and the server only ever hashes it.
 *
 * Hashes are SHA-256 over `secret:token`. The secret is a pepper, not a salt:
 * tokens have full entropy, so what the hash buys is that a copied database
 * file contains nothing that authenticates.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const INVITE_TOKEN_BYTES = 16;
export const OWNER_LINK_BYTES = 16;
export const MEMBER_TOKEN_BYTES = 32;

// Web Crypto for the random bytes and plain encoders, so this file reads the
// same on Node and in a Worker without a Buffer in between.
const randomBytes = (count: number): Uint8Array => crypto.getRandomValues(new Uint8Array(count));

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const randomToken = (bytes: number): string => base64url(randomBytes(bytes));

/** A generated secret, as `CLUB_SECRET` would be written: 64 hex characters for 32 bytes. */
export const randomHex = (bytes: number): string => hex(randomBytes(bytes));

export const newId = (prefix: string): string => `${prefix}_${base64url(randomBytes(9))}`;

export const hashToken = (secret: string, token: string): string =>
  createHash('sha256').update(`${secret}:${token}`).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `Authorization: Bearer <token>` → the token, or null for anything else. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}
