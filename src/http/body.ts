/**
 * Reading a JSON body with the contract's ceiling (16KB → 413). The limit is
 * enforced on the bytes actually received, not only on Content-Length, so a
 * chunked request cannot talk its way past it. The source is abstract so the
 * same check runs on a Node `IncomingMessage` and on a Fetch `Request`.
 */
import { invalidRequest, tooLarge } from './errors.js';

export type JsonObject = Record<string, unknown>;

export interface BodySource {
  contentLength: string | undefined;
  contentType: string | undefined;
  chunks(): AsyncIterable<Uint8Array>;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function readJsonObject(body: BodySource, limit: number): Promise<JsonObject> {
  const declared = Number(body.contentLength);
  if (Number.isFinite(declared) && declared > limit) {
    throw tooLarge(`body exceeds ${limit} bytes`);
  }
  if (!/^application\/json\b/i.test(body.contentType ?? '')) {
    throw invalidRequest('Content-Type must be application/json');
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of body.chunks()) {
    received += chunk.byteLength;
    if (received > limit) throw tooLarge(`body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw invalidRequest('body is not valid JSON');
  }
  if (!isObject(parsed)) throw invalidRequest('body must be a JSON object');
  return parsed;
}
