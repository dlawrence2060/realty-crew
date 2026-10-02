import {
  query,
  tool,
  createSdkMcpServer,
  type CanUseTool,
  type HookCallback,
  type Options,
  type SDKMessage,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BRAND, LIBRARY_DIR, OWNER, SKILLS_PLUGIN_DIR, SITE_SNAPSHOT_DIR } from './config.ts';
import { agentEnv } from './env.ts';
import { consult } from './consult.ts';
import * as db from './db.ts';
import type { Task } from './db.ts';
import { publish } from './bus.ts';
import { classify, type PolicyContext } from './policy.ts';
import { agentConnectors, appendMemory, getAgent, loadRoster, readMemory, sdkSkillIds, type AgentDef } from './roster.ts';
import { taskDir, taskFiles } from './files.ts';
import { approvalRequested, taskStatusChanged } from './notify.ts';
import { noteMessage, refreshUsage } from './usage.ts';

type Outcome = {
  status: 'done' | 'needs_input' | 'blocked';
  summary: string;
  question?: string;
};

type Running = { abort: AbortController; agentId: string };
const running = new Map<string, Running>();
const approvalWaiters = new Map<string, (allowed: boolean, note: string | null) => void>();

export function isAgentBusy(agentId: string) {
  for (const r of running.values()) if (r.agentId === agentId) return true;
  return false;
}
export function runningCount() {
  return running.size;
}
export function busyAgents() {
  return [...running.values()].map((r) => r.agentId);
}

function emitTask(task: Task) {
  publish({ type: 'task', task });
  publish({ type: 'agents' });
}

function setStatus(id: string, patch: Partial<Task>) {
  const before = db.getTask(id);
  const t = db.updateTask(id, patch);
  if (patch.status) taskStatusChanged(before, t, getAgent(t.agent_id)?.name ?? t.agent_id);
  emitTask(t);
  maybeCloseParent(t);
  return t;
}

function event(taskId: string, kind: string, data: unknown) {
  publish({ type: 'event', event: db.addEvent(taskId, kind, data) });
}

/** When every subtask of a delegated manager task is finished, the parent is too. */
export function maybeCloseParent(t: Task) {
  if (!t.parent_id) return;
  const parent = db.getTask(t.parent_id);
  if (!parent || parent.status !== 'delegated') return;
  const kids = db.childTasks(parent.id);
  if (kids.every((k) => k.status === 'done' || k.status === 'cancelled')) {
    emitTask(db.updateTask(parent.id, { status: 'done', status_note: 'All subtasks finished' }));
  }
}

// ---------- approvals ----------

export function decide(approvalId: string, allowed: boolean, note: string | null) {
  const a = db.getApproval(approvalId);
  if (!a || a.status !== 'pending') return a;
  const updated = db.decideApproval(approvalId, allowed ? 'allowed' : 'denied', note);
  publish({ type: 'approval', approval: updated });
  event(a.task_id, 'approval_decided', { id: a.id, tool: a.tool, allowed, note });
  approvalWaiters.get(approvalId)?.(allowed, note);
  approvalWaiters.delete(approvalId);
  return updated;
}

function waitForApproval(task: Task, toolName: string, input: Record<string, unknown>, reason: string, signal: AbortSignal) {
  const a = db.createApproval({ task_id: task.id, agent_id: task.agent_id, tool: toolName, input, reason });
  publish({ type: 'approval', approval: a });
  approvalRequested(a, getAgent(task.agent_id)?.name ?? task.agent_id, task.title);
  event(task.id, 'approval_requested', { id: a.id, tool: toolName, reason, input });
  emitTask(db.getTask(task.id)!);
  return new Promise<{ allowed: boolean; note: string | null }>((resolve) => {
    approvalWaiters.set(a.id, (allowed, note) => resolve({ allowed, note }));
    signal.addEventListener('abort', () => {
      if (db.getApproval(a.id)?.status === 'pending') {
        publish({ type: 'approval', approval: db.decideApproval(a.id, 'expired', 'Run stopped') });
      }
      approvalWaiters.delete(a.id);
      resolve({ allowed: false, note: 'Run stopped' });
    });
  });
}

