/**
 * Minimal stateless MCP server over Streamable HTTP (JSON-RPC 2.0), written for Cloudflare Pages Functions.
 *
 * - `POST` carries one JSON-RPC message or a batch array. Requests get a response, notifications get 202.
 * - The reply is `application/json`, or a single SSE `message` event when the client accepts only text/event-stream.
 * - No sessions, no cookies, no server-initiated messages: `GET` with text/event-stream and `DELETE` answer 405.
 * - Every tool here is read-only. Nothing in this module signs, sends or pays.
 */

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const DEFAULT_PROTOCOL = '2025-06-18';
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 5;

export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  [key: string]: unknown;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolResult {
  /** Machine-readable result. Also serialized into the text content for clients that ignore structuredContent. */
  structured: Record<string, unknown>;
  /** One readable sentence or two that leads the text content. */
  summary: string;
}

export interface ToolContext<Env = unknown> {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface ToolDefinition<Env = unknown> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, ctx: ToolContext<Env>) => Promise<ToolResult>;
}

export interface McpServerConfig<Env = unknown> {
  name: string;
  title: string;
  version: string;
  description: string;
  instructions: string;
  tools: readonly ToolDefinition<Env>[];
  /** Returns null when allowed, or the seconds to wait. */
  limiter?: (request: Request) => Promise<number | null>;
  /** Links shown by a plain GET. */
  links?: Record<string, string>;
}

/** Throw from a handler for a failure the model can act on. It becomes a tool result with isError true. */
export class ToolError extends Error {}

export const JSONRPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  rateLimited: -32000,
} as const;

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'access-control-expose-headers': 'Mcp-Session-Id, Mcp-Protocol-Version, Retry-After',
  'access-control-max-age': '86400',
};

type Id = string | number | null;
interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}
interface RpcResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: RpcError;
}

const rpcError = (id: Id, code: number, message: string, data?: unknown): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const rpcResult = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function send(body: unknown, accept: string, status = 200, extra: Record<string, string> = {}): Response {
  const wantsSse = /text\/event-stream/i.test(accept) && !/(application\/json|\*\/\*)/i.test(accept);
  if (wantsSse) {
    return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
      status,
      headers: { ...CORS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', ...extra },
    });
  }
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

/** Validate tool arguments against the small JSON Schema subset the tool definitions use. Returns an error message or null. */
export function validateArgs(schema: JsonSchema, value: unknown, path = 'arguments'): string | null {
  if (schema.type === 'object') {
    if (!isObject(value)) return `${path} must be an object`;
    for (const key of schema.required ?? []) if (value[key] === undefined) return `${path}.${key} is required`;
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      const sub = props[key];
      if (!sub) {
        if (schema.additionalProperties === false) return `${path}.${key} is not a known parameter (allowed: ${Object.keys(props).join(', ') || 'none'})`;
        continue;
      }
      const problem = validateArgs(sub, v, `${path}.${key}`);
      if (problem) return problem;
    }
    return null;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`;
    if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format`;
    return null;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`;
    if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
    return null;
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${path} must be a boolean`;
  return null;
}

/** The tool as it appears in tools/list and in the discovery documents. */
export function describeTool<Env>(tool: ToolDefinition<Env>) {
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations };
}

