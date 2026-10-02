import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR, API_KEY_AVAILABLE, MAX_CONCURRENT, BRAND, HOST, LIBRARY_DIR, MAX_UPLOAD_BYTES, OUTPUTS_DIR, OWNER, PORT, PUBLIC_ORIGIN, UI_DIR, CREW_ROOT } from './config.ts';
import { notify, viewerConnected } from './notify.ts';
import * as db from './db.ts';
import { publish, subscribe } from './bus.ts';
import { getAgent, listSkills, loadRoster, managerAgent, readMemory, setAgentFlag, setAgentSkills, writeMemory } from './roster.ts';
import { skillsAssistant } from './skills-ai.ts';
import { assistantAgent, chatTurn, isChatBusy, stopChat } from './assistant.ts';
import { stringify as toYaml } from 'yaml';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { agentEnv } from './env.ts';
import { OFFICIAL_REPO, deleteSkill, githubCatalog, importFromGitHub, importLocal, importMarkdown, localCatalog, skillSource } from './skills-library.ts';
import { busyAgents, decide, isAgentBusy, maybeCloseParent, stopTask } from './runner.ts';
import { kick, runNow, startScheduler } from './scheduler.ts';
import { cleanName, contentType, libraryReady, listTree, removeTaskDir, safeJoin, taskDir, taskFiles } from './files.ts';
import { refreshSite, siteStatus, startSiteRefresh } from './site.ts';
import { AUTH_ON, gate } from './auth.ts';
import { planUsage, refreshUsage, startUsageTracker } from './usage.ts';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => Promise<void> | void;
const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, pathSpec: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + pathSpec.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern, keys, handler });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body<T>(req: http.IncomingMessage): Promise<T> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return (raw ? JSON.parse(raw) : {}) as T;
}

function agentsView() {
  const busy = new Set(busyAgents());
  const waiting = new Set(db.pendingApprovals().map((a) => a.agent_id));
  return loadRoster().map((a) => ({
    ...a,
    state: a.kind === 'assistant'
      ? (db.listChats().some((c) => isChatBusy(c.id)) ? 'working' : 'idle')
      : waiting.has(a.id) ? 'waiting' : busy.has(a.id) ? 'working' : 'idle',
    monthSpend: a.kind === 'assistant' ? db.chatSpendThisMonth() : db.monthSpend(a.id),
    memoryLines: readMemory(a.id).split('\n').filter((l) => l.trim()).length,
  }));
}

/** Stream a request body to a file, refusing anything over the upload limit. */
async function saveUpload(req: http.IncomingMessage, file: string) {
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) throw new Error(`Files over ${MAX_UPLOAD_BYTES / 1e6} MB aren't accepted`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.uploading`;
  const out = fs.createWriteStream(tmp);
  let n = 0;
  try {
    for await (const chunk of req) {
      n += chunk.length;
      if (n > MAX_UPLOAD_BYTES) throw new Error(`Files over ${MAX_UPLOAD_BYTES / 1e6} MB aren't accepted`);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise<void>((r, j) => out.end((e?: Error) => (e ? j(e) : r())));
    fs.renameSync(tmp, file);
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return n;
}

function sendFile(res: http.ServerResponse, file: string, download: boolean) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, {
    'content-type': contentType(file),
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
  });
  fs.createReadStream(file).pipe(res);
}

const qs = (req: http.IncomingMessage) => new URL(req.url ?? '', 'http://x').searchParams;

// ---------- API ----------

route('GET', '/api/state', (_req, res) => {
  json(res, 200, {
    authOn: AUTH_ON,
    usage: planUsage(),
    agents: agentsView(),
    tasks: db.listTasks(),
    approvals: db.pendingApprovals(),
    settings: db.getSettings(),
    apiKeyAvailable: API_KEY_AVAILABLE,
    owner: OWNER,
    brand: BRAND,
    site: siteStatus(),
    teams: [...new Set(loadRoster().map((a) => a.team).filter(Boolean))],
    chats: db.listChats().slice(0, 8).map((c) => ({ id: c.id, title: c.title, updated_at: c.updated_at, busy: isChatBusy(c.id) })),
  });
});