// ---------- prompts ----------

export const GROUND_RULES = `
## Ground rules for the crew
- You work for ${OWNER}, a licensed REALTOR® with ${BRAND.name} (${BRAND.site}) in British Columbia, Canada. Her time zone is America/Vancouver (Pacific); use it for every date and time. Work in Canadian English, Canadian dollars, metric and imperial both where the market uses them (square feet for homes).
- BC context: real estate is regulated by the BC Financial Services Authority (BCFSA) under the Real Estate Services Act (RESA) and its Rules. Residential tenancies fall under the Residential Tenancy Act, administered by the Residential Tenancy Branch (RTB). Strata matters fall under the Strata Property Act. MLS® and REALTOR® are trademarks of CREA; use them correctly.
- The library at ${LIBRARY_DIR} is your reference shelf: forms, rules, brand guide, past work, market data, client files ${OWNER} has added. Read library/README.md first, then the README in any folder you use. Prefer the library over memory or the web, and say which files you relied on.
- The brokerage website is snapshotted as text in ${SITE_SNAPSHOT_DIR} (team, listings, buildings, neighbourhoods, blog, testimonials). Grep it for voice, facts about the team and past listings before fetching the live site.
- Never invent facts about a property, a sale, a price, a statistic, a law or a person. If a number isn't in the material you were given or a source you can cite, leave a clearly marked placeholder like [CONFIRM: lot size] and list what's missing in your report.
- Rules and figures change (rent increase limits, tax rates, form versions, BCFSA rules). When you state one, say where it came from and its date, and flag it for ${OWNER} to confirm against the official source.
- You never contact clients, other agents, lawyers, landlords, tenants or printers yourself. You draft; ${OWNER} reviews and sends.
- Advertising must follow BCFSA rules: the brokerage name shown clearly, no misleading claims, accurate measurements with their source, and team/personal names as licensed. When in doubt, flag it.
- Privacy: client and tenant information stays in this workspace. Don't paste it into web searches.`.trim();

function memoryBlock(agent: AgentDef) {
  const mem = readMemory(agent.id).trim();
  return `## Your memory (memory/${agent.id}.md)
Notes you saved on earlier tasks. Trust but verify.
${mem || '(empty so far)'}

Call \`remember\` whenever you learn something a future you would want on day one: ${OWNER}'s preferences, a printer's specs, a recurring client need, a correction. One fact per call, short.`;
}

function rosterBlock() {
  return loadRoster()
    .filter((a) => a.kind === 'specialist')
    .map((a) => `- \`${a.id}\` (${a.name}, ${a.title}${a.team ? `, ${a.team}` : ''}): ${a.description}`)
    .join('\n');
}