async function callTool<Env>(server: McpServerConfig<Env>, params: unknown, ctx: ToolContext<Env>, id: Id): Promise<RpcResponse> {
  if (!isObject(params) || typeof params.name !== 'string') return rpcError(id, JSONRPC.invalidParams, 'tools/call needs params.name');
  const tool = server.tools.find((t) => t.name === params.name);
  if (!tool) return rpcError(id, JSONRPC.invalidParams, `Unknown tool "${params.name}". Available: ${server.tools.map((t) => t.name).join(', ')}`);
  const args = params.arguments === undefined ? {} : params.arguments;
  const problem = validateArgs(tool.inputSchema, args);
  if (problem) return rpcError(id, JSONRPC.invalidParams, `Invalid arguments for ${tool.name}: ${problem}`);
  try {
    const { structured, summary } = await tool.handler(args as Record<string, unknown>, ctx);
    const text = `${summary}\n\n${JSON.stringify(structured)}`;
    return rpcResult(id, { content: [{ type: 'text', text }], structuredContent: structured, isError: false });
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `The tool failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
    return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
  }
}

async function dispatch<Env>(server: McpServerConfig<Env>, message: unknown, ctx: ToolContext<Env>): Promise<RpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== '2.0') return rpcError(null, JSONRPC.invalidRequest, 'Each message must be a JSON-RPC 2.0 object');
  const hasId = 'id' in message;
  const id = hasId ? (message.id as Id) : null;
  if (hasId && id !== null && typeof id !== 'string' && typeof id !== 'number') return rpcError(null, JSONRPC.invalidRequest, 'id must be a string, number or null');
  if (typeof message.method !== 'string') {
    // A response to a server request. This server never sends any, so there is nothing to do.
    return 'result' in message || 'error' in message ? null : rpcError(id, JSONRPC.invalidRequest, 'Missing method');
  }
  const method = message.method;
  if (!hasId) return null; // notification, including notifications/initialized and notifications/cancelled
  const params = message.params;
  switch (method) {
    case 'initialize': {
      const asked = isObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked) ? asked : DEFAULT_PROTOCOL;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, title: server.title, version: server.version },
        instructions: server.instructions,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: server.tools.map(describeTool) });
    case 'tools/call':
      return callTool(server, params, ctx, id);
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, JSONRPC.methodNotFound, `Method not found: ${method}`);
  }
}

function infoDocument<Env>(server: McpServerConfig<Env>, origin: string) {
  return {
    name: server.name,
    title: server.title,
    version: server.version,
    description: server.description,
    transport: 'streamable-http',
    endpoint: `${origin}/mcp`,
    protocolVersions: SUPPORTED_PROTOCOLS,
    stateless: true,
    readOnly: true,
    tools: server.tools.map((t) => ({ name: t.name, title: t.title, description: t.description })),
    usage: 'POST JSON-RPC 2.0 messages to this URL with Content-Type: application/json.',
    links: server.links ?? {},
  };
}

export async function handleMcpRequest<Env>(request: Request, server: McpServerConfig<Env>, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  const accept = request.headers.get('accept') ?? '';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method === 'DELETE') return new Response('Sessions are not used. This server is stateless.', { status: 405, headers: { ...CORS, allow: 'POST, OPTIONS' } });
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (/text\/event-stream/i.test(accept)) {
      return new Response('This server does not open server-to-client streams. Use POST.', { status: 405, headers: { ...CORS, allow: 'POST, OPTIONS' } });
    }
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(infoDocument(server, url.origin), null, 2), {
      headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { ...CORS, allow: 'GET, POST, OPTIONS' } });

  const contentType = request.headers.get('content-type') ?? '';
  if (!/application\/json/i.test(contentType)) {
    return send(rpcError(null, JSONRPC.invalidRequest, 'Content-Type must be application/json'), accept, 415);
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return send(rpcError(null, JSONRPC.invalidRequest, `Body larger than ${MAX_BODY_BYTES} bytes`), accept, 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return send(rpcError(null, JSONRPC.invalidRequest, `Body larger than ${MAX_BODY_BYTES} bytes`), accept, 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return send(rpcError(null, JSONRPC.parse, 'Parse error: the body is not valid JSON'), accept, 400);
  }

  if (server.limiter) {
    const wait = await server.limiter(request);
    if (wait !== null) {
      return send(rpcError(null, JSONRPC.rateLimited, `Rate limit exceeded. Retry in ${wait} seconds.`), accept, 429, { 'retry-after': String(wait) });
    }
  }

  const ctx: ToolContext<Env> = { request, env, waitUntil };
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return send(rpcError(null, JSONRPC.invalidRequest, 'Empty batch'), accept, 400);
    if (parsed.length > MAX_BATCH) return send(rpcError(null, JSONRPC.invalidRequest, `Batch larger than ${MAX_BATCH} messages`), accept, 400);
    const results: RpcResponse[] = [];
    for (const message of parsed) {
      const r = await dispatch(server, message, ctx);
      if (r) results.push(r);
    }
    if (results.length === 0) return new Response(null, { status: 202, headers: CORS });
    return send(results, accept);
  }

  const result = await dispatch(server, parsed, ctx);
  if (!result) return new Response(null, { status: 202, headers: CORS });
  const invalid = result.error?.code === JSONRPC.invalidRequest;
  return send(result, accept, invalid ? 400 : 200);
}

/** Fixed-window limiter backed by a cache. Not atomic, which is fine for abuse control. Returns seconds to wait, or null. */
export function cacheLimiter(getCache: () => Cache, limit: number, windowSeconds: number, now: () => number = Date.now): (request: Request) => Promise<number | null> {
  return async (request) => {
    const ip = request.headers.get('cf-connecting-ip') ?? 'anonymous';
    const windowStart = Math.floor(now() / 1000 / windowSeconds);
    const key = new Request(`https://rate.invalid/mcp/${encodeURIComponent(ip)}/${windowStart}`);
    const cache = getCache();
    const hit = await cache.match(key);
    const used = hit ? Number(await hit.text()) || 0 : 0;
    if (used >= limit) return Math.max(1, (windowStart + 1) * windowSeconds - Math.floor(now() / 1000));
    await cache.put(key, new Response(String(used + 1), { headers: { 'cache-control': `max-age=${windowSeconds}` } }));
    return null;
  };
}
