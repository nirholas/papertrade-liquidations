// Generates the agent discovery JSON under site/public/.well-known from the live MCP tool registry.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import tools from '../site/functions/_lib/tools.js';
import { describeTool } from '../site/functions/_lib/mcp.js';
import { SERVER_INFO, SITE } from '../site/functions/_lib/server-info.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '../site/public/.well-known');
mkdirSync(join(out, 'mcp'), { recursive: true });
const write = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2) + '\n');

const described = tools.map(describeTool);
const endpoint = `${SITE}/mcp`;

const serverCard = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
  serverInfo: { name: SERVER_INFO.name, title: SERVER_INFO.title, version: SERVER_INFO.version },
  description: SERVER_INFO.description,
  instructions: SERVER_INFO.instructions,
  protocolVersion: '2025-06-18',
  transport: { type: 'streamable-http', endpoint },
  remotes: [{ type: 'streamable-http', url: endpoint }],
  authentication: { required: false, schemes: [] },
  capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
  tools: described,
  documentation: SERVER_INFO.links.docs,
  repository: SERVER_INFO.links.source,
  license: 'Apache-2.0',
};
write('mcp/server-card.json', serverCard);
write('mcp.json', serverCard);

const agentCard = {
  name: SERVER_INFO.title,
  description: SERVER_INFO.description,
  url: endpoint,
  version: SERVER_INFO.version,
  protocolVersion: '0.3.0',
  preferredTransport: 'JSONRPC',
  provider: { organization: 'nirholas', url: 'https://github.com/nirholas' },
  documentationUrl: SERVER_INFO.links.docs,
  iconUrl: `${SITE}/favicon.svg`,
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  securitySchemes: {},
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json', 'text/plain'],
  additionalInterfaces: [{ url: endpoint, transport: 'MCP-STREAMABLE-HTTP' }],
  skills: described.map((t) => ({
    id: t.name,
    name: t.title ?? t.name,
    description: t.description,
    tags: ['papertrade', 'liquidations', 'hyperliquid', 'read-only'],
    inputModes: ['application/json'],
    outputModes: ['application/json', 'text/plain'],
    examples: [`Call ${t.name} through the MCP server at ${endpoint}`],
  })),
};
write('agent-card.json', agentCard);
write('agent.json', agentCard);

write('api-catalog', {
  linkset: [
    {
      anchor: `${SITE}/api/heatmap`,
      'service-desc': [{ href: `${SITE}/openapi.json`, type: 'application/vnd.oai.openapi+json' }],
      'service-doc': [{ href: `${SITE}/docs/reference`, type: 'text/html' }],
    },
    {
      anchor: endpoint,
      'service-desc': [{ href: `${SITE}/.well-known/mcp/server-card.json`, type: 'application/json' }],
      'service-doc': [{ href: `${SITE}/docs/mcp`, type: 'text/html' }],
    },
    {
      anchor: `${SITE}/docs/`,
      'service-doc': [
        { href: `${SITE}/docs/`, type: 'text/html' },
        { href: `${SITE}/llms.txt`, type: 'text/plain' },
        { href: `${SITE}/llms-full.txt`, type: 'text/plain' },
      ],
    },
  ],
});
console.log(`discovery: ${described.length} tools`);