function systemAppend(agent: AgentDef, task: Task, outDir: string) {
  const parts = [
    `You are ${agent.name}, ${agent.title} on ${OWNER}'s real estate crew. You are a persistent agent: you keep a memory across tasks.`,
    agent.instructions,
    GROUND_RULES,
  ];
  if (agent.kind === 'manager') {
    parts.push(`## The crew you can assign to\n${rosterBlock()}`);
  } else {
    parts.push(`## Where you work
- This task's folder is ${outDir}. It is your working directory: put every deliverable here (drafts as .md, data as .csv, anything you export). ${OWNER} downloads them from the task panel. Files ${OWNER} attached to the task are here too.
- Name files so they make sense in a download list, e.g. \`listing-remarks-1234-main-st.md\`, \`cma-1234-main-st.md\`.
- Read anything in the library; don't edit it. If something belongs in the library, put it in this task's folder and say so in your report.`);
  }
  if (agent.canva) {
    parts.push(`## Canva
You can use ${OWNER}'s Canva through the Canva connector tools (search designs and brand templates, read and autofill designs, create designs, export to PDF/PNG). Start from the brokerage's brand templates when they exist; search before creating from scratch. Creating, autofilling and exporting run freely; sharing, commenting, moving or deleting waits for ${OWNER}'s OK. Put the design's link (and any exported file) in your report. If the Canva tools aren't available, say so and deliver the copy and layout notes as files instead.`);
  }
  if (agent.drive) {
    parts.push(`## Google Drive
You can use ${OWNER}'s Google Drive through the Google Drive connector tools. Search and read her files (listing folders, past brochures, magazine drafts, client documents) when the task points to them or the library doesn't have what you need. You may create new files: when a deliverable is meant to be edited or shared in Google Docs or Sheets, create it there as well as saving the .md/.csv in the task folder, name it clearly, and put its link in your report. Editing an existing file, sharing and trashing wait for ${OWNER}'s OK; ask for those only when the task needs them. Client documents are private: don't copy them anywhere outside this task.`);
  }
  if (agent.calendar) {
    parts.push(`## Google Calendar
You can read ${OWNER}'s Google Calendar: check availability, find showings, deadlines and appointments, and line work up against them. Creating, changing or deleting events always waits for ${OWNER}'s OK, because attendees can be notified. When dates matter (subject removals, completion, notice periods, print deadlines), list the events you propose (title, date and time in Pacific time, no attendees unless asked) and add them only if the task asks you to; never invite clients or other people unless ${OWNER} explicitly said to.`);
  }
  parts.push(memoryBlock(agent));
  parts.push(`## Finishing
End every run by calling \`report\` exactly once:
- status "done" with a short summary: what you produced (file names), what you relied on, and anything ${OWNER} must check or fill in,
- status "needs_input" with a question when you need a decision or information from ${OWNER}, or
- status "blocked" when you cannot proceed, saying why.
Ask rather than guess when a fact or a client decision is missing.`);
  return parts.join('\n\n');
}

function initialPrompt(task: Task, outDir: string) {
  const lines = [`# Task: ${task.title}`];
  if (task.parent_id) {
    const parent = db.getTask(task.parent_id);
    if (parent) lines.push(`Assigned by the office manager as part of: "${parent.title}"`);
  }
  const attached = taskFiles(task.id).filter((f) => !f.dir);
  if (attached.length) lines.push(`Attached files (in ${outDir}): ${attached.map((f) => f.path).join(', ')}`);
  if (task.description.trim()) lines.push('', task.description.trim());
  return lines.join('\n');
}

// ---------- crew tools (in-process MCP server) ----------

