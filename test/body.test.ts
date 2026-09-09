import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETUP_KEY, startServer, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

describe('request bodies (club.md §5-1)', () => {
  it('413s a body over 16KB, whether declared or streamed', async () => {
    const big = JSON.stringify({ setupKey: SETUP_KEY, nickname: 'x', pad: 'y'.repeat(17_000) });
    const declared = await server.api('/api/v1/claim', {
      method: 'POST',
      raw: big,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(declared.status).toBe(413);
    expect(declared.json.error.code).toBe('too_large');

    const chunked = await fetch(`${server.url}/api/v1/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      // Node's fetch requires this for a streaming request body.
      duplex: 'half',
    });
    expect(chunked.status).toBe(413);
  });

  it('400s a non-JSON content type, malformed JSON, and a non-object', async () => {
    const text = await server.api('/api/v1/claim', {
      method: 'POST',
      raw: 'setupKey=x',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(text.status).toBe(400);
    const broken = await server.api('/api/v1/claim', {
      method: 'POST',
      raw: '{"setupKey":',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(broken.status).toBe(400);
    expect(broken.json.error.code).toBe('invalid_request');
    const array = await server.api('/api/v1/claim', {
      method: 'POST',
      raw: '[1,2]',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(array.status).toBe(400);
  });

  it('accepts a charset on the content type', async () => {
    const reply = await server.api('/api/v1/claim', {
      method: 'POST',
      raw: JSON.stringify({ setupKey: SETUP_KEY, nickname: 'Yoh' }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    expect(reply.status).toBe(201);
  });
});
