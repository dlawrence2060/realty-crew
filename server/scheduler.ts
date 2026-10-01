import * as db from './db.ts';
import { isAgentBusy, runningCount, runTask } from './runner.ts';

let lastStart = 0;
let wakeTimer: NodeJS.Timeout | null = null;

function start(task: db.Task) {
  lastStart = Date.now();
  // runTask marks itself running before its first await, so the busy checks below see it immediately.
  runTask(task.id)
    .catch((e) => console.error(`[${task.id}] run crashed`, e))
    .finally(kick);
}

/** Start whatever queued work fits: one run per agent, maxConcurrent overall. */
export function kick() {
  const { autorun, maxConcurrent, startGapSeconds } = db.getSettings();
  if (!autorun) return;
  // Stagger starts: at most one task leaves Queued per gap.
  const wait = lastStart + startGapSeconds * 1000 - Date.now();
  if (wait > 0) {
    if (!wakeTimer) wakeTimer = setTimeout(() => { wakeTimer = null; kick(); }, wait + 50);
    return;
  }
  for (const task of db.nextQueued()) {
    if (runningCount() >= maxConcurrent) break;
    if (isAgentBusy(task.agent_id)) continue;
    start(task);
    if (startGapSeconds > 0) {
      if (!wakeTimer) wakeTimer = setTimeout(() => { wakeTimer = null; kick(); }, startGapSeconds * 1000 + 50);
      break;
    }
  }
}

/** Manual "Run now": ignores autorun and the stagger, but still one run per agent and the concurrency cap. */
export function runNow(taskId: string): string | null {
  const task = db.getTask(taskId);
  if (!task) return 'No such task';
  if (task.status !== 'queued') return `Task is ${task.status}`;
  if (isAgentBusy(task.agent_id)) return 'That agent is already working on something';
  if (runningCount() >= db.getSettings().maxConcurrent) return `${runningCount()} agents are already working; it starts when one finishes`;
  start(task);
  return null;
}

export function startScheduler() {
  setInterval(kick, 5000).unref();
  kick();
}
