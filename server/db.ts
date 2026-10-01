import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, DB_PATH, DEFAULTS, MAX_CONCURRENT } from './config.ts';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    status_note TEXT,
    session_id TEXT,
    summary TEXT,
    pending_prompt TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    session_id TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    data TEXT,
    ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, id);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export type TaskStatus =
  | 'queued'      // waiting for the scheduler
  | 'running'
  | 'needs_input' // agent asked a question; reply to resume
  | 'review'      // agent finished; human checks the work
  | 'delegated'   // manager routed it to specialists
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'blocked';    // over budget or similar

export type Task = {
  id: string;
  parent_id: string | null;
  agent_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  status_note: string | null;
  session_id: string | null;
  summary: string | null;
  pending_prompt: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
};

export type TaskEvent = { id: number; task_id: string; ts: string; kind: string; data: unknown };

/** An agent paused on a tool call until the owner allows or denies it. */
export type Approval = {
  id: string;
  task_id: string;
  agent_id: string;
  tool: string;
  input: any;
  reason: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  note: string | null;
  created_at: string;
  decided_at: string | null;
};

const now = () => new Date().toISOString();

export function createTask(t: { agent_id: string; title: string; description?: string; parent_id?: string | null }): Task {
  const id = randomUUID().slice(0, 8);
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (id, parent_id, agent_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(id, t.parent_id ?? null, t.agent_id, t.title, t.description ?? '', ts, ts);
  return getTask(id)!;
}

export function getTask(id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function listTasks(): Task[] {
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 500').all() as Task[];
}

export function childTasks(parentId: string): Task[] {
  return db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at').all(parentId) as Task[];
}

const TASK_FIELDS = new Set(['status', 'status_note', 'session_id', 'summary', 'pending_prompt', 'agent_id']);

export function updateTask(id: string, patch: Partial<Task>): Task {
  const keys = Object.keys(patch).filter((k) => TASK_FIELDS.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (patch as Record<string, string | number | null>)[k] ?? null);
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  }
  return getTask(id)!;
}

export function addTaskCost(id: string, usd: number) {
  db.prepare('UPDATE tasks SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?').run(usd, now(), id);
}

export function nextQueued(): Task[] {
  return db.prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at`).all() as Task[];
}

export function addEvent(task_id: string, kind: string, data: unknown): TaskEvent {
  const ts = now();
  const res = db.prepare('INSERT INTO events (task_id, ts, kind, data) VALUES (?, ?, ?, ?)').run(task_id, ts, kind, JSON.stringify(data));
  return { id: Number(res.lastInsertRowid), task_id, ts, kind, data };
}

export function listEvents(task_id: string): TaskEvent[] {
  const rows = db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id').all(task_id) as Array<TaskEvent & { data: string }>;
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

export function monthSpend(agent_id: string): number {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const row = db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tasks WHERE agent_id = ? AND created_at >= ?')
    .get(agent_id, monthStart.toISOString()) as { total: number };
  return row.total;
}

type ApprovalRow = Omit<Approval, 'input'> & { input: string };

function parseApproval(r: ApprovalRow): Approval {
  return { ...r, input: JSON.parse(r.input) };
}

export function createApproval(a: { task_id: string; agent_id: string; tool: string; input: unknown; reason: string }): Approval {
  const id = randomUUID().slice(0, 8);
  db.prepare(
    `INSERT INTO approvals (id, task_id, agent_id, tool, input, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, a.task_id, a.agent_id, a.tool, JSON.stringify(a.input), a.reason, now());
  return getApproval(id)!;
}

export function getApproval(id: string): Approval | undefined {
  const r = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  return r && parseApproval(r);
}

export function pendingApprovals(): Approval[] {
  const rows = db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at`).all() as ApprovalRow[];
  return rows.map(parseApproval);
}

export function decideApproval(id: string, status: Approval['status'], note: string | null): Approval {
  db.prepare('UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?').run(status, note, now(), id);
  return getApproval(id)!;
}

export function getSettings(): typeof DEFAULTS {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) out[r.key] = JSON.parse(r.value);
  out.maxConcurrent = Math.min(Number(out.maxConcurrent) || 1, MAX_CONCURRENT);
  return out as typeof DEFAULTS;
}

export function setSetting(key: keyof typeof DEFAULTS, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

/** Runs left mid-flight by a previous server process can't be reattached; park them so a reply resumes the session. */
export function recoverAfterRestart() {
  db.prepare(
    `UPDATE tasks SET status = 'needs_input', status_note = 'Interrupted by a server restart. Send a message to resume.', updated_at = ?
     WHERE status = 'running'`,
  ).run(now());
}

/** Approvals whose agent died with the old server process can never be answered. */
export function expireOrphanedApprovals() {
  db.prepare(`UPDATE approvals SET status = 'expired', note = 'Server restarted', decided_at = ? WHERE status = 'pending'`).run(now());
}

/** Remove a task and everything recorded about it. */
export function deleteTask(id: string) {
  db.prepare('DELETE FROM events WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM approvals WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

// ---------- assistant chats ----------

export type Chat = { id: string; title: string; session_id: string | null; cost_usd: number; created_at: string; updated_at: string };
/** role: user | assistant | tool (a lookup Sage made) | draft (a task Sage suggests) | error */
export type ChatMessage = { id: number; chat_id: string; role: string; text: string; data: any; ts: string };

export function createChat(title: string): Chat {
  const id = randomUUID().slice(0, 8);
  const ts = now();
  db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title.slice(0, 80), ts, ts);
  return getChat(id)!;
}

export function getChat(id: string): Chat | undefined {
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Chat | undefined;
}

export function listChats(): Chat[] {
  return db.prepare('SELECT * FROM chats ORDER BY updated_at DESC LIMIT 100').all() as Chat[];
}

export function updateChat(id: string, patch: { session_id?: string; addCost?: number; title?: string }) {
  if (patch.session_id) db.prepare('UPDATE chats SET session_id = ? WHERE id = ?').run(patch.session_id, id);
  if (patch.title) db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(patch.title.slice(0, 80), id);
  if (patch.addCost) db.prepare('UPDATE chats SET cost_usd = cost_usd + ? WHERE id = ?').run(patch.addCost, id);
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now(), id);
  return getChat(id)!;
}

export function addChatMessage(chat_id: string, role: string, text: string, data?: unknown): ChatMessage {
  const ts = now();
  const res = db.prepare('INSERT INTO chat_messages (chat_id, role, text, data, ts) VALUES (?, ?, ?, ?, ?)').run(chat_id, role, text, data === undefined ? null : JSON.stringify(data), ts);
  return { id: Number(res.lastInsertRowid), chat_id, role, text, data, ts };
}

export function updateChatMessageData(id: number, data: unknown) {
  db.prepare('UPDATE chat_messages SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
}

export function chatMessages(chat_id: string): ChatMessage[] {
  const rows = db.prepare('SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id').all(chat_id) as Array<ChatMessage & { data: string | null }>;
  return rows.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
}

export function deleteChat(id: string) {
  db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(id);
  db.prepare('DELETE FROM chats WHERE id = ?').run(id);
}

/** Sage's spend this month, counted like an agent's. */
export function chatSpendThisMonth(): number {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  return (db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS t FROM chats WHERE created_at >= ?').get(monthStart.toISOString()) as { t: number }).t;
}