function crewServer(agent: AgentDef, task: Task, onReport: (o: Outcome) => void) {
  const tools: Array<SdkMcpToolDefinition<any>> = [
    tool(
      'remember',
      'Save one durable fact to your persistent memory so future runs know it.',
      { note: z.string().min(3).describe('One short fact, preference, correction, or follow-up.') },
      async ({ note }) => {
        appendMemory(agent.id, note);
        event(task.id, 'memory', { note });
        publish({ type: 'agents' });
        return { content: [{ type: 'text', text: 'Saved.' }] };
      },
    ),
    tool(
      'report',
      'Finish this run with its outcome. Call exactly once, as your last action.',
      {
        status: z.enum(['done', 'needs_input', 'blocked']),
        summary: z.string().describe('What you produced (file names), what you relied on, what needs checking; or why you stopped.'),
        question: z.string().optional().describe(`For needs_input: the question for ${OWNER}.`),
      },
      async (args) => {
        onReport(args);
        return { content: [{ type: 'text', text: 'Reported. Stop here.' }] };
      },
    ),
  ];

  const mates = loadRoster().filter((a) => a.id !== agent.id && a.kind === 'specialist');
  if (mates.length && agent.kind !== 'manager') {
    tools.push(
      tool(
        'ask_teammate',
        `Ask a teammate a quick question in their area and get their answer back. They can read the library (read-only) and answer from their memory and expertise. Teammates: ${mates.map((m) => `${m.id} (${m.name}, ${m.title})`).join('; ')}.`,
        {
          agent_id: z.enum(mates.map((m) => m.id) as [string, ...string[]]),
          question: z.string().describe('Specific question with the context they need.'),
        },
        async ({ agent_id, question }) => {
          event(task.id, 'consult_asked', { to: agent_id, question });
          try {
            const { answer, cost } = await consult(agent_id, question, agent, db.getTask(task.id)!);
            db.addTaskCost(task.id, cost);
            event(task.id, 'consult_answer', { from: agent_id, answer, cost });
            return { content: [{ type: 'text', text: answer }] };
          } catch (e) {
            return { content: [{ type: 'text', text: `${agent_id} couldn't answer: ${(e as Error).message}` }], isError: true };
          }
        },
      ),
    );
  }

  if (agent.kind === 'manager') {
    tools.push(
      tool(
        'assign',
        'Create a subtask for one specialist. Split work that spans specialties into one assignment each, in order.',
        {
          agent_id: z.string().describe('Specialist id from the crew list.'),
          title: z.string(),
          instructions: z.string().describe('Everything the specialist needs: goal, facts and files provided, deadline, what "done" looks like, ordering ("after the CMA is done").'),
        },
        async ({ agent_id, title, instructions }) => {
          const target = getAgent(agent_id);
          if (!target || target.kind !== 'specialist') return { content: [{ type: 'text', text: `No specialist "${agent_id}".` }], isError: true };
          const sub = db.createTask({ agent_id, title, description: instructions, parent_id: task.id });
          // Hand the specialist the files attached to the parent task.
          const parentFiles = taskFiles(task.id).filter((f) => !f.dir);
          if (parentFiles.length) {
            const from = taskDir(task.id);
            const to = taskDir(sub.id);
            for (const f of parentFiles) {
              fs.mkdirSync(path.dirname(path.join(to, f.path)), { recursive: true });
              fs.copyFileSync(path.join(from, f.path), path.join(to, f.path));
            }
          }
          event(task.id, 'assigned', { task_id: sub.id, agent_id, title });
          emitTask(sub);
          return { content: [{ type: 'text', text: `Created subtask ${sub.id} for ${target.name}.` }] };
        },
      ),
    );
  }

  return createSdkMcpServer({ name: 'crew', version: '0.1.0', tools, alwaysLoad: true });
}

// ---------- transcript ----------

function preview(v: unknown, max = 1200) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + `… (+${s.length - max} chars)` : s;
}

function record(taskId: string, msg: SDKMessage) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    event(taskId, 'system', { model: msg.model, cwd: msg.cwd, auth: msg.apiKeySource });
    return;
  }
  if (msg.type === 'assistant') {
    const sub = msg.parent_tool_use_id !== null;
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text.trim()) event(taskId, 'text', { text: block.text, sub });
      if (block.type === 'tool_use') event(taskId, 'tool', { id: block.id, name: block.name, input: block.input, sub });
    }
    return;
  }
  if (msg.type === 'user' && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type !== 'tool_result') continue;
      const content = Array.isArray(block.content)
        ? block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
        : block.content;
      event(taskId, 'tool_result', { id: block.tool_use_id, error: !!block.is_error, text: preview(content ?? '') });
    }
    return;
  }
  if (msg.type === 'result') {
    const data: Record<string, unknown> = { subtype: msg.subtype, cost: msg.total_cost_usd, turns: msg.num_turns, ms: msg.duration_ms };
    if (msg.subtype === 'success') data.text = msg.result;
    event(taskId, 'result', data);
  }
}

// ---------- the run ----------