route('GET', '/api/tasks/:id', (_req, res, { id }) => {
  const task = db.getTask(id);
  if (!task) return json(res, 404, { error: 'Not found' });
  json(res, 200, { task, events: db.listEvents(id), children: db.childTasks(id), files: taskFiles(id) });
});

route('POST', '/api/tasks', async (req, res) => {
  const b = await body<{ title?: string; description?: string; agentId?: string }>(req);
  if (!b.title?.trim()) return json(res, 400, { error: 'Title is required' });
  const agent = getAgent(b.agentId || managerAgent().id);
  if (!agent) return json(res, 400, { error: `Unknown agent ${b.agentId}` });
  if (agent.kind === 'assistant') return json(res, 400, { error: `${agent.name} can't be assigned tasks. Ask it questions from the Ask ${agent.name} panel.` });
  const task = db.createTask({ agent_id: agent.id, title: b.title.trim(), description: b.description ?? '' });
  // Autorun waits a moment so files attached in the same submit land before the agent starts.
  setTimeout(kick, 1500);
  publish({ type: 'task', task });
  json(res, 201, task);
});

/** Attach a file to a task: it lands in the task's folder, where the agent works. */
route('POST', '/api/tasks/:id/files', async (req, res, { id }) => {
  if (!db.getTask(id)) return json(res, 404, { error: 'Not found' });
  const name = cleanName(qs(req).get('name') ?? '');
  try {
    await saveUpload(req, path.join(taskDir(id), name));
  } catch (e) {
    return json(res, 413, { error: (e as Error).message });
  }
  publish({ type: 'files', taskId: id });
  json(res, 201, { name, files: taskFiles(id) });
});

route('GET', '/api/tasks/:id/files', (_req, res, { id }) => json(res, 200, taskFiles(id)));

