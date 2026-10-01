import { query, tool, createSdkMcpServer, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BRAND, CREW_ROOT, LIBRARY_DIR, OWNER, SITE_SNAPSHOT_DIR, SKILLS_PLUGIN_DIR } from './config.ts';
import * as db from './db.ts';
import { publish } from './bus.ts';
import { agentEnv } from './env.ts';
import { notify } from './notify.ts';
import { GROUND_RULES } from './runner.ts';
import { appendMemory, loadRoster, readMemory, sdkSkillIds, type AgentDef } from './roster.ts';

/**
 * Sage: a chat-only guide grounded in the brokerage website (a text snapshot of
 * virani.ca in the library) and the rest of the library. It reads, searches and
 * fetches, but can't change anything. When something should be done it drafts a
 * task the owner can queue with one click.
 */

const running = new Map<string, AbortController>();

export function isChatBusy(chatId: string) {
  return running.has(chatId);
}

export function stopChat(chatId: string) {
  running.get(chatId)?.abort();
}

export function assistantAgent(): AgentDef | undefined {
  return loadRoster().find((a) => a.kind === 'assistant');
}

// Read-only shell: every command in a pipeline/chain must start with one of these.
const SAFE_COMMANDS = /^(ls\b|cat\b|head\b|tail\b|wc\b|find\b|grep\b|rg\b|sed\s+-n\b|awk\b|jq\b|sort\b|uniq\b|cut\b|tr\b|echo\b|pwd\b|file\b|stat\b|du\b|tree\b|pdftotext\b|cd\s)/;

function safeShell(cmd: string) {
  if (/[>`]|\$\(/.test(cmd.replace(/2>&1|2>\/dev\/null|>\s*\/dev\/null/g, ''))) return false; // no redirects or substitutions
  if (/\b(xargs|exec|-exec|-delete|eval)\b/.test(cmd)) return false;
  return cmd.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean).every((p) => SAFE_COMMANDS.test(p));
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch', 'TodoWrite']);
const CONNECTOR_READ = /^(get|search|list|lookup|fetch|find|read|query|resolve|describe)/i;

const canUseTool: CanUseTool = async (name, input) => {
  if (READ_TOOLS.has(name) || name.startsWith('mcp__sage__')) return { behavior: 'allow', updatedInput: input };
  if (name === 'Bash' && safeShell(String(input.command ?? ''))) return { behavior: 'allow', updatedInput: input };
  // Canva reads only (find a design or template); no other connectors on the login.
  if (/^mcp__claude_ai_canva__/i.test(name) && CONNECTOR_READ.test(name.split('__').pop() ?? '')) return { behavior: 'allow', updatedInput: input };
  return {
    behavior: 'deny',
    message: 'Sage is read-only. Use Read/Grep/WebFetch, or draft_task if something needs doing.',
  };
};

function crewBlock() {
  return loadRoster()
    .filter((a) => a.kind !== 'assistant')
    .map((a) => {
      const mem = readMemory(a.id).trim();
      return `### ${a.name} (${a.id}): ${a.title}${a.team ? `, ${a.team}` : ''}
${a.description}${mem ? `\nWhat ${a.name} has learned:\n${mem}` : ''}`;
    })
    .join('\n\n');
}

function systemAppend(sage: AgentDef) {
  return [
    `You are ${sage.name}, ${sage.title} for ${OWNER} at ${BRAND.name}.`,
    sage.instructions,
    GROUND_RULES,
    `## Where your knowledge comes from
1. The website snapshot at ${SITE_SNAPSHOT_DIR}: a text copy of ${BRAND.site}, one file per page, grouped by section (team, property, building, neighbourhood, post, page, testimonial...). Start with its README.md. Grep it first for anything about the brokerage, the team, past and current listings, buildings, neighbourhoods, blog posts and voice.
2. The rest of the library at ${LIBRARY_DIR}: ${OWNER}'s reference shelf (forms, rules, brand guide, past magazines, market data). library/README.md explains the folders.
3. The live site with WebFetch (${BRAND.site}) when the snapshot looks stale or is missing a page, and WebSearch for public facts (BCFSA, RTB, BC Assessment, market news). Say when an answer came from the live web rather than the snapshot.
Cite the page URL (each snapshot file has a URL: line) or the library file you used.`,
    `## The crew (agents ${OWNER} assigns work to; you are not one of them)
The office manager routes work; specialists each produce files in their task folder. The crew app is at ${CREW_ROOT} (README.md explains it).

${crewBlock()}`,
    `## Your own memory\n${readMemory(sage.id).trim() || '(empty so far)'}`,
  ].join('\n\n');
}

function sageServer(chatId: string, sage: AgentDef) {
  const specialists = loadRoster().filter((a) => a.kind === 'specialist');
  return createSdkMcpServer({
    name: 'sage',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'remember',
        `Save one durable fact ${OWNER} taught you, or that you verified and will want next time.`,
        { note: z.string().min(3) },
        async ({ note }) => {
          appendMemory(sage.id, note);
          const m = db.addChatMessage(chatId, 'tool', `Remembered: ${note}`, { kind: 'memory' });
          publish({ type: 'chat', chatId, message: m });
          publish({ type: 'agents' });
          return { content: [{ type: 'text', text: 'Saved.' }] };
        },
      ),
      tool(
        'draft_task',
        `Suggest a task for the crew. ${OWNER} sees it as a card in this chat and can add it to the queue with one click. Use when something should be written, designed, researched or prepared.`,
        {
          title: z.string().max(120),
          description: z.string().describe('Goal, the facts and sources you found (URLs, library files), what "done" looks like.'),
          agent_id: z.enum(['manager', ...specialists.map((a) => a.id)] as [string, ...string[]]).describe('"manager" to let the office manager route it, or a specialist.'),
        },
        async (args) => {
          const m = db.addChatMessage(chatId, 'draft', args.title, { ...args, queued: null });
          publish({ type: 'chat', chatId, message: m });
          return { content: [{ type: 'text', text: 'Shown as a card that can be queued with one click. Mention it briefly.' }] };
        },
      ),
    ],
  });
}

