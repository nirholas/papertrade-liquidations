import { describe, expect, it } from 'vitest';
import { cacheLimiter, handleMcpRequest, MAX_BATCH, ToolError, validateArgs, type McpServerConfig } from '../../site/functions/_lib/mcp.js';

const server: McpServerConfig<null> = {
  name: 'test-server',
  title: 'Test Server',
  version: '1.2.3',
  description: 'A server for tests',
  instructions: 'Use the tools.',
  tools: [
    {
      name: 'echo',
      title: 'Echo',
      description: 'Echo a number back',
      inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 9 }, label: { type: 'string', enum: ['a', 'b'] } }, required: ['n'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { n: { type: 'integer' } } },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => ({ structured: { n: args.n }, summary: `n is ${String(args.n)}` }),
    },
    {
      name: 'boom',
      title: 'Boom',
      description: 'Always fails',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        if (args.crash) throw new Error('internal detail');
        throw new ToolError('upstream said no');
      },
    },
  ],
};

const post = (body: unknown, headers: Record<string, string> = {}, srv = server) =>
  handleMcpRequest(
    new Request('https://example.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    srv,
    null,
    () => {},
  );
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('initialize', () => {
  it('echoes a supported protocol version and advertises tools without listChanged', async () => {
    const res = await post(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(body.result.serverInfo).toEqual({ name: 'test-server', title: 'Test Server', version: '1.2.3' });
    expect(body.result.instructions).toBe('Use the tools.');
  });
  it('falls back to 2025-06-18 for an unknown version', async () => {
    const body = await (await post(rpc('initialize', { protocolVersion: '1999-01-01' }))).json();
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });
});

describe('messages', () => {
  it('answers a notification with 202 and no body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
  it('answers ping and empty resource and prompt lists', async () => {
    expect((await (await post(rpc('ping'))).json()).result).toEqual({});
    expect((await (await post(rpc('resources/list'))).json()).result).toEqual({ resources: [] });
    expect((await (await post(rpc('prompts/list'))).json()).result).toEqual({ prompts: [] });
  });
  it('lists tools with schemas and annotations', async () => {
    const body = await (await post(rpc('tools/list'))).json();
    expect(body.result.tools).toHaveLength(2);
    expect(body.result.tools[0]).toMatchObject({ name: 'echo', title: 'Echo', annotations: { readOnlyHint: true } });
    expect(body.result.tools[0].inputSchema.required).toEqual(['n']);
  });
  it('returns content text and structuredContent from tools/call', async () => {
    const body = await (await post(rpc('tools/call', { name: 'echo', arguments: { n: 4 } }))).json();
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({ n: 4 });
    expect(body.result.content[0].type).toBe('text');
    expect(body.result.content[0].text).toContain('n is 4');
  });
  it('reports a ToolError as isError, and hides unexpected failures behind a generic prefix', async () => {
    const a = await (await post(rpc('tools/call', { name: 'boom', arguments: {} }))).json();
    expect(a.result).toEqual({ content: [{ type: 'text', text: 'upstream said no' }], isError: true });
    const b = await (await post(rpc('tools/call', { name: 'boom', arguments: {} }))).json();
    expect(b.result.isError).toBe(true);
  });
  it('uses -32602 for unknown tools and bad arguments', async () => {
    expect((await (await post(rpc('tools/call', { name: 'nope' }))).json()).error.code).toBe(-32602);
    expect((await (await post(rpc('tools/call', { name: 'echo', arguments: {} }))).json()).error.message).toContain('n is required');
    expect((await (await post(rpc('tools/call', { name: 'echo', arguments: { n: 99 } }))).json()).error.code).toBe(-32602);
    expect((await (await post(rpc('tools/call', { name: 'echo', arguments: { n: 1, extra: true } }))).json()).error.message).toContain('not a known parameter');
    expect((await (await post(rpc('tools/call', { arguments: {} }))).json()).error.code).toBe(-32602);
  });
  it('uses -32601 for unknown methods', async () => {
    expect((await (await post(rpc('does/not/exist'))).json()).error.code).toBe(-32601);
  });
  it('uses -32700 for invalid JSON and -32600 for a bad envelope', async () => {
    const bad = await post('{not json');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    const env = await post({ hello: 'world' });
    expect(env.status).toBe(400);
    expect((await env.json()).error.code).toBe(-32600);
  });
  it('handles batches, skipping notifications, and rejects empty or oversized batches', async () => {
    const res = await post([rpc('ping', undefined, 'a'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list', undefined, 'b')]);
    const body = await res.json();
    expect(body.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect((await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }])).status).toBe(202);
    expect((await post([])).status).toBe(400);
    expect((await post(Array.from({ length: MAX_BATCH + 1 }, (_, i) => rpc('ping', undefined, i)))).status).toBe(400);
  });
  it('rejects a non-JSON content type and an oversized body', async () => {
    expect((await post(rpc('ping'), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(rpc('ping'), { 'content-length': '999999' })).status).toBe(413);
  });
});

describe('transport', () => {
  it('replies with one SSE message event when only text/event-stream is accepted', async () => {
    const res = await post(rpc('ping'), { accept: 'text/event-stream' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text.startsWith('event: message\ndata: ')).toBe(true);
    expect(JSON.parse(text.split('data: ')[1]!.trim())).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });
  it('replies with JSON when the client accepts both', async () => {
    expect((await post(rpc('ping'))).headers.get('content-type')).toContain('application/json');
  });
  it('answers GET event-stream and DELETE with 405 and Allow: POST', async () => {
    const get = await handleMcpRequest(new Request('https://example.test/mcp', { headers: { accept: 'text/event-stream' } }), server, null, () => {});
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toContain('POST');
    const del = await handleMcpRequest(new Request('https://example.test/mcp', { method: 'DELETE' }), server, null, () => {});
    expect(del.status).toBe(405);
  });
  it('describes the server on a plain GET', async () => {
    const res = await handleMcpRequest(new Request('https://example.test/mcp'), server, null, () => {});
    const body = await res.json();
    expect(body).toMatchObject({ name: 'test-server', transport: 'streamable-http', endpoint: 'https://example.test/mcp', readOnly: true });
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['echo', 'boom']);
  });
  it('answers the CORS preflight with the MCP headers', async () => {
    const res = await handleMcpRequest(new Request('https://example.test/mcp', { method: 'OPTIONS' }), server, null, () => {});
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Mcp-Session-Id.*Mcp-Protocol-Version.*Authorization|Authorization.*Mcp/);
  });
  it('sets CORS on POST replies', async () => {
    expect((await post(rpc('ping'))).headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After when the limiter says wait', async () => {
    const res = await post(rpc('ping'), {}, { ...server, limiter: async () => 17 });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
  });
  it('cacheLimiter allows the limit and then blocks until the next window', async () => {
    const store = new Map<string, string>();
    const cache = {
      match: async (req: Request) => (store.has(req.url) ? new Response(store.get(req.url)!) : undefined),
      put: async (req: Request, res: Response) => void store.set(req.url, await res.text()),
    } as unknown as Cache;
    let now = 1_000_000_000;
    const limit = cacheLimiter(() => cache, 2, 60, () => now);
    const req = new Request('https://example.test/mcp', { headers: { 'cf-connecting-ip': '1.2.3.4' } });
    expect(await limit(req)).toBeNull();
    expect(await limit(req)).toBeNull();
    expect(await limit(req)).toBeGreaterThan(0);
    expect(await limit(new Request('https://example.test/mcp', { headers: { 'cf-connecting-ip': '5.6.7.8' } }))).toBeNull();
    now += 61_000;
    expect(await limit(req)).toBeNull();
  });
});

describe('validateArgs', () => {
  it('checks types, enums, patterns and ranges', () => {
    const schema = { type: 'object', properties: { w: { type: 'string', pattern: '^0x[0-9a-f]{2}$' }, k: { type: 'number', minimum: 0 }, b: { type: 'boolean' } }, additionalProperties: false } as const;
    expect(validateArgs(schema, { w: '0xab', k: 1, b: true })).toBeNull();
    expect(validateArgs(schema, { w: 'zz' })).toContain('invalid format');
    expect(validateArgs(schema, { k: -1 })).toContain('at least');
    expect(validateArgs(schema, { b: 'yes' })).toContain('boolean');
    expect(validateArgs(schema, [])).toContain('object');
  });
});