export async function runTask(taskId: string) {
  let task = db.getTask(taskId);
  if (!task) return;
  const agent = getAgent(task.agent_id);
  if (!agent) {
    setStatus(task.id, { status: 'failed', status_note: `Unknown agent ${task.agent_id}` });
    return;
  }

  const spent = db.monthSpend(agent.id);
  if (spent >= agent.monthlyBudgetUsd) {
    setStatus(task.id, { status: 'blocked', status_note: `${agent.name} is over its monthly budget ($${spent.toFixed(2)} of $${agent.monthlyBudgetUsd}). Raise monthlyBudgetUsd in agents/${agent.id}.md to continue.` });
    return;
  }

  const abort = new AbortController();
  running.set(task.id, { abort, agentId: agent.id });
  const outDir = taskDir(task.id);
  const prompt = task.pending_prompt ?? initialPrompt(task, outDir);
  task = setStatus(task.id, { status: 'running', status_note: null, pending_prompt: null });
  event(task.id, 'prompt', { text: prompt, resumed: !!task.session_id });

  let outcome: Outcome | undefined;
  let resultText = '';
  let failed: string | undefined;

  try {
    const policyCtx: PolicyContext = { writableRoot: agent.kind === 'manager' ? null : outDir, connectors: agentConnectors(agent) };
    const currentTask = task;

    const gate: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const v = classify(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, policyCtx);
      if (v.action === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason } };
      // 'ask' forces the permission flow (and so canUseTool) even if settings pre-allow the tool.
      return v.action === 'ask' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: v.reason } } : {};
    };

    const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
      const v = classify(toolName, input, policyCtx);
      if (v.action === 'allow') return { behavior: 'allow', updatedInput: input };
      if (v.action === 'deny') return { behavior: 'deny', message: v.reason };
      const { allowed, note } = await waitForApproval(currentTask, toolName, input, v.reason, signal);
      if (allowed) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: `${OWNER} denied this${note ? `: ${note}` : '.'} Adjust your approach or report needs_input.` };
    };

    const options: Options = {
      abortController: abort,
      cwd: outDir,
      additionalDirectories: [LIBRARY_DIR],
      model: agent.model,
      effort: agent.effort,
      maxTurns: agent.maxTurns,
      maxBudgetUsd: agent.taskBudgetUsd,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(agent, task, outDir) },
      settingSources: [],
      permissionMode: 'default',
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [gate] }] },
      mcpServers: { crew: crewServer(agent, task, (o) => (outcome = o)) },
      plugins: [{ type: 'local', path: SKILLS_PLUGIN_DIR }],
      skills: sdkSkillIds(agent),
      disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree'],
      env: agentEnv(),
      stderr: (d) => process.stderr.write(`[${task!.id}] ${d}`),
    };
    if (agent.kind === 'manager') options.tools = ['Read', 'Glob', 'Grep', 'Skill'];
    if (task.session_id) options.resume = task.session_id;

    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id !== task.session_id) {
        task = setStatus(task.id, { session_id: msg.session_id });
      }
      if (msg.type === 'result') {
        db.addTaskCost(task.id, msg.total_cost_usd ?? 0);
        if (msg.subtype === 'success') resultText = msg.result;
        else failed = `Run ended: ${msg.subtype}`;
      }
      noteMessage(msg);
      record(task.id, msg);
    }
  } catch (e) {
    failed = abort.signal.aborted ? undefined : (e as Error).message;
    if (failed) event(task.id, 'error', { text: failed });
  } finally {
    running.delete(task.id);
    refreshUsage();
  }

  const latest = db.getTask(task.id)!;
  if (latest.status === 'cancelled') {
    emitTask(latest);
    return;
  }
  publish({ type: 'files', taskId: task.id });
  if (outcome) {
    const kids = db.childTasks(task.id);
    const status: Task['status'] =
      outcome.status === 'done' ? (agent.kind === 'manager' && kids.length ? 'delegated' : 'review') : outcome.status === 'blocked' ? 'blocked' : 'needs_input';
    setStatus(task.id, {
      status,
      summary: outcome.summary,
      status_note: outcome.status === 'done' ? null : outcome.question ?? outcome.summary,
    });
  } else if (failed) {
    setStatus(task.id, { status: 'failed', status_note: failed });
  } else {
    setStatus(task.id, {
      status: 'needs_input',
      summary: resultText || latest.summary,
      status_note: 'The agent stopped without calling report. Read its last message and reply to continue.',
    });
  }
}

export function stopTask(taskId: string) {
  running.get(taskId)?.abort.abort();
}
