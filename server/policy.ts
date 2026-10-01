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
};

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

const CONNECTOR_READ = /^(get|search|list|lookup|fetch|find|read|query|resolve|whoami|describe)/i;
// Canva writes that only touch the owner's own Canva account (new designs, autofill, exports) run freely;
// anything that shares, comments, moves into a folder others see, or deletes waits.
const CANVA_ASK = /(share|comment|reply|delete|move|folder|publish|invite|transfer)/i;

/**
 * The claude.ai login can carry connectors that belong to someone else's work (Gmail, Drive, Jira...).
 * The crew only uses Canva.
 */
export function isAllowedConnector(server: string) {
  return /^canva$/i.test(server);
}

export function classify(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Verdict {
  if (ALWAYS_ALLOW.has(tool) || tool.startsWith('mcp__crew__')) return { action: 'allow' };

  if (tool.startsWith('mcp__claude_ai_')) {
    const [, server = '', name = ''] = tool.match(/^mcp__claude_ai_(.+?)__(.+)$/) ?? [];
    if (!isAllowedConnector(server)) return { action: 'deny', reason: `The ${server.replace(/_/g, ' ')} connector isn't part of this crew` };
    if (CONNECTOR_READ.test(name) || !CANVA_ASK.test(name)) return { action: 'allow' };
    return { action: 'ask', reason: `Canva: ${name.replace(/[-_]/g, ' ')}` };
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
