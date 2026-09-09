/**
 * Reading a JSON body with the contract's ceiling (16KB → 413). The limit is
 * enforced on the bytes actually received, not only on Content-Length, so a
 * chunked request cannot talk its way past it.
 */
import type { IncomingMessage } from 'node:http';
import { invalidRequest, tooLarge } from './errors.js';

export type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function readJsonObject(req: IncomingMessage, limit: number): Promise<JsonObject> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw tooLarge(`body exceeds ${limit} bytes`);
  }
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) {
    throw invalidRequest('Content-Type must be application/json');
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > limit) throw tooLarge(`body exceeds ${limit} bytes`);
    chunks.push(buffer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw invalidRequest('body is not valid JSON');
  }
  if (!isObject(parsed)) throw invalidRequest('body must be a JSON object');
  return parsed;
}
