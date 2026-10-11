/**
 * /mcp: Model Context Protocol server (Streamable HTTP, stateless, read-only).
 * See docs/mcp.md. The tool set lives in _lib/tools.ts and the protocol plumbing in _lib/mcp.ts.
 */
import { cacheLimiter, handleMcpRequest, type McpServerConfig } from './_lib/mcp.js';
import { defaultCache } from './_lib/heatmap-core.js';
import tools, { type Env } from './_lib/tools.js';
import { SERVER_INFO } from './_lib/server-info.js';

const limiter = cacheLimiter(defaultCache, 30, 60);

const server: McpServerConfig<Env> = { ...SERVER_INFO, tools, limiter };

export const onRequest: PagesFunction<Env> = ({ request, env, waitUntil }) => handleMcpRequest(request, server, env, (p) => waitUntil(p));
