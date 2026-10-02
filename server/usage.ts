import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { agentEnv } from './env.ts';
import { publish } from './bus.ts';
import { runningCount } from './runner.ts';

/**
 * How much of the Claude plan is left: the 5-hour and weekly windows `/usage` shows.
 * Read with the SDK's (experimental) usage call on a prompt-less session, which spawns
 * a Claude Code process for a second or two but makes no model request. Agents' live
 * rate-limit events update it in between.
 */

export type Window = { used: number | null; resetsAt: string | null };
export type PlanUsage = {
  available: boolean;
  plan: string | null;
  fiveHour: Window | null;
  week: Window | null;
  /** Set when a run hit the limit, until it resets. */
  limited: { window: string; resetsAt: string | null } | null;
  checkedAt: string | null;
  error: string | null;
};

let usage: PlanUsage = { available: false, plan: null, fiveHour: null, week: null, limited: null, checkedAt: null, error: null };
let inFlight = false;

export const planUsage = () => usage;

function set(patch: Partial<PlanUsage>) {
  usage = { ...usage, ...patch };
  publish({ type: 'usage', usage });
}

const win = (w?: { utilization: number | null; resets_at: string | null } | null): Window | null =>
  w ? { used: w.utilization, resetsAt: w.resets_at } : null;

export async function refreshUsage() {
  if (inFlight) return;
  // The droplet is small: don't add a process while both agent slots are busy; events keep it current.
  if (runningCount() >= 2 && usage.checkedAt) return;
  inFlight = true;
  const abort = new AbortController();
  try {
    const idle = (async function* () {
      await new Promise((resolve) => abort.signal.addEventListener('abort', resolve));
    })() as AsyncIterable<never>;
    const q = query({ prompt: idle, options: { abortController: abort, settingSources: [], persistSession: false, maxTurns: 1, env: agentEnv() } });
    const r = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, j) => setTimeout(() => j(new Error('timed out')), 30_000)),
    ]);
    const rl = r.rate_limits;
    const fiveHour = win(rl?.five_hour);
    const week = win(rl?.seven_day);
    const stillLimited = usage.limited?.resetsAt && Date.parse(usage.limited.resetsAt) > Date.now() ? usage.limited : null;
    set({ available: r.rate_limits_available && !!rl, plan: r.subscription_type, fiveHour, week, limited: stillLimited, checkedAt: new Date().toISOString(), error: null });
  } catch (e) {
    set({ error: (e as Error).message.split('\n')[0], checkedAt: new Date().toISOString() });
  } finally {
    abort.abort();
    inFlight = false;
  }
}

/** Feed every SDK message from agent runs and chats through here. */
export function noteMessage(msg: SDKMessage) {
  if (msg.type !== 'rate_limit_event') return;
  const i = msg.rate_limit_info;
  const resetsAt = i.resetsAt ? new Date(i.resetsAt * 1000).toISOString() : null;
  const patch: Partial<PlanUsage> = {};
  if (typeof i.utilization === 'number') {
    const pct = i.utilization <= 1 ? i.utilization * 100 : i.utilization;
    if (i.rateLimitType === 'five_hour') patch.fiveHour = { used: pct, resetsAt: resetsAt ?? usage.fiveHour?.resetsAt ?? null };
    if (i.rateLimitType === 'seven_day') patch.week = { used: pct, resetsAt: resetsAt ?? usage.week?.resetsAt ?? null };
  }
  if (i.status === 'rejected') patch.limited = { window: i.rateLimitType ?? 'plan', resetsAt };
  if (Object.keys(patch).length) set(patch);
}

export function startUsageTracker() {
  refreshUsage();
  setInterval(refreshUsage, 5 * 60_000).unref();
}