const short = (p: string) => p.replace(LIBRARY_DIR + '/', 'library/');

function toolSummary(name: string, input: any): string {
  if (name === 'Bash') return short(input.command);
  if (input.file_path) return short(input.file_path);
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${short(String(input.path))}` : ''}`;
  if (input.query) return input.query;
  if (input.url) return input.url;
  return '';
}

/** One turn of a chat: the reply streams out as chat_delta, tools and the final text are stored. */
export async function chatTurn(chatId: string, text: string) {
  const sage = assistantAgent();
  const chat = db.getChat(chatId);
  if (!sage || !chat) throw new Error('No assistant or chat');
  if (running.has(chatId)) throw new Error('Sage is still answering');

  const userMsg = db.addChatMessage(chatId, 'user', text);
  publish({ type: 'chat', chatId, message: userMsg, busy: true });
  const abort = new AbortController();
  running.set(chatId, abort);
  let reply = '';

  try {
    for await (const msg of query({
      prompt: text,
      options: {
        abortController: abort,
        cwd: LIBRARY_DIR,
        model: sage.model,
        effort: sage.effort,
        maxTurns: sage.maxTurns,
        maxBudgetUsd: sage.taskBudgetUsd,
        resume: chat.session_id ?? undefined,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(sage) },
        settingSources: [],
        tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
        plugins: [{ type: 'local', path: SKILLS_PLUGIN_DIR }],
        skills: sdkSkillIds(sage),
        mcpServers: { sage: sageServer(chatId, sage) },
        disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'Edit', 'Write', 'NotebookEdit'],
        permissionMode: 'default',
        canUseTool,
        env: agentEnv(),
      },
    })) {
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id !== chat.session_id) {
        db.updateChat(chatId, { session_id: msg.session_id });
      }
      if (msg.type === 'stream_event' && msg.parent_tool_use_id === null) {
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          publish({ type: 'chat_delta', chatId, text: ev.delta.text });
        }
      }
      if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
        for (const b of msg.message.content) {
          if (b.type === 'text' && b.text.trim()) {
            reply += (reply ? '\n\n' : '') + b.text;
            const m = db.addChatMessage(chatId, 'assistant', b.text);
            publish({ type: 'chat', chatId, message: m, busy: true });
          }
          if (b.type === 'tool_use' && !b.name.startsWith('mcp__sage__')) {
            const name = b.name.replace(/^mcp__claude_ai_([^_]+(?:_[^_]+)*?)__/, '$1: ').replace(/[-_]/g, ' ');
            const m = db.addChatMessage(chatId, 'tool', `${name} ${toolSummary(b.name, b.input)}`.trim(), { kind: 'lookup' });
            publish({ type: 'chat', chatId, message: m, busy: true });
          }
        }
      }
      if (msg.type === 'result') {
        db.updateChat(chatId, { addCost: msg.total_cost_usd ?? 0 });
        if (msg.subtype !== 'success') {
          const m = db.addChatMessage(chatId, 'error', `Stopped: ${msg.subtype.replace(/_/g, ' ')}`);
          publish({ type: 'chat', chatId, message: m });
        }
      }
    }
  } catch (e) {
    if (!abort.signal.aborted) {
      const m = db.addChatMessage(chatId, 'error', (e as Error).message);
      publish({ type: 'chat', chatId, message: m });
    }
  } finally {
    if (!abort.signal.aborted && reply) {
      notify({ title: `${sage.name} answered`, body: reply.replace(/[*`#|_]/g, '').slice(0, 160), url: `/ask/${chatId}`, tag: `chat-${chatId}` });
    }
    running.delete(chatId);
    db.updateChat(chatId, {});
    publish({ type: 'chat', chatId, busy: false });
    publish({ type: 'agents' });
  }
  return reply;
}