route('DELETE', '/api/tasks/:id', async (_req, res, { id }) => {
  const task = db.getTask(id);
  if (!task) return json(res, 404, { error: 'Not found' });
  for (const kid of db.childTasks(id)) if (kid.status === 'running') return json(res, 409, { error: 'Stop its subtasks first' });
  if (task.status === 'running') {
    db.updateTask(id, { status: 'cancelled' });
    stopTask(id);
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (const t of [...db.childTasks(id), task]) {
    removeTaskDir(t.id);
    db.deleteTask(t.id);
  }
  publish({ type: 'agents' });
  publish({ type: 'task', task: { id, deleted: true } });
  json(res, 200, { ok: true });
});

// ---------- Sage (assistant chat) ----------

route('GET', '/api/chats', (_req, res) => {
  json(res, 200, db.listChats().map((c) => ({ ...c, busy: isChatBusy(c.id) })));
});

route('GET', '/api/chats/:id', (_req, res, { id }) => {
  const chat = db.getChat(id);
  if (!chat) return json(res, 404, { error: 'Not found' });
  json(res, 200, { chat: { ...chat, busy: isChatBusy(id) }, messages: db.chatMessages(id) });
});

function startTurn(chatId: string, text: string) {
  const sage = assistantAgent();
  if (sage && db.chatSpendThisMonth() >= sage.monthlyBudgetUsd) {
    const m = db.addChatMessage(chatId, 'error', `${sage.name} is over its monthly budget ($${sage.monthlyBudgetUsd}). Raise monthlyBudgetUsd in agents/${sage.id}.md.`);
    publish({ type: 'chat', chatId, message: m });
    return;
  }
  chatTurn(chatId, text).catch((e) => console.error('[sage]', e.message));
}

route('POST', '/api/chats', async (req, res) => {
  const { text } = await body<{ text?: string }>(req);
  if (!text?.trim()) return json(res, 400, { error: 'Ask something' });
  const chat = db.createChat(text.trim().split('\n')[0]);
  startTurn(chat.id, text.trim());
  json(res, 201, chat);
});

route('POST', '/api/chats/:id/messages', async (req, res, { id }) => {
  const { text } = await body<{ text?: string }>(req);
  if (!db.getChat(id)) return json(res, 404, { error: 'Not found' });
  if (!text?.trim()) return json(res, 400, { error: 'Ask something' });
  if (isChatBusy(id)) return json(res, 409, { error: 'Still answering. Wait or stop it.' });
  startTurn(id, text.trim());
  json(res, 202, { ok: true });
});

route('POST', '/api/chats/:id/stop', (_req, res, { id }) => {
  stopChat(id);
  json(res, 200, { ok: true });
});

route('DELETE', '/api/chats/:id', (_req, res, { id }) => {
  if (isChatBusy(id)) stopChat(id);
  db.deleteChat(id);
  json(res, 200, { ok: true });
});

/** One click on a task Sage drafted: it goes into Queued like any other task. */
route('POST', '/api/chats/:id/drafts/:msg/queue', async (_req, res, { id, msg }) => {
  const m = db.chatMessages(id).find((x) => String(x.id) === msg && x.role === 'draft');
  if (!m) return json(res, 404, { error: 'Not found' });
  if (m.data?.queued) return json(res, 409, { error: 'Already queued' });
  const d = m.data;
  const agent = d.agent_id === 'manager' ? managerAgent() : getAgent(d.agent_id);
  if (!agent) return json(res, 400, { error: `Unknown agent ${d.agent_id}` });
  const task = db.createTask({ agent_id: agent.id, title: d.title, description: `${d.description}\n\n(Drafted by ${assistantAgent()?.name ?? 'the assistant'} from a conversation with ${OWNER}.)` });
  db.updateChatMessageData(m.id, { ...d, queued: task.id });
  publish({ type: 'task', task });
  publish({ type: 'chat', chatId: id, message: { ...m, data: { ...d, queued: task.id } } });
  kick();
  json(res, 201, task);
});

// ---------- library ----------

route('GET', '/api/library', (_req, res) => json(res, 200, listTree(libraryReady())));

/** Upload into a library folder: ?dir=forms/bcfsa&name=file.pdf */
route('POST', '/api/library/upload', async (req, res) => {
  const dir = safeJoin(libraryReady(), qs(req).get('dir') ?? '');
  if (!dir) return json(res, 400, { error: 'Bad folder' });
  if (dir.startsWith(path.join(LIBRARY_DIR, 'website'))) return json(res, 400, { error: 'The website folder is rebuilt automatically; upload somewhere else.' });
  const name = cleanName(qs(req).get('name') ?? '');
  try {
    await saveUpload(req, path.join(dir, name));
  } catch (e) {
    return json(res, 413, { error: (e as Error).message });
  }
  publish({ type: 'library' });
  json(res, 201, { path: path.relative(LIBRARY_DIR, path.join(dir, name)) });
});

route('POST', '/api/library/folder', async (req, res) => {
  const { path: rel } = await body<{ path?: string }>(req);
  const dir = rel?.trim() && safeJoin(libraryReady(), rel.trim().split('/').map(cleanName).join('/'));
  if (!dir) return json(res, 400, { error: 'Give the folder a name' });
  fs.mkdirSync(dir, { recursive: true });
  publish({ type: 'library' });
  json(res, 201, { path: path.relative(LIBRARY_DIR, dir) });
});

/** Delete one library file (not folders, not READMEs, not the website snapshot). */
route('DELETE', '/api/library', (req, res) => {
  const file = safeJoin(libraryReady(), qs(req).get('path') ?? '');
  if (!file || file === LIBRARY_DIR || !fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
  if (fs.statSync(file).isDirectory()) {
    if (fs.readdirSync(file).length) return json(res, 400, { error: 'Only empty folders can be removed' });
    fs.rmdirSync(file);
  } else {
    if (/^README\.md$/i.test(path.basename(file))) return json(res, 400, { error: "READMEs tell the agents what's in a folder; edit instead of deleting" });
    if (file.startsWith(path.join(LIBRARY_DIR, 'website') + path.sep)) return json(res, 400, { error: 'The website folder is rebuilt automatically' });
    fs.rmSync(file);
  }
  publish({ type: 'library' });
  json(res, 200, { ok: true });
});

// ---------- website snapshot ----------

const siteChanged = () => publish({ type: 'site', status: siteStatus() });

route('GET', '/api/site', (_req, res) => json(res, 200, siteStatus()));

route('POST', '/api/usage/refresh', async (_req, res) => {
  await refreshUsage();
  json(res, 200, planUsage());
});

route('POST', '/api/site/refresh', (_req, res) => {
  refreshSite(siteChanged).then(() => publish({ type: 'library' }));
  json(res, 202, siteStatus());
});

// ---------- new agents ----------

function agentSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

/** "+ Agent": write agents/<id>.md and an empty memory file. Applies on the next request; no restart. */
route('POST', '/api/agents', async (req, res) => {
  const b = await body<{
    name?: string; title?: string; team?: string; description?: string; instructions?: string;
    canva?: boolean; drive?: boolean; calendar?: boolean; model?: string; effort?: string;
    taskBudgetUsd?: number; monthlyBudgetUsd?: number; skills?: string[];
  }>(req);
  const name = b.name?.trim();
  if (!name) return json(res, 400, { error: 'Give the agent a name' });
  const id = agentSlug(name);
  if (!id) return json(res, 400, { error: 'That name needs some letters' });
  if (loadRoster().some((a) => a.id === id || a.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: `There's already an agent called ${name}` });
  if (!b.title?.trim() || !b.description?.trim()) return json(res, 400, { error: 'Title and "what it does" are required' });
  const known = new Set(listSkills().map((s) => s.name));
  const fm: Record<string, unknown> = {
    name, title: b.title.trim(), kind: 'specialist', ...(b.team?.trim() ? { team: b.team.trim() } : {}),
    order: 90, description: b.description.trim(), ...(b.canva ? { canva: true } : {}), ...(b.drive ? { drive: true } : {}), ...(b.calendar ? { calendar: true } : {}),
    model: ['opus', 'sonnet', 'haiku'].includes(b.model ?? '') ? b.model : 'opus',
    effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort ?? '') ? b.effort : 'high',
    taskBudgetUsd: Math.min(Math.max(Number(b.taskBudgetUsd) || 10, 1), 100),
    monthlyBudgetUsd: Math.min(Math.max(Number(b.monthlyBudgetUsd) || 200, 10), 2000),
    ...((b.skills ?? []).filter((s) => known.has(s)).length ? { skills: (b.skills ?? []).filter((s) => known.has(s)) } : {}),
  };
  const body_ = (b.instructions?.trim() || b.description.trim()) + '\n';
  fs.writeFileSync(path.join(AGENTS_DIR, `${id}.md`), `---\n${toYaml(fm, { flowCollectionPadding: false }).trimEnd()}\n---\n${body_}`);
  writeMemory(id, '');
  publish({ type: 'agents' });
  json(res, 201, getAgent(id));
});

/** Draft an agent's instructions from its name and role. */
route('POST', '/api/agents/draft', async (req, res) => {
  const b = await body<{ name?: string; title?: string; description?: string; team?: string }>(req);
  if (!b.title?.trim() || !b.description?.trim()) return json(res, 400, { error: 'Fill in the title and what it does first' });
  const example = fs.readFileSync(path.join(AGENTS_DIR, 'listing.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
  let text = '';
  for await (const msg of query({
    prompt: `Write the instructions (markdown body only, no frontmatter, no heading) for a new specialist agent on a BC (Canada) realtor's AI crew.
Name: ${b.name}. Title: ${b.title}. Team: ${b.team || 'none'}.
What it does: ${b.description}

Look in the library (library/README.md and its folders) if useful, so the instructions point at real reference material. Write in second person ("You handle..."), 120-300 words: what it does, what matters (BC rules, accuracy, brand), what it delivers as files, how it checks its work, and which other crew agents handle neighbouring work. Match the tone of this existing agent:\n\n${example}\n\nReply with only the instructions.`,
    options: {
      cwd: LIBRARY_DIR, model: 'opus', effort: 'medium', maxTurns: 12, maxBudgetUsd: 1,
      tools: ['Read', 'Glob', 'Grep'], settingSources: [], persistSession: false, env: agentEnv(),
      canUseTool: async (n, input) => (['Read', 'Glob', 'Grep'].includes(n) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'read only' }),
    },
  })) {
    if (msg.type === 'result' && msg.subtype === 'success') text = msg.result;
  }
  if (!text.trim()) return json(res, 500, { error: "Couldn't draft instructions; write them by hand" });
  json(res, 200, { instructions: text.trim() });
});

route('GET', '/api/skills', (_req, res) => {
  const roster = loadRoster();
  json(res, 200, listSkills().map((s) => ({
    ...s,
    origin: s.source === 'library' ? skillSource(s.name) : null,
    usedBy: roster.filter((a) => a.skills.includes(s.name)).map((a) => ({ id: a.id, name: a.name })),
  })));
});

route('GET', '/api/skills/catalog', async (req, res) => {
  const repo = new URL(req.url ?? '', 'http://x').searchParams.get('repo') || OFFICIAL_REPO;
  try {
    json(res, 200, await githubCatalog(repo));
  } catch (e) {
    json(res, 400, { error: (e as Error).message.split('\n')[0] });
  }
});

route('GET', '/api/skills/local', (_req, res) => json(res, 200, localCatalog()));

route('POST', '/api/skills/import', async (req, res) => {
  const b = await body<{ from?: 'github' | 'local' | 'markdown'; repo?: string; path?: string; content?: string; filename?: string; overwrite?: boolean; enableFor?: string }>(req);
  try {
    let out: { name: string };
    if (b.from === 'github') out = await importFromGitHub(b.repo || OFFICIAL_REPO, b.path ?? '', !!b.overwrite);
    else if (b.from === 'local') out = importLocal(b.path ?? '', !!b.overwrite);
    else if (b.from === 'markdown') out = importMarkdown(b.content ?? '', b.filename, !!b.overwrite);
    else return json(res, 400, { error: 'from must be github, local or markdown' });
    const agent = b.enableFor ? getAgent(b.enableFor) : undefined;
    if (agent && !agent.skills.includes(out.name)) setAgentSkills(agent.id, [...agent.skills, out.name]);
    publish({ type: 'agents' });
    json(res, 201, out);
  } catch (e) {
    json(res, 400, { error: (e as Error).message.split('\n')[0] });
  }
});

route('DELETE', '/api/skills/:name', (_req, res, { name }) => {
  try {
    deleteSkill(name);
    publish({ type: 'agents' });
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

route('PUT', '/api/agents/:id/skills', async (req, res, { id }) => {
  if (!getAgent(id)) return json(res, 404, { error: 'Not found' });
  const { skills } = await body<{ skills?: string[] }>(req);
  const known = new Set(listSkills().map((s) => s.name));
  const bad = (skills ?? []).filter((s) => !known.has(s));
  if (bad.length) return json(res, 400, { error: `Unknown skills: ${bad.join(', ')}` });
  setAgentSkills(id, skills ?? []);
  publish({ type: 'agents' });
  json(res, 200, getAgent(id));
});

route('POST', '/api/agents/:id/skills/ai', async (req, res, { id }) => {
  if (!getAgent(id)) return json(res, 404, { error: 'Not found' });
  const { request } = await body<{ request?: string }>(req);
  if (!request?.trim()) return json(res, 400, { error: 'Say what you want' });
  try {
    const out = await skillsAssistant(id, request.trim());
    publish({ type: 'agents' });
    json(res, 200, out);
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

route('POST', '/api/tasks/:id/run', (_req, res, { id }) => {
  const err = runNow(id);
  if (err) return json(res, 409, { error: err });
  json(res, 200, { ok: true });
});

route('POST', '/api/tasks/:id/message', async (req, res, { id }) => {
  const { text } = await body<{ text?: string }>(req);
  const task = db.getTask(id);
  if (!task) return json(res, 404, { error: 'Not found' });
  if (!text?.trim()) return json(res, 400, { error: 'Empty message' });
  if (task.status === 'running') return json(res, 409, { error: 'The agent is mid-run. Wait for it to finish or stop it first.' });
  const updated = db.updateTask(id, { status: 'queued', pending_prompt: text.trim(), status_note: null });
  publish({ type: 'task', task: updated });
  if (!db.getSettings().autorun && !isAgentBusy(updated.agent_id)) runNow(id);
  kick();
  json(res, 200, updated);
});

route('POST', '/api/tasks/:id/cancel', (_req, res, { id }) => {
  const task = db.getTask(id);
  if (!task) return json(res, 404, { error: 'Not found' });
  const updated = db.updateTask(id, { status: 'cancelled', status_note: 'Stopped' });
  stopTask(id);
  publish({ type: 'task', task: updated });
  publish({ type: 'agents' });
  json(res, 200, updated);
});

route('POST', '/api/tasks/:id/done', async (req, res, { id }) => {
  const task = db.getTask(id);
  if (!task) return json(res, 404, { error: 'Not found' });
  if (task.status === 'running') return json(res, 409, { error: 'Still running' });
  const updated = db.updateTask(id, { status: 'done' });
  publish({ type: 'task', task: updated });
  maybeCloseParent(updated);
  json(res, 200, updated);
});

route('POST', '/api/approvals/:id', async (req, res, { id }) => {
  const { allow, note } = await body<{ allow?: boolean; note?: string }>(req);
  const a = decide(id, !!allow, note?.trim() || null);
  if (!a) return json(res, 404, { error: 'Not found' });
  publish({ type: 'agents' });
  json(res, 200, a);
});

route('GET', '/api/agents/:id', (_req, res, { id }) => {
  const agent = agentsView().find((a) => a.id === id);
  if (!agent) return json(res, 404, { error: 'Not found' });
  json(res, 200, { agent, memory: readMemory(id) });
});

route('PUT', '/api/agents/:id/flags', async (req, res, { id }) => {
  if (!getAgent(id)) return json(res, 404, { error: 'Not found' });
  const b = await body<{ canva?: boolean; drive?: boolean; calendar?: boolean }>(req);
  for (const k of ['canva', 'drive', 'calendar'] as const) if (typeof b[k] === 'boolean') setAgentFlag(id, k, b[k]);
  publish({ type: 'agents' });
  json(res, 200, getAgent(id));
});

route('PUT', '/api/agents/:id/memory', async (req, res, { id }) => {
  if (!getAgent(id)) return json(res, 404, { error: 'Not found' });
  const { content } = await body<{ content?: string }>(req);
  writeMemory(id, content ?? '');
  publish({ type: 'agents' });
  json(res, 200, { ok: true });
});

route('POST', '/api/notify/test', (_req, res) => {
  notify({ title: 'Notifications are on', body: "You'll hear when an agent needs you or finishes.", url: '/', tag: 'test' }, { force: true });
  json(res, 200, { ok: true });
});

route('POST', '/api/settings', async (req, res) => {
  const b = await body<{ autorun?: boolean; maxConcurrent?: number; useApiKey?: boolean; notifications?: boolean; startGapSeconds?: number }>(req);
  if (typeof b.notifications === 'boolean') db.setSetting('notifications', b.notifications);
  if (typeof b.startGapSeconds === 'number' && b.startGapSeconds >= 0 && b.startGapSeconds <= 600) db.setSetting('startGapSeconds', Math.round(b.startGapSeconds));
  if (b.useApiKey === true && !API_KEY_AVAILABLE) {
    return json(res, 400, { error: 'Start the server with ANTHROPIC_API_KEY set (in .env) before turning on API billing.' });
  }
  if (typeof b.useApiKey === 'boolean') db.setSetting('useApiKey', b.useApiKey);
  if (typeof b.autorun === 'boolean') db.setSetting('autorun', b.autorun);
  if (typeof b.maxConcurrent === 'number' && b.maxConcurrent >= 1 && b.maxConcurrent <= MAX_CONCURRENT) db.setSetting('maxConcurrent', Math.floor(b.maxConcurrent));
  const settings = db.getSettings();
  publish({ type: 'settings', settings });
  kick();
  json(res, 200, settings);
});

route('GET', '/api/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': connected\n\n');
  const off = subscribe((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
  const gone = viewerConnected();
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    off();
    gone();
    clearInterval(ping);
  });
});

// ---------- static UI ----------

const VENDOR: Record<string, string> = {
  '/vendor/preact.mjs': 'node_modules/preact/dist/preact.mjs',
  '/vendor/hooks.mjs': 'node_modules/preact/hooks/dist/hooks.mjs',
  '/vendor/htm.mjs': 'node_modules/htm/dist/htm.mjs',
};
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(urlPath: string, res: http.ServerResponse) {
  const file = VENDOR[urlPath]
    ? path.join(CREW_ROOT, VENDOR[urlPath])
    : path.join(UI_DIR, urlPath === '/' ? 'index.html' : path.normalize(urlPath));
  if (!file.startsWith(UI_DIR) && !VENDOR[urlPath]) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) {
      // Client-side routes fall back to the app shell.
      if (!path.extname(urlPath)) return serveStatic('/', res);
      return json(res, 404, { error: 'Not found' });
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  // Agents can run shell commands: only accept writes from our own page.
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    const ok = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, PUBLIC_ORIGIN].filter(Boolean);
    if (origin && !ok.includes(origin)) return json(res, 403, { error: 'Cross-origin request refused' });
  }
  if (await gate(req, res, url)) return;
  // Downloads: /files/library/<path> and /files/task/<id>/<path>. ?dl=1 forces a download.
  if (url.pathname.startsWith('/files/')) {
    const rest = decodeURIComponent(url.pathname.slice('/files/'.length));
    const dl = url.searchParams.has('dl');
    if (rest.startsWith('library/')) {
      const file = safeJoin(LIBRARY_DIR, rest.slice('library/'.length));
      return file ? sendFile(res, file, dl) : json(res, 404, { error: 'Not found' });
    }
    const m = rest.match(/^task\/([a-z0-9-]+)\/(.+)$/i);
    const file = m && safeJoin(path.join(OUTPUTS_DIR, m[1]), m[2]);
    return file ? sendFile(res, file, dl) : json(res, 404, { error: 'Not found' });
  }
  if (url.pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        await r.handler(req, res, params);
      } catch (e) {
        console.error(e);
        if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      }
      return;
    }
    return json(res, 404, { error: 'No such endpoint' });
  }
  serveStatic(url.pathname, res);
});

db.recoverAfterRestart();
db.expireOrphanedApprovals();
libraryReady();
server.listen(PORT, HOST, () => {
  console.log(`Realty crew running at http://localhost:${PORT}  (library: ${LIBRARY_DIR})`);
  console.log(AUTH_ON ? 'Login required (CREW_PASSWORD is set).' : 'No login: set CREW_PASSWORD before exposing this anywhere but localhost.');
  console.log(API_KEY_AVAILABLE ? 'ANTHROPIC_API_KEY is set; agents use it only while the API key toggle is on.' : 'Agents use the claude.ai login.');
  startScheduler();
  startSiteRefresh(siteChanged);
  startUsageTracker();
});
