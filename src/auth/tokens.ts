/**
 * Tokens and ids. Sizes are the contract's (club.md §5-1): invite and owner
 * links 128 bit, member tokens 256 bit. The setup key is 256 bit too, but the
 * client generates that one and the server only ever hashes it.
 *
 * Hashes are SHA-256 over `secret:token`. The secret is a pepper, not a salt:
 * tokens have full entropy, so what the hash buys is that a copied database
 * file contains nothing that authenticates.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const INVITE_TOKEN_BYTES = 16;
export const OWNER_LINK_BYTES = 16;
export const MEMBER_TOKEN_BYTES = 32;

export const randomToken = (bytes: number): string => randomBytes(bytes).toString('base64url');

export const newId = (prefix: string): string =>
  `${prefix}_${randomBytes(9).toString('base64url')}`;

export const hashToken = (secret: string, token: string): string =>
  createHash('sha256').update(`${secret}:${token}`).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `Authorization: Bearer <token>` → the token, or null for anything else. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}
