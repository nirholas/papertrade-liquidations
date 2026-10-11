/** Landing page behaviour: the "connect your AI" client tabs with copyable snippets. */
const URL_MCP = 'https://papertrade-liquidations.pages.dev/mcp';

interface Client {
  id: string;
  label: string;
  code: string;
  note: string;
}

const CLIENTS: Client[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    code: `claude mcp add --transport http papertrade-liquidations ${URL_MCP}`,
    note: 'Run once in a terminal. Verify with /mcp inside Claude Code.',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop and claude.ai',
    code: `{\n  "mcpServers": {\n    "papertrade-liquidations": {\n      "command": "npx",\n      "args": ["-y", "mcp-remote", "${URL_MCP}"]\n    }\n  }\n}`,
    note: 'Or skip the file: Settings, Connectors, Add custom connector, and paste the server URL.',
  },
  {
    id: 'codex',
    label: 'Codex',
    code: `codex mcp add papertrade-liquidations --url ${URL_MCP}`,
    note: 'Or add [mcp_servers.papertrade-liquidations] with url = "..." to ~/.codex/config.toml.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    code: `Settings > Connectors > Advanced > Developer mode\nCreate connector\n  URL:  ${URL_MCP}\n  Auth: none`,
    note: 'Developer mode availability depends on your plan. The OpenAI Responses API uses a tool of type "mcp" with this server_url.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    code: `gemini mcp add --transport http papertrade-liquidations ${URL_MCP}`,
    note: 'Or set mcpServers.papertrade-liquidations.httpUrl in ~/.gemini/settings.json.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    code: `{\n  "mcpServers": {\n    "papertrade-liquidations": { "url": "${URL_MCP}" }\n  }\n}`,
    note: 'Save as .cursor/mcp.json in a project or ~/.cursor/mcp.json for every project.',
  },
  {
    id: 'vscode',
    label: 'VS Code',
    code: `{\n  "servers": {\n    "papertrade-liquidations": { "type": "http", "url": "${URL_MCP}" }\n  }\n}`,
    note: 'Save as .vscode/mcp.json.',
  },
];

export function initLanding(): void {
  const tabs = document.getElementById('client-tabs');
  const code = document.getElementById('client-code');
  const note = document.getElementById('client-note');
  const copy = document.getElementById('client-copy');
  const panel = document.getElementById('client-panel');
  if (!tabs || !code || !note || !copy || !panel) return;

  const buttons = CLIENTS.map((client, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.id = `tab-${client.id}`;
    b.textContent = client.label;
    b.addEventListener('click', () => select(i));
    b.addEventListener('keydown', (ev) => {
      const dir = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      ev.preventDefault();
      select((i + dir + CLIENTS.length) % CLIENTS.length, true);
    });
    tabs.appendChild(b);
    return b;
  });

  function select(index: number, focus = false): void {
    const current = CLIENTS[index];
    const tab = buttons[index];
    if (!current || !tab) return;
    buttons.forEach((b, i) => {
      b.setAttribute('aria-selected', String(i === index));
      b.tabIndex = i === index ? 0 : -1;
    });
    code!.textContent = current.code;
    note!.textContent = current.note;
    panel!.setAttribute('aria-labelledby', tab.id);
    if (focus) tab.focus();
  }
  select(0);

  copy.addEventListener('click', async () => {
    const text = code.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      copy.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => (copy.textContent = 'Copy'), 1600);
  });
}
