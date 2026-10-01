import * as db from './db.ts';
import { publish } from './bus.ts';

/**
 * Desktop notifications. Open crew pages get a `notify` message and show a
 * browser notification (or an in-page toast when focused). The server runs
 * headless on the droplet, so nothing shows when no page is open.
 */

let viewers = 0;
export function viewerConnected() {
  viewers++;
  return () => {
    viewers = Math.max(0, viewers - 1);
  };
}

export type Notice = {
  title: string;
  body: string;
  /** Hash route to open on click, e.g. "/task/abc123". */
  url?: string;
  /** Same tag replaces an earlier notification instead of stacking. */
  tag?: string;
  /** needs-you notices are louder. */
  urgent?: boolean;
};

const recent = new Map<string, number>();

export function notify(n: Notice, opts: { force?: boolean } = {}) {
  if (!db.getSettings().notifications) return;
  // Don't repeat the same notice within a minute (status flaps, retries).
  const key = `${n.tag ?? ''}|${n.title}|${n.body}`;
  const last = recent.get(key);
  if (!opts.force && last && Date.now() - last < 60_000) return;
  recent.set(key, Date.now());

  publish({ type: 'notify', notice: n });
}

// ---------- what's worth a notification ----------

const STATUS_NOTICE: Partial<Record<db.TaskStatus, (t: db.Task, who: string) => Notice>> = {
  needs_input: (t, who) => ({ title: `${who} needs you`, body: t.status_note ?? t.title, urgent: true }),
  failed: (t, who) => ({ title: `${who}'s task failed`, body: `${t.title}: ${t.status_note ?? ''}`, urgent: true }),
  blocked: (t, who) => ({ title: `${who} is blocked`, body: `${t.title}: ${t.status_note ?? ''}`, urgent: true }),
  review: (t, who) => ({ title: `${who} finished`, body: t.title }),
  delegated: (t, who) => ({ title: `${who} assigned the work`, body: t.title }),
};

/** Call when a task's status changes. */
export function taskStatusChanged(before: db.Task | undefined, after: db.Task, who: string) {
  if (before?.status === after.status) return;
  const make = STATUS_NOTICE[after.status];
  if (!make) return;
  notify({ ...make(after, who), url: `/task/${after.id}`, tag: `task-${after.id}` });
}

export function approvalRequested(a: db.Approval, who: string, taskTitle: string) {
  notify({
    title: `${who} needs your OK`,
    body: `${a.reason}: ${taskTitle}`,
    url: `/task/${a.task_id}`,
    tag: `approval-${a.id}`,
    urgent: true,
  });
}
