import os from 'node:os';
import path from 'node:path';

/**
 * allow: run it.
 * ask: pause the agent until the owner allows or denies it.
 * deny: never, whatever the owner says (connectors that aren't the crew's business).
 */
export type Verdict = { action: 'allow' } | { action: 'ask'; reason: string } | { action: 'deny'; reason: string };

export type PolicyContext = {
  /** The task's output folder: the agent writes here freely. */
  writableRoot: string | null;
  /** claude.ai connectors this agent may use (from its frontmatter). */
  connectors: Connector[];
};

export type Connector = 'canva' | 'drive' | 'calendar';

const ALWAYS_ALLOW = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent', 'Task', 'ToolSearch', 'Skill',
]);
const TEMP_DIRS = ['/tmp', '/private/tmp', os.tmpdir()];
const FILE_WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Sends something to someone, or changes something outside the box: the agent waits for Allow/Deny.
const RISKY_BASH: Array<[RegExp, string]> = [
  [/\bsudo\b/, 'Uses sudo'],
  [/\bcurl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|--form|\s-F\s)/, 'Sends data to a remote server'],
  [/\b(sendmail|mail|mutt|msmtp)\b/, 'Sends email'],
  [/\b(aws|gcloud|kubectl|doctl|ssh|scp|rsync)\b/, 'Connects to another machine'],
  [/\brm\s+-[a-zA-Z]*r/, 'Recursive delete'],
  [/\bgit\s+push\b/, 'Pushes to a remote'],
];

function inside(root: string, p: string) {
  const abs = path.resolve(root, p);
  return abs === root || abs.startsWith(root + path.sep);
}

const CONNECTOR_READ = /^(get|search|list|lookup|fetch|find|read|query|resolve|download|suggest|check|describe|whoami)/i;

/** Which crew connector a claude.ai connector server is, or null for ones the crew never uses (Gmail, Jira, Claude Docs...). */
export function connectorKind(server: string): Connector | null {
  if (/^canva$/i.test(server)) return 'canva';
  if (/^google_?drive$/i.test(server)) return 'drive';
  if (/^google_?calendar$/i.test(server)) return 'calendar';
  return null;
}

/**
 * What a connector call may do without asking:
 * - Canva: anything that stays in her own account (create, autofill, export); sharing, comments, moves and deletes ask.
 * - Drive: reading, and creating new files or copies; editing an existing file, sharing and trashing ask.
 * - Calendar: reading only; every change asks, since events can notify attendees.
 */
function connectorVerdict(kind: Connector, name: string): Verdict {
  if (CONNECTOR_READ.test(name)) return { action: 'allow' };
  const what = name.replace(/[-_]/g, ' ');
  if (kind === 'canva') {
    return /(share|comment|reply|delete|move|folder|publish|invite|transfer)/i.test(name) ? { action: 'ask', reason: `Canva: ${what}` } : { action: 'allow' };
  }
  if (kind === 'drive') {
    if (/^(create|copy)/i.test(name)) return { action: 'allow' };
    return { action: 'ask', reason: `Google Drive: ${what}${/share/i.test(name) ? ' (gives someone access)' : /update/i.test(name) ? ' (changes an existing file)' : ''}` };
  }
  return { action: 'ask', reason: `Google Calendar: ${what} (attendees may be notified)` };
}

export function classify(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Verdict {
  if (ALWAYS_ALLOW.has(tool) || tool.startsWith('mcp__crew__')) return { action: 'allow' };

  if (tool.startsWith('mcp__claude_ai_')) {
    const [, server = '', name = ''] = tool.match(/^mcp__claude_ai_(.+?)__(.+)$/) ?? [];
    const kind = connectorKind(server);
    if (!kind) return { action: 'deny', reason: `The ${server.replace(/_/g, ' ')} connector isn't part of this crew` };
    if (!ctx.connectors.includes(kind)) return { action: 'deny', reason: `This agent doesn't have ${server.replace(/_/g, ' ')} access. Ask a teammate who does, or deliver a file instead.` };
    if (/authenticat/i.test(name)) return { action: 'deny', reason: `${server.replace(/_/g, ' ')} isn't connected on this Claude account. Say so in your report; it's connected in claude.ai → Settings → Connectors.` };
    return connectorVerdict(kind, name);
  }

  if (FILE_WRITERS.has(tool)) {
    const file = String(input.file_path ?? input.notebook_path ?? '');
    if (ctx.writableRoot && file && inside(ctx.writableRoot, file)) return { action: 'allow' };
    if (file && TEMP_DIRS.some((d) => inside(d, file))) return { action: 'allow' };
    return { action: 'ask', reason: `Edits a file outside this task's folder: ${file || '(unknown path)'}` };
  }

  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    for (const [re, reason] of RISKY_BASH) if (re.test(cmd)) return { action: 'ask', reason };
    return { action: 'allow' };
  }

  return { action: 'ask', reason: `Uses ${tool}` };
}
