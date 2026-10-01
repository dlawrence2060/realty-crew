import { h, render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

// ---------- api ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

/** Raw file upload (the server streams it to disk). */
async function upload(url, file) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  if (hash === '#/skills') return { kind: 'skills' };
  if (hash === '#/library') return { kind: 'library' };
  if (hash === '#/new-agent') return { kind: 'newagent' };
  if (hash === '#/ask' || hash.startsWith('#/ask/')) return { kind: 'ask', id: hash.slice(6) || null };
  const [, kind, id] = hash.match(/^#\/(task|agent)\/(.+)$/) || [];
  return { kind, id };
}
const go = (path) => (location.hash = path);
const close = () => history.pushState('', '', location.pathname) || dispatchEvent(new HashChangeEvent('hashchange'));

const money = (n) => `$${(n || 0).toFixed(2)}`;
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const STATUS_LABEL = {
  queued: 'Queued', running: 'Working', needs_input: 'Needs input', review: 'Review', delegated: 'Delegated',
  done: 'Done', failed: 'Failed', cancelled: 'Cancelled', blocked: 'Blocked',
};

// ---------- app ----------

function App() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [liveEvents, setLiveEvents] = useState([]);
  const route = useHashRoute();
  const refetchTimer = useRef(0);
  const [toasts, setToasts] = useState([]);
  const notifyOn = useRef(true);

  const refetch = () => {
    clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => api('GET', '/api/state').then(setState).catch(() => {}), 120);
  };

  useEffect(() => {
    api('GET', '/api/state').then(setState);
    const es = new EventSource('/api/stream');
    es.onopen = () => {
      setConnected(true);
      refetch();
    };
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'notify') {
        if (notifyOn.current) showNotice(msg.notice, setToasts);
        return;
      }
      if (msg.type === 'event') setLiveEvents((evs) => [...evs.slice(-500), msg.event]);
      else if (msg.type === 'files' || msg.type === 'library' || msg.type === 'site') {
        dispatchEvent(new CustomEvent('crew-files', { detail: msg }));
        if (msg.type === 'site') refetch();
      }
      else if (msg.type === 'chat' || msg.type === 'chat_delta') {
        dispatchEvent(new CustomEvent('crew-chat', { detail: msg }));
        if (msg.type === 'chat' && msg.busy === false) refetch();
      } else refetch();
    };
    const tick = setInterval(refetch, 30000);
    return () => {
      es.close();
      clearInterval(tick);
    };
  }, []);

  if (state) notifyOn.current = state.settings.notifications;
  if (!state) return html`<div class="main">Loading…</div>`;
  const agentsById = Object.fromEntries(state.agents.map((a) => [a.id, a]));
  const manager = state.agents.find((a) => a.kind === 'manager');
  const specialists = state.agents.filter((a) => a.kind === 'specialist');
  const sage = state.agents.find((a) => a.kind === 'assistant');

  return html`
    <div class="top">
      <div class="brand"><span class="star">◆</span> ${state.owner && state.owner !== 'the realtor' ? `${state.owner}'s Crew` : 'Realty Crew'} <span class="brandsub">${state.brand.name}</span></div>
      <span class="spacer"></span>
      ${sage && html`<a class="btn small primary" href="#/ask">Ask ${sage.name}</a>`}
      <a class="btn small" href="#/library" title="Reference files every agent can read">Library</a>
      <a class="btn small" href="#/skills">Skills</a>
      <a class="btn small" href="#/new-agent" title="Add a new AI agent to the crew">+ Agent</a>
      <${Settings} settings=${state.settings} apiKeyAvailable=${state.apiKeyAvailable} />
      ${state.authOn && html`<a class="btn small" href="/logout">Sign out</a>`}
      <span class=${'conn' + (connected ? ' on' : '')} title=${connected ? 'Live' : 'Disconnected'}></span>
    </div>
    <div class="layout">
      <aside class="side">
        <h2>Org chart</h2>
        ${manager && html`<${AgentCard} a=${manager} mgr tasks=${state.tasks} approvals=${state.approvals} />`}
        ${sage && html`<${AgentCard} a=${sage} chats=${state.chats ?? []} />`}
        <div class="reports">
          ${teamsOf(specialists).map(([team, members]) => html`
            <section class="team" key=${team}>
              <h3>${team}</h3>
              ${members.map((a) => html`<${AgentCard} key=${a.id} a=${a} tasks=${state.tasks} approvals=${state.approvals} />`)}
            </section>
          `)}
        </div>
      </aside>
      <main class="main">
        ${state.approvals.length > 0 && html`<${Approvals} approvals=${state.approvals} tasks=${state.tasks} agents=${agentsById} />`}
        <${Composer} agents=${state.agents} />
        <${Board} tasks=${state.tasks} agents=${agentsById} approvals=${state.approvals} />
      </main>
    </div>
    ${route.kind === 'task' && html`<${TaskDrawer} id=${route.id} agents=${agentsById} approvals=${state.approvals} liveEvents=${liveEvents} tasks=${state.tasks} />`}
    ${route.kind === 'agent' && html`<${AgentDrawer} id=${route.id} tasks=${state.tasks} />`}
    ${route.kind === 'skills' && html`<${SkillsLibrary} agents=${state.agents} />`}
    ${route.kind === 'library' && html`<${LibraryDrawer} site=${state.site} />`}
    ${route.kind === 'newagent' && html`<${NewAgent} teams=${state.teams} />`}
    ${route.kind === 'ask' && sage && html`<${AskDrawer} chatId=${route.id} sage=${sage} agents=${state.agents} />`}
    <div class="toasts">
      ${toasts.map((t) => html`
        <div class=${'toast' + (t.urgent ? ' urgent' : '')} key=${t.id} onClick=${() => { if (t.url) go(t.url); setToasts((ts) => ts.filter((x) => x.id !== t.id)); }}>
          <b>${t.title}</b><div>${t.body}</div>
        </div>
      `)}
    </div>
  `;
}

const TEAM_ORDER = ['Listings', 'Magazine', 'Marketing', 'Legal & Tenancy', 'Office'];
/** Specialists grouped into team blocks, in a fixed order; anything without a team goes last. */
function teamsOf(agents) {
  const groups = new Map();
  for (const a of agents) {
    const t = a.team || 'Other';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(a);
  }
  const rank = (t) => (TEAM_ORDER.includes(t) ? TEAM_ORDER.indexOf(t) : 99);
  return [...groups.entries()].sort((x, y) => rank(x[0]) - rank(y[0]));
}

const NOTE_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='4' y='4' width='24' height='24' rx='6' fill='%23b08d57'/%3E%3Cpath d='M9 17l7-7 7 7v7h-5v-5h-4v5H9z' fill='%23141210'/%3E%3C/svg%3E";

/** System notification when the page is in the background; an in-page toast when you're looking at it. */
function showNotice(n, setToasts) {
  const looking = document.visibilityState === 'visible' && document.hasFocus();
  if (!looking && 'Notification' in window && Notification.permission === 'granted') {
    const sys = new Notification(n.title, { body: n.body, tag: n.tag, icon: NOTE_ICON, requireInteraction: !!n.urgent });
    sys.onclick = () => {
      window.focus();
      if (n.url) go(n.url);
      sys.close();
    };
    return;
  }
  const id = Math.random().toString(36).slice(2);
  setToasts((ts) => [...ts.filter((t) => t.tag !== n.tag || !n.tag).slice(-3), { ...n, id }]);
  setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), n.urgent ? 12000 : 6000);
}

function NotifyToggle({ on }) {
  const [perm, setPerm] = useState('Notification' in window ? Notification.permission : 'unsupported');
  const toggle = async (e) => {
    const want = e.target.checked;
    if (want && perm === 'default') setPerm(await Notification.requestPermission());
    await api('POST', '/api/settings', { notifications: want });
    if (want) api('POST', '/api/notify/test');
  };
  const hint = perm === 'denied'
    ? 'Browser notifications are blocked for this page; allow them in the browser\'s site settings. You still get in-page toasts.'
    : 'Notify when an agent needs you or finishes, or Sage answers';
  return html`
    <label class="ctl" title=${hint}>
      <input type="checkbox" checked=${on} onChange=${toggle} /> Notify${perm === 'denied' && on ? ' ⚠' : ''}
    </label>
  `;
}

function Settings({ settings, apiKeyAvailable }) {
  const set = (patch) => api('POST', '/api/settings', patch).catch((e) => alert(e.message));
  const toggleKey = (e) => {
    const on = e.target.checked;
    if (on && !confirm('Agents will bill the ANTHROPIC_API_KEY account instead of your Claude login. Continue?')) {
      e.target.checked = false;
      return;
    }
    set({ useApiKey: on });
  };
  return html`
    ${settings.useApiKey && apiKeyAvailable && html`<span class="pill failed" title="New runs bill the API key">API billing on</span>`}
    <label class="ctl" title=${apiKeyAvailable ? 'Bill ANTHROPIC_API_KEY instead of the Claude login (applies to new runs)' : 'Set ANTHROPIC_API_KEY in .env and restart to enable'}>
      <input type="checkbox" disabled=${!apiKeyAvailable} checked=${apiKeyAvailable && settings.useApiKey} onChange=${toggleKey} /> API key
    </label>
    <${NotifyToggle} on=${settings.notifications} />
    <label class="ctl" title="When on, queued tasks start automatically">
      <input type="checkbox" checked=${settings.autorun} onChange=${(e) => set({ autorun: e.target.checked })} /> Autorun
    </label>
    <label class="ctl" title="Seconds between starting queued tasks">
      Stagger
      <select value=${settings.startGapSeconds} onChange=${(e) => set({ startGapSeconds: Number(e.target.value) })}>
        ${[0, 10, 20, 30, 60, 120].map((n) => html`<option value=${n}>${n ? `${n}s` : 'off'}</option>`)}
      </select>
    </label>
    <label class="ctl" title="How many agents may work at the same time">
      Parallel
      <select value=${settings.maxConcurrent} onChange=${(e) => set({ maxConcurrent: Number(e.target.value) })}>
        ${[1, 2].map((n) => html`<option value=${n}>${n}</option>`)}
      </select>
    </label>
  `;
}

/** Statuses that keep a conversation in an agent's dropdown (everything before the Done column). */
const ACTIVE = new Set(['queued', 'running', 'needs_input', 'review', 'delegated', 'failed', 'blocked']);
const openCards = new Set(); // which agent cards are expanded, kept across re-renders

function AgentCard({ a, mgr, tasks = [], approvals = [], chats = [] }) {
  const [open, setOpen] = useState(openCards.has(a.id));
  const toggle = () => {
    open ? openCards.delete(a.id) : openCards.add(a.id);
    setOpen(!open);
  };
  const pct = Math.min(100, (a.monthSpend / a.monthlyBudgetUsd) * 100);
  const isSage = a.kind === 'assistant';
  const waitingIds = new Set(approvals.map((x) => x.task_id));
  const mine = isSage
    ? []
    : tasks
        .filter((t) => t.agent_id === a.id && ACTIVE.has(t.status))
        .sort((x, y) => rank(x, waitingIds) - rank(y, waitingIds) || y.updated_at.localeCompare(x.updated_at));
  const working = mine.filter((t) => t.status === 'running').length;
  const needsYou = mine.filter((t) => waitingIds.has(t.id) || ['needs_input', 'failed', 'blocked'].includes(t.status)).length;
  const busyChats = chats.filter((c) => c.busy).length;
  const count = isSage ? chats.length : mine.length;

  return html`
    <div class=${'agent' + (mgr ? ' mgr' : '') + (isSage ? ' sage' : '') + (open ? ' open' : '') + (working || busyChats ? ' busy' : '')}>
      <div class="agenthead" onClick=${toggle} title=${open ? 'Hide conversations' : 'Show current conversations'}>
        <div class="row">
          <span class=${'dot ' + a.state} title=${a.state}></span>
          <span class="name">${a.name}</span>
          <span class="title">${a.title}</span>
          <span class="spacer"></span>
          ${working > 0 && html`<span class="badge working" title="Working now">${working} working</span>`}
          ${isSage && busyChats > 0 && html`<span class="badge working">answering</span>`}
          ${needsYou > 0 && html`<span class="badge you" title="Waiting on you">${needsYou} needs you</span>`}
          ${count > 0 && !working && !needsYou && !busyChats && html`<span class="badge">${count}</span>`}
          <span class="chev">${open ? '▾' : '▸'}</span>
        </div>
        <div class=${'bar' + (pct > 85 ? ' hot' : '')}><i style=${{ width: pct + '%' }}></i></div>
        <div class="meta">
          <span>${money(a.monthSpend)} / ${money(a.monthlyBudgetUsd)} this month</span>
          <span>${a.memoryLines} notes</span>
        </div>
      </div>
      ${open && html`
        <div class="convos">
          ${isSage
            ? html`
              <a class="convo new" href="#/ask">+ New chat</a>
              ${chats.slice(0, 8).map((c) => html`
                <a class="convo" href=${`#/ask/${c.id}`}>
                  ${c.busy ? html`<span class="spin"></span>` : html`<span class="pill">chat</span>`}
                  <span class="ct">${c.title}</span><small>${ago(c.updated_at)}</small>
                </a>
              `)}`
            : mine.length
              ? mine.map((t) => html`
                <a class="convo" href=${`#/task/${t.id}`}>
                  ${t.status === 'running' && !waitingIds.has(t.id) ? html`<span class="spin"></span>` : html`<span class=${'pill ' + t.status}>${waitingIds.has(t.id) ? 'Approval' : STATUS_LABEL[t.status]}</span>`}
                  <span class="ct">${t.title}</span><small>${ago(t.updated_at)}</small>
                </a>
              `)
              : html`<div class="empty">Nothing in progress</div>`}
          <a class="convo details" href=${`#/agent/${a.id}`}>Agent details →</a>
        </div>
      `}
    </div>
  `;
}

/** Running first, then waiting on you, then queued, then the rest. */
function rank(t, waitingIds) {
  if (t.status === 'running' && !waitingIds.has(t.id)) return 0;
  if (waitingIds.has(t.id) || ['needs_input', 'failed', 'blocked'].includes(t.status)) return 1;
  if (t.status === 'queued') return 2;
  return 3;
}

function Approvals({ approvals, tasks, agents }) {
  return html`
    <div class="card approvals">
      <h2 style="color: var(--warn)">Waiting for your approval (${approvals.length})</h2>
      ${approvals.map((a) => html`<${ApprovalRow} key=${a.id} a=${a} task=${tasks.find((t) => t.id === a.task_id)} agent=${agents[a.agent_id]} />`)}
    </div>
  `;
}

function approvalText(a) {
  if (a.tool === 'Bash') return a.input.command;
  if (a.input.file_path) return a.input.file_path;
  return JSON.stringify(a.input, null, 2);
}

function ApprovalRow({ a, task, agent }) {
  const [busy, setBusy] = useState(false);
  const decide = async (allow) => {
    const note = allow ? '' : prompt('Why? (optional, the agent sees this)') ?? '';
    setBusy(true);
    try {
      await api('POST', `/api/approvals/${a.id}`, { allow, note });
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`
    <div class="approval">
      <div>
        <div><b>${agent?.name ?? a.agent_id}</b> · ${a.reason} · <a href=${`#/task/${a.task_id}`}>${task?.title ?? a.task_id}</a></div>
        <pre>${approvalText(a)}</pre>
      </div>
      <div class="btns">
        <button class="btn ok small" disabled=${busy} onClick=${() => decide(true)}>${busy ? 'Working…' : 'Allow'}</button>
        <button class="btn bad small" disabled=${busy} onClick=${() => decide(false)}>Deny</button>
      </div>
    </div>
  `;
}

const EXAMPLES = [
  'New listing at 1234 Main St, West Vancouver: CMA, MLS remarks, feature sheet and social posts',
  'Plan the winter issue of the magazine',
  'Tenant wants to break a fixed-term lease early: what are the landlord\'s options?',
  'Explain the rescission period to a first-time buyer client',
];

function Composer({ agents }) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [agentId, setAgentId] = useState('');
  const [files, setFiles] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [over, setOver] = useState(false);

  const reset = () => { setTitle(''); setDesc(''); setFiles([]); setErr(''); setExpanded(false); };
  const addFiles = (list) => setFiles((f) => [...f, ...[...list].filter((x) => !f.some((y) => y.name === x.name && y.size === x.size))]);
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy('Creating…');
    try {
      const t = await api('POST', '/api/tasks', { title, description: desc, agentId: agentId || undefined });
      for (const [i, f] of files.entries()) {
        setBusy(`Uploading ${i + 1} of ${files.length}…`);
        await upload(`/api/tasks/${t.id}/files?name=${encodeURIComponent(f.name)}`, f);
      }
      reset();
      go(`/task/${t.id}`);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy('');
    }
  };

  const open = !!(expanded || title || desc || files.length);
  return html`
    <form class=${'card composer' + (open ? '' : ' compact') + (over ? ' over' : '')} onSubmit=${submit}
      onDragOver=${(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); setExpanded(true); } }}
      onDragLeave=${(e) => !e.currentTarget.contains(e.relatedTarget) && setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}>
      ${!open && html`
        <div class="quick">
          <input type="text" placeholder="New task: what do you need? (drop files here too)" onFocus=${() => setExpanded(true)} />
        </div>
      `}
      ${open && html`
        <div class="grid">
          <label class="field">What do you need?
            <input type="text" value=${title} autoFocus onInput=${(e) => setTitle(e.target.value)} placeholder=${EXAMPLES[0]} />
          </label>
          <label class="field">Assign to
            <select value=${agentId} onChange=${(e) => setAgentId(e.target.value)}>
              <option value="">Office manager decides</option>
              ${teamsOf(agents.filter((a) => a.kind === 'specialist')).map(([team, members]) => html`
                <optgroup label=${team}>${members.map((a) => html`<option value=${a.id}>${a.name} · ${a.title}</option>`)}</optgroup>
              `)}
            </select>
          </label>
        </div>
        <label class="field">Details: facts, client situation, deadline, anything they should know
          <textarea value=${desc} onInput=${(e) => setDesc(e.target.value)} placeholder="Price, size, features, strata fees, the client's question, the printer's deadline… The more facts, the fewer placeholders."></textarea>
        </label>
        <div class="field">Files for this task
          <label class="dropzone small">
            <input type="file" multiple onChange=${(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            Drop or choose files: data sheets, floor plans, MLS exports, strata docs, photos, contracts
          </label>
          ${files.length > 0 && html`<div class="chips">${files.map((f) => html`<span class="chip">${f.name} <small>${fileSize(f.size)}</small><button type="button" title="Remove" onClick=${() => setFiles(files.filter((x) => x !== f))}>×</button></span>`)}</div>`}
        </div>
        <div class="actions">
          ${err && html`<span class="err">${err}</span>`}
          <button type="button" class="btn" onClick=${reset}>Cancel</button>
          <button class="btn primary" disabled=${!!busy || !title.trim()}>${busy || 'Create task'}</button>
        </div>
      `}
    </form>
  `;
}

const COLUMNS = [
  { key: 'queued', title: 'Queued', match: (t) => t.status === 'queued' },
  { key: 'working', title: 'Working', match: (t, waiting) => t.status === 'running' && !waiting.has(t.id) },
  { key: 'you', title: 'Needs you', match: (t, waiting) => waiting.has(t.id) || ['needs_input', 'failed', 'blocked'].includes(t.status) },
  { key: 'review', title: 'Review', match: (t) => t.status === 'review' || t.status === 'delegated' },
  { key: 'done', title: 'Done', match: (t) => t.status === 'done' || t.status === 'cancelled' },
];

function Board({ tasks, agents, approvals }) {
  const waiting = useMemo(() => new Set(approvals.map((a) => a.task_id)), [approvals]);
  return html`
    <div class="board">
      ${COLUMNS.map((c) => {
        let items = tasks.filter((t) => c.match(t, waiting));
        if (c.key === 'done') items = items.slice(0, 25);
        return html`
          <div class="col">
            <h3>${c.title} <span class="n">${items.length}</span></h3>
            ${items.length ? items.map((t) => html`<${TaskCard} key=${t.id} t=${t} agent=${agents[t.agent_id]} waiting=${waiting.has(t.id)} />`)
              : html`<div class="empty">Nothing here</div>`}
          </div>
        `;
      })}
    </div>
  `;
}

function TaskCard({ t, agent, waiting }) {
  return html`
    <div class="task" onClick=${() => go(`/task/${t.id}`)}>
      <div class="t">${t.title}</div>
      <div class="sub">
        <span class=${'pill ' + t.status}>${waiting ? 'Approval' : STATUS_LABEL[t.status]}</span>
        <span>${agent?.name ?? t.agent_id}</span>
        <span>${ago(t.updated_at)}</span>
      </div>
      ${t.status_note && ['needs_input', 'failed', 'blocked'].includes(t.status) && html`<div class="tnote">${t.status_note.slice(0, 140)}</div>`}
    </div>
  `;
}

// ---------- task drawer ----------

function TaskDrawer({ id, agents, approvals, liveEvents, tasks }) {
  const [data, setData] = useState(null);
  const [reply, setReply] = useState('');
  const [err, setErr] = useState('');
  const bodyRef = useRef(null);
  const stick = useRef(true);
  const task = tasks.find((t) => t.id === id) ?? data?.task;

  useEffect(() => {
    setData(null);
    api('GET', `/api/tasks/${id}`).then(setData).catch((e) => setErr(e.message));
  }, [id]);
  // Re-pull children and summary when the task itself changes.
  const pendingIds = approvals.filter((a) => a.task_id === id).map((a) => a.id).join();
  useEffect(() => {
    if (task) api('GET', `/api/tasks/${id}`).then(setData).catch(() => {});
  }, [task?.updated_at, pendingIds]);

  const events = useMemo(() => {
    if (!data) return [];
    const seen = new Set(data.events.map((e) => e.id));
    return [...data.events, ...liveEvents.filter((e) => e.task_id === id && !seen.has(e.id))];
  }, [data, liveEvents, id]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  useEffect(() => {
    const on = (e) => e.detail.type === 'files' && e.detail.taskId === id && api('GET', `/api/tasks/${id}`).then(setData).catch(() => {});
    addEventListener('crew-files', on);
    return () => removeEventListener('crew-files', on);
  }, [id]);

  if (!task) return html`<div class="scrim" onClick=${close}></div><div class="drawer"><header>${err || 'Loading…'}</header></div>`;
  const agent = agents[task.agent_id];
  const pending = approvals.filter((a) => a.task_id === id);
  const results = Object.fromEntries(events.filter((e) => e.kind === 'tool_result').map((e) => [e.data.id, e.data]));

  const act = (fn) => async () => {
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e.message);
    }
  };
  const send = act(async () => {
    if (!reply.trim()) return;
    await api('POST', `/api/tasks/${id}/message`, { text: reply });
    setReply('');
  });

  return html`
    <div class="scrim" onClick=${close}></div>
    <div class="drawer">
      <header>
        <div class="h">
          <h1>${task.title}</h1>
          <button class="btn small" onClick=${close}>Close</button>
        </div>
        <div class="facts">
          <span class=${'pill ' + task.status}>${STATUS_LABEL[task.status]}</span>
          <span><a href=${`#/agent/${task.agent_id}`}>${agent?.name ?? task.agent_id}</a> · ${agent?.title}</span>
          <span>${money(task.cost_usd)}</span>
          ${task.parent_id && html`<span>from <a href=${`#/task/${task.parent_id}`}>the office manager's task</a></span>`}
        </div>
        <div class="tools">
          ${task.status === 'queued' && html`<button class="btn small" onClick=${act(() => api('POST', `/api/tasks/${id}/run`))}>Run now</button>`}
          ${['running', 'queued'].includes(task.status) && html`<button class="btn small bad" onClick=${act(() => api('POST', `/api/tasks/${id}/cancel`))}>Stop</button>`}
          ${!['running', 'done', 'cancelled'].includes(task.status) && html`
            <button class="btn small ok" onClick=${act(() => api('POST', `/api/tasks/${id}/done`))}>Mark done</button>
          `}
          <button class="btn small" title="Delete this task, its transcript and its files" onClick=${act(async () => {
            if (!confirm(`Delete "${task.title}"? Its transcript and files go too. Download anything you want to keep first.`)) return;
            await api('DELETE', `/api/tasks/${id}`);
            close();
          })}>Delete</button>
          ${err && html`<span class="err">${err}</span>`}
        </div>
      </header>
      <${TaskFiles} id=${id} files=${data?.files ?? []} />
      <div class="body" ref=${bodyRef} onScroll=${(e) => (stick.current = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 60)}>
        ${task.status_note && html`<div class=${'callout ' + (task.status === 'failed' ? 'bad' : 'warn')}>${task.status_note}</div>`}
        ${task.summary && ['review', 'done', 'delegated', 'needs_input'].includes(task.status) && html`<div class="callout ok"><b>Report</b><div class="summary">${task.summary}</div></div>`}
        ${pending.map((a) => html`<div class="card approvals"><${ApprovalRow} a=${a} task=${task} agent=${agent} /></div>`)}
        ${data?.children?.length > 0 && html`
          <div class="kids">
            <h2>Assigned work</h2>
            ${data.children.map((c) => html`<${TaskCard} key=${c.id} t=${tasks.find((x) => x.id === c.id) ?? c} agent=${agents[c.agent_id]} waiting=${approvals.some((a) => a.task_id === c.id)} />`)}
          </div>
        `}
        ${task.description && !events.some((e) => e.kind === 'prompt') && html`<div class="ev prompt">${task.description}</div>`}
        ${events.map((e) => html`<${Event} key=${e.id} e=${e} result=${e.kind === 'tool' ? results[e.data.id] : null} />`)}
        ${task.status === 'running' && html`<div class="ev meta">working…</div>`}
      </div>
      <footer>
        ${task.status === 'needs_input' && !pending.length && html`
          <div class="quick">
            <span class="muted">Quick reply:</span>
            <button class="btn small ok" onClick=${act(() => api('POST', `/api/tasks/${id}/message`, { text: 'Yes, go ahead.' }))}>Yes, go ahead</button>
            <button class="btn small" onClick=${act(() => api('POST', `/api/tasks/${id}/message`, { text: "No, don't do that. Leave it as it is and report what's left." }))}>No</button>
          </div>
        `}
        <div class="row">
          <textarea value=${reply} onInput=${(e) => setReply(e.target.value)}
            onKeyDown=${(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && send()}
            placeholder=${task.status === 'running' ? 'The agent is working. You can reply once it stops.' : `Reply to ${agent?.name ?? 'the agent'} (⌘↵)`}
            disabled=${task.status === 'running'}></textarea>
          <button class="btn primary" disabled=${task.status === 'running' || !reply.trim()} onClick=${send}>Send</button>
        </div>
      </footer>
    </div>
  `;
}

/** What the agent produced, plus files attached to the task. Download, or add more. */
function TaskFiles({ id, files }) {
  const [busy, setBusy] = useState('');
  const list = files.filter((f) => !f.dir);
  const add = async (fileList) => {
    try {
      for (const [i, f] of [...fileList].entries()) {
        setBusy(`Uploading ${i + 1} of ${fileList.length}…`);
        await upload(`/api/tasks/${id}/files?name=${encodeURIComponent(f.name)}`, f);
      }
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  };
  const href = (f) => `/files/task/${id}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
  return html`
    <div class="taskfiles" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); add(e.dataTransfer.files); }}>
      <b>Files</b>
      ${list.length ? list.map((f) => html`
        <span class="file">
          <a href=${href(f)} target="_blank" title="Open">${f.path}</a>
          <small>${fileSize(f.size)}</small>
          <a class="dl" href=${`${href(f)}?dl=1`} title="Download">↓</a>
        </span>
      `) : html`<span class="muted">None yet. The agent's deliverables appear here.</span>`}
      <label class="btn small">${busy || '+ Add file'}<input type="file" multiple hidden onChange=${(e) => { add(e.target.files); e.target.value = ''; }} /></label>
    </div>
  `;
}

function toolLine(name, input) {
  const short = name.replace(/^mcp__crew__/, '');
  if (name === 'Bash') return [short, input.command];
  if (input.file_path) return [short, input.file_path];
  if (input.pattern) return [short, input.pattern + (input.path ? `  in ${input.path}` : '')];
  if (short === 'assign') return [short, `${input.agent_id}: ${input.title}`];
  if (/^mcp__claude_ai_/i.test(name)) return [name.replace(/^mcp__claude_ai_([^_]+)__/i, '$1 · ').replace(/[-_]/g, ' '), input.query ?? input.design_id ?? input.title ?? ''];
  if (short === 'remember') return [short, input.note];
  if (short === 'report') return [short, input.status];
  if (input.url) return [short, input.url];
  if (input.description) return [short, input.description];
  return [short, ''];
}

function Event({ e, result }) {
  const d = e.data;
  switch (e.kind) {
    case 'prompt':
      return html`<div class="ev prompt">${d.resumed ? html`<b>You: </b>` : ''}${d.text}</div>`;
    case 'text':
      return html`<div class=${'ev text' + (d.sub ? ' sub' : '')}>${d.text}</div>`;
    case 'tool': {
      const [name, arg] = toolLine(d.name, d.input || {});
      if (name === 'report' || name === 'remember') return null;
      return html`
        <div class="ev tool">
          <details>
            <summary>${result?.error ? html`<span class="errtxt">✕</span>` : '›'} <b>${name}</b> ${String(arg).slice(0, 160)}</summary>
            <pre>${JSON.stringify(d.input, null, 2)}</pre>
            ${result && html`<pre class=${result.error ? 'errtxt' : ''}>${result.text}</pre>`}
          </details>
        </div>
      `;
    }
    case 'memory':
      return html`<div class="ev memory">✎ Remembered: ${d.note}</div>`;
    case 'assigned':
      return html`<div class="ev meta">Assigned “${d.title}” to ${d.agent_id}</div>`;
    case 'approval_requested':
      return html`<div class="ev meta">Asked for approval: ${d.reason}</div>`;
    case 'approval_decided':
      return html`<div class="ev meta">${d.allowed ? 'Approved' : 'Denied'}${d.note ? `: ${d.note}` : ''}</div>`;
    case 'system':
      return html`<div class="ev meta">Session started · ${d.model}${d.auth && d.auth !== 'none' ? ` · ${d.auth}` : ''}</div>`;
    case 'result':
      return html`<div class="ev meta">Run finished (${d.subtype}) · ${d.turns} turns · ${money(d.cost)} · ${Math.round(d.ms / 1000)}s</div>`;
    case 'consult_asked':
      return html`<div class="ev consult"><b>Asked ${d.to}:</b> ${d.question}</div>`;
    case 'consult_answer':
      return html`<div class="ev consult answer"><b>${d.from} answered:</b> ${d.answer}</div>`;
    case 'warning':
      return html`<div class="callout warn">${d.text}</div>`;
    case 'error':
      return html`<div class="callout bad">${d.text}</div>`;
    default:
      return null;
  }
}

// ---------- agent drawer ----------

function AgentDrawer({ id, tasks }) {
  const [data, setData] = useState(null);
  const [memory, setMemory] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    api('GET', `/api/agents/${id}`).then((d) => {
      setData(d);
      setMemory(d.memory);
    });
  }, [id]);
  if (!data) return html`<div class="scrim" onClick=${close}></div><div class="drawer"><header>Loading…</header></div>`;
  const a = data.agent;
  const mine = tasks.filter((t) => t.agent_id === id).slice(0, 15);
  const save = async () => {
    await api('PUT', `/api/agents/${id}/memory`, { content: memory });
    setSaved('Saved');
    setTimeout(() => setSaved(''), 1500);
  };
  return html`
    <div class="scrim" onClick=${close}></div>
    <div class="drawer">
      <header>
        <div class="h"><h1>${a.name} · ${a.title}</h1><button class="btn small" onClick=${close}>Close</button></div>
        <div class="facts">
          <span class=${'pill ' + (a.state === 'working' ? 'running' : a.state === 'waiting' ? 'needs_input' : '')}>${a.state}</span>
          <span>model <code>${a.model}</code> · effort <code>${a.effort}</code></span>
          <span>${money(a.monthSpend)} of ${money(a.monthlyBudgetUsd)} this month · max ${money(a.taskBudgetUsd)} per run</span>
        </div>
        <div class="facts">
          ${a.team && html`<span>${a.team}</span>`}
        </div>
      </header>
      <div class="body agentpanel">
        ${a.kind === 'specialist' && html`
          <label class="check" title="Lets this agent search, create, autofill and export Canva designs through the Canva connector on the Claude login.">
            <input type="checkbox" checked=${a.canva} onChange=${async (e) => { await api('PUT', `/api/agents/${id}/flags`, { canva: e.target.checked }); setData(await api('GET', `/api/agents/${id}`)); }} />
            Can use Canva (sharing, comments and deletes still ask you first)
          </label>
        `}
        <${SkillsPanel} agent=${a} onChange=${() => api('GET', `/api/agents/${id}`).then((d) => setData(d))} />
        <div>
          <h2>Role (agents/${a.id}.md)</h2>
          <pre class="instr">${[a.description, a.instructions].join('\n\n')}</pre>
        </div>
        <div>
          <h2>Memory (memory/${a.id}.md)</h2>
          <textarea value=${memory} onInput=${(e) => setMemory(e.target.value)}></textarea>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
            <button class="btn small" onClick=${save}>Save memory</button><span class="ev memory">${saved}</span>
          </div>
        </div>
        <div class="kids">
          <h2>Recent tasks</h2>
          ${mine.length ? mine.map((t) => html`<${TaskCard} key=${t.id} t=${t} agent=${a} waiting=${false} />`) : html`<div class="empty">No tasks yet</div>`}
        </div>
      </div>
      <footer></footer>
    </div>
  `;
}

function SkillsPanel({ agent, onChange }) {
  const [library, setLibrary] = useState([]);
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const load = () => api('GET', '/api/skills').then(setLibrary);
  useEffect(() => { load(); }, []);
  const save = async (skills) => {
    await api('PUT', `/api/agents/${agent.id}/skills`, { skills }).catch((e) => alert(e.message));
    onChange();
  };
  const runAi = async () => {
    if (!ask.trim()) return;
    setBusy(true);
    setReply('');
    try {
      const out = await api('POST', `/api/agents/${agent.id}/skills/ai`, { request: ask });
      setReply(out.summary + (out.created.length ? `\n\nNew skill: ${out.created.join(', ')}` : ''));
      setAsk('');
      load();
      onChange();
    } catch (e) {
      setReply(e.message);
    } finally {
      setBusy(false);
    }
  };
  const info = Object.fromEntries(library.map((s) => [s.name, s]));
  const addable = library.filter((s) => !agent.skills.includes(s.name));
  return html`
    <div class="skills">
      <h2>Skills</h2>
      <div class="chips">
        ${agent.skills.length ? agent.skills.map((s) => html`
          <span class="chip" title=${info[s]?.description ?? ''}>${s}<button title="Remove" onClick=${() => save(agent.skills.filter((x) => x !== s))}>×</button></span>
        `) : html`<span class="muted">No skills yet</span>`}
        ${addable.length > 0 && html`
          <select value="" onChange=${(e) => e.target.value && save([...agent.skills, e.target.value])}>
            <option value="">+ Add skill</option>
            ${addable.map((s) => html`<option value=${s.name} title=${s.description}>${s.name}${s.source === 'builtin' ? ' (built-in)' : ''}</option>`)}
          </select>
        `}
      </div>
      <a class="muted" href="#/skills">Browse or import skills →</a>
      <div class="skillai">
        <input type="text" value=${ask} disabled=${busy} onInput=${(e) => setAsk(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && runAi()}
          placeholder=${`Ask AI: e.g. "write ${agent.name} a skill from the brand guide in the library" or "remove deep-research"`} />
        <button class="btn small primary" disabled=${busy || !ask.trim()} onClick=${runAi}>${busy ? 'Working…' : 'Ask'}</button>
      </div>
      ${busy && html`<div class="muted">Reading the library and updating skills. This can take a minute or two.</div>`}
      ${reply && html`<div class="callout info"><div class="summary">${reply}</div></div>`}
    </div>
  `;
}

// ---------- skills library ----------

const ORIGIN_LABEL = (o) =>
  !o ? 'written for the crew' : o.from === 'ai' ? 'written by AI' : o.from === 'github' ? (o.repo === 'anthropics/skills' ? 'Anthropic' : `GitHub · ${o.repo}`) : o.from === 'local' ? 'from the server' : 'your upload';

function SkillsLibrary({ agents }) {
  const [skills, setSkills] = useState([]);
  const [tab, setTab] = useState('anthropic');
  const [enableFor, setEnableFor] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api('GET', '/api/skills').then(setSkills);
  useEffect(() => { load(); }, []);
  const library = skills.filter((s) => s.source === 'library');
  const builtins = skills.filter((s) => s.source === 'builtin');

  const doImport = async (payload) => {
    setMsg('');
    try {
      const out = await api('POST', '/api/skills/import', { ...payload, enableFor: enableFor || undefined });
      const who = agents.find((a) => a.id === enableFor);
      setMsg(`Imported ${out.name}${who ? ` and gave it to ${who.name}` : ''}.`);
      load();
      return true;
    } catch (e) {
      if (/already in the library/.test(e.message) && confirm(`${e.message}. Replace it with this version?`)) return doImport({ ...payload, overwrite: true });
      setMsg(e.message);
      return false;
    }
  };
  const remove = async (s) => {
    const users = s.usedBy.map((u) => u.name).join(', ');
    if (!confirm(`Remove ${s.name} from the library?${users ? ` ${users} will lose it.` : ''}`)) return;
    await api('DELETE', `/api/skills/${encodeURIComponent(s.name)}`).catch((e) => alert(e.message));
    load();
  };

  return html`
    <div class="scrim" onClick=${close}></div>
    <div class="drawer">
      <header>
        <div class="h"><h1>Skills library</h1><button class="btn small" onClick=${close}>Close</button></div>
        <div class="facts"><span>Skills live in <code>skills/skills/</code>. Give one to an agent from its panel, or pick an agent below while importing. Anthropic's <b>docx</b>, <b>pdf</b>, <b>pptx</b> and <b>xlsx</b> skills are useful for agents that deliver Office files.</span></div>
      </header>
      <div class="body">
        <section class="lib">
          <h2>In the library (${library.length})</h2>
          ${library.map((s) => html`
            <div class="skillrow">
              <div>
                <div><b>${s.name}</b> <span class="pill">${ORIGIN_LABEL(s.origin)}</span></div>
                <div class="desc">${s.description}</div>
                <div class="chips">${s.usedBy.length ? s.usedBy.map((u) => html`<a class="chip plain" href=${`#/agent/${u.id}`}>${u.name}</a>`) : html`<span class="muted">Not used by any agent yet</span>`}</div>
              </div>
              <button class="btn small bad" onClick=${() => remove(s)}>Remove</button>
            </div>
          `)}
          <details><summary class="muted">Claude Code built-ins (${builtins.length}), always available to enable</summary>
            ${builtins.map((s) => html`<div class="skillrow"><div><b>${s.name}</b><div class="desc">${s.description}</div></div></div>`)}
          </details>
        </section>

        <section class="lib">
          <h2>Add skills</h2>
          <div class="tabs">
            ${[['anthropic', 'Anthropic'], ['github', 'GitHub repo'], ['upload', 'Your own .md']].map(([k, label]) => html`
              <button class=${'tab' + (tab === k ? ' on' : '')} onClick=${() => { setTab(k); setMsg(''); }}>${label}</button>
            `)}
            <span class="spacer"></span>
            <label class="ctl">Give to
              <select value=${enableFor} onChange=${(e) => setEnableFor(e.target.value)}>
                <option value="">nobody yet</option>
                ${teamsOf(agents.filter((a) => a.kind === 'specialist')).map(([team, members]) => html`
                  <optgroup label=${team}>${members.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</optgroup>
                `)}
                ${agents.filter((a) => a.kind === 'manager').map((a) => html`<option value=${a.id}>${a.name} (manager)</option>`)}
              </select>
            </label>
          </div>
          ${msg && html`<div class=${'callout ' + (/^Imported/.test(msg) ? 'ok' : 'bad')}>${msg}</div>`}
          ${tab === 'anthropic' && html`<${GitHubCatalog} fixed="anthropics/skills" onImport=${doImport} refreshKey=${library.length} />`}
          ${tab === 'github' && html`<${GitHubCatalog} onImport=${doImport} refreshKey=${library.length} />`}
          ${tab === 'local' && html`<${LocalCatalog} onImport=${doImport} refreshKey=${library.length} />`}
          ${tab === 'upload' && html`<${UploadSkill} onImport=${doImport} />`}
        </section>
      </div>
      <footer></footer>
    </div>
  `;
}

function CatalogList({ items, onImport }) {
  const [busy, setBusy] = useState('');
  return html`
    ${items.map((s) => html`
      <div class="skillrow">
        <div><b>${s.name}</b><div class="desc">${s.description}</div></div>
        ${s.installed
          ? html`<span class="pill done">In library</span>`
          : html`<button class="btn small primary" disabled=${!!busy} onClick=${async () => { setBusy(s.path); await onImport(s); setBusy(''); }}>${busy === s.path ? 'Importing…' : 'Import'}</button>`}
      </div>
    `)}
  `;
}

function GitHubCatalog({ fixed, onImport, refreshKey }) {
  const [input, setInput] = useState(fixed ?? '');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const loadRepo = async (repo) => {
    if (!repo.trim()) return;
    setLoading(true);
    setErr('');
    try {
      setData(await api('GET', `/api/skills/catalog?repo=${encodeURIComponent(repo.trim())}`));
    } catch (e) {
      setErr(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (fixed || data) loadRepo(fixed ?? input); }, [refreshKey]);
  return html`
    ${fixed
      ? html`<div class="muted">Official skills from <a href="https://github.com/anthropics/skills" target="_blank">github.com/anthropics/skills</a>. Imports copy the whole skill folder, scripts included.</div>`
      : html`<div class="skillai">
          <input type="text" value=${input} onInput=${(e) => setInput(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && loadRepo(input)}
            placeholder="owner/repo, owner/repo/path, or a github.com link to a skill folder" />
          <button class="btn small" disabled=${loading} onClick=${() => loadRepo(input)}>${loading ? 'Loading…' : 'Look'}</button>
        </div>
        <div class="muted">Only import skills from sources you trust: a skill can include scripts that agents may run.</div>`}
    ${err && html`<div class="callout bad">${err}</div>`}
    ${loading && !data && html`<div class="muted">Reading the repo…</div>`}
    ${data && (data.skills.length
      ? html`<${CatalogList} items=${data.skills} onImport=${(s) => onImport({ from: 'github', repo: `${data.repo}/tree/${data.ref}`, path: s.path })} />`
      : html`<div class="muted">No SKILL.md files found there.</div>`)}
  `;
}

function LocalCatalog({ onImport, refreshKey }) {
  const [items, setItems] = useState(null);
  useEffect(() => { api('GET', '/api/skills/local').then(setItems); }, [refreshKey]);
  if (!items) return html`<div class="muted">Loading…</div>`;
  return html`
    <div class="muted">Skills in <code>~/.claude/skills</code> (the ones your own Claude Code uses).</div>
    ${items.length ? html`<${CatalogList} items=${items} onImport=${(s) => onImport({ from: 'local', path: s.path })} />` : html`<div class="muted">None found.</div>`}
  `;
}

function UploadSkill({ onImport }) {
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const readFile = async (file) => {
    if (!file) return;
    setFilename(file.name);
    setContent(await file.text());
  };
  const submit = async () => {
    setBusy(true);
    if (await onImport({ from: 'markdown', content, filename })) {
      setContent('');
      setFilename('');
    }
    setBusy(false);
  };
  return html`
    <div class="muted">A SKILL.md with frontmatter (<code>name</code>, <code>description</code>) and instructions. A plain .md works too: it's named after the file and described by its first heading.</div>
    <label class=${'dropzone' + (over ? ' over' : '')}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); readFile(e.dataTransfer.files[0]); }}>
      <input type="file" accept=".md,text/markdown,text/plain" onChange=${(e) => readFile(e.target.files[0])} />
      ${filename ? html`<b>${filename}</b>` : 'Drop a .md file here, or click to choose one'}
    </label>
    <textarea class="mdpaste" value=${content} onInput=${(e) => setContent(e.target.value)}
      placeholder=${'…or paste it here\n\n---\nname: my-skill\ndescription: When to use it, specifically.\n---\n\n# My skill\n\nInstructions…'}></textarea>
    <div><button class="btn primary small" disabled=${busy || !content.trim()} onClick=${submit}>${busy ? 'Importing…' : 'Add to library'}</button></div>
  `;
}

// ---------- Ask Sage ----------

const escapeHtml = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Small, safe markdown: escape first, then code, bold, links, headings. */
/** Markdown tables (| a | b | with a |---| separator row) to HTML tables. Input is already escaped. */
function tables(text) {
  return text.replace(/(^\|.*\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.*\|[ \t]*(?:\n|$))*)/gm, (block) => {
    const rows = block.trim().split('\n').map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const [head, , ...body] = rows;
    return `<table class="mdt"><thead><tr>${head.map((c) => `<th class="nw">${c}</th>`).join('')}</tr></thead><tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td${c.length <= 24 ? ' class="nw"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  });
}

function md(text) {
  const parts = text.split(/```[a-zA-Z0-9-]*\n?([\s\S]*?)```/g);
  return parts
    .map((p, i) => {
      if (i % 2) return `<pre><code>${escapeHtml(p.replace(/\n$/, ''))}</code></pre>`;
      return tables(escapeHtml(p))
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
        .replace(/^#{1,4}\s+(.+)$/gm, '<b class="mdh">$1</b>');
    })
    .join('');
}

function AskDrawer({ chatId, sage, agents }) {
  const [chats, setChats] = useState([]);
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState('');
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const bodyRef = useRef(null);
  const loadChats = () => api('GET', '/api/chats').then(setChats);

  useEffect(() => { loadChats(); }, []);
  useEffect(() => {
    setLive('');
    setErr('');
    if (!chatId) { setMessages([]); setBusy(false); return; }
    api('GET', `/api/chats/${chatId}`).then((d) => { setMessages(d.messages); setBusy(d.chat.busy); }).catch((e) => setErr(e.message));
  }, [chatId]);
  useEffect(() => {
    const on = (e) => {
      const m = e.detail;
      if (m.chatId !== chatId) { if (m.type === 'chat' && m.busy === false) loadChats(); return; }
      if (m.type === 'chat_delta') return setLive((t) => t + m.text);
      if (m.message) {
        setMessages((ms) => {
          const i = ms.findIndex((x) => x.id === m.message.id);
          return i >= 0 ? ms.map((x, j) => (j === i ? m.message : x)) : [...ms, m.message];
        });
        if (m.message.role === 'assistant') setLive('');
      }
      if (typeof m.busy === 'boolean') {
        setBusy(m.busy);
        if (!m.busy) { setLive(''); loadChats(); }
      }
    };
    addEventListener('crew-chat', on);
    return () => removeEventListener('crew-chat', on);
  }, [chatId]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, live]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setErr('');
    setInput('');
    try {
      if (chatId) {
        setBusy(true);
        await api('POST', `/api/chats/${chatId}/messages`, { text });
      } else {
        const c = await api('POST', '/api/chats', { text });
        go(`/ask/${c.id}`);
        loadChats();
      }
    } catch (e) {
      setErr(e.message);
      setInput(text);
      setBusy(false);
    }
  };
  const queueDraft = async (m) => {
    try {
      await api('POST', `/api/chats/${chatId}/drafts/${m.id}/queue`);
    } catch (e) {
      alert(e.message);
    }
  };
  const mgr = agents.find((a) => a.kind === 'manager');
  const agentName = (id) => (id === 'manager' ? `${mgr?.name ?? 'Office manager'} (routes it)` : agents.find((a) => a.id === id)?.name ?? id);
  const current = chats.find((c) => c.id === chatId);

  return html`
    <div class="scrim" onClick=${close}></div>
    <div class="drawer ask">
      <header>
        <div class="h">
          <h1>Ask ${sage.name} <span class="muted">· ${sage.title}, knows virani.ca and the library, read-only</span></h1>
          <button class="btn small" onClick=${close}>Close</button>
        </div>
      </header>
      <div class="askbody">
        <nav class="chats">
          <button class="btn small primary" onClick=${() => go('/ask')}>+ New chat</button>
          ${chats.map((c) => html`
            <a class=${'chatlink' + (c.id === chatId ? ' on' : '')} href=${`#/ask/${c.id}`} title=${c.title}>
              ${c.busy && html`<span class="dot working"></span>`}<span>${c.title}</span>
            </a>
          `)}
        </nav>
        <section class="conv">
          <div class="msgs" ref=${bodyRef}>
            ${!chatId && !messages.length && html`
              <div class="askhello">
                <b>Ask ${sage.name} anything about the brokerage.</b>
                <div class="muted">It searches a copy of virani.ca (team, listings, buildings, neighbourhoods, blog, testimonials) and the library, checks the live site when it matters, and knows what every crew agent has learned. It can't change anything, but it can draft a task for the queue.</div>
                <div class="examples">
                  ${['Who on the team covers North Vancouver?', 'What have we written about the rescission period?', 'Which buildings in Coal Harbour do we have pages for?', 'How do I get a feature sheet made for a new listing?'].map((q) => html`<button class="btn small" onClick=${() => setInput(q)}>${q}</button>`)}
                </div>
              </div>
            `}
            ${messages.map((m) => html`<${ChatMsg} key=${m.id} m=${m} onQueue=${() => queueDraft(m)} agentName=${agentName} />`)}
            ${live && html`<div class="msg assistant"><div class="md" dangerouslySetInnerHTML=${{ __html: md(live) }}></div></div>`}
            ${busy && !live && html`<div class="msg thinking">${sage.name} is looking into it…</div>`}
            ${err && html`<div class="callout bad">${err}</div>`}
          </div>
          <div class="askinput">
            <textarea value=${input} onInput=${(e) => setInput(e.target.value)} placeholder=${`Ask ${sage.name}… (Enter to send, Shift+Enter for a new line)`}
              onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea>
            <div class="askbtns">
              ${busy
                ? html`<button class="btn bad" onClick=${() => api('POST', `/api/chats/${chatId}/stop`)}>Stop</button>`
                : html`<button class="btn primary" disabled=${!input.trim()} onClick=${send}>Send</button>`}
              ${current && html`<span class="muted">${money(current.cost_usd)}</span>`}
              ${current && !busy && html`<button class="btn small" title="Delete this conversation" onClick=${async () => {
                if (!confirm('Delete this conversation?')) return;
                await api('DELETE', `/api/chats/${chatId}`);
                loadChats();
                go('/ask');
              }}>Delete</button>`}
            </div>
          </div>
        </section>
      </div>
    </div>
  `;
}

function ChatMsg({ m, onQueue, agentName }) {
  if (m.role === 'user') return html`<div class="msg user">${m.text}</div>`;
  if (m.role === 'assistant') return html`<div class="msg assistant"><div class="md" dangerouslySetInnerHTML=${{ __html: md(m.text) }}></div></div>`;
  if (m.role === 'tool') return html`<div class=${'msg tool' + (m.data?.kind === 'memory' ? ' memory' : '')}>${m.data?.kind === 'memory' ? '✎ ' : '› '}${m.text}</div>`;
  if (m.role === 'error') return html`<div class="callout bad">${m.text}</div>`;
  if (m.role === 'draft') {
    const d = m.data || {};
    return html`
      <div class="msg draft">
        <div class="dh"><span class="pill">Suggested task</span> for <b>${agentName(d.agent_id)}</b></div>
        <div class="dt">${d.title}</div>
        <div class="dd">${d.description}</div>
        ${d.queued
          ? html`<a class="btn small" href=${`#/task/${d.queued}`}>Queued ✓ Open task</a>`
          : html`<button class="btn small primary" onClick=${onQueue}>Add to queue</button>`}
      </div>
    `;
  }
  return null;
}

// ---------- library ----------

function LibraryDrawer({ site }) {
  const [items, setItems] = useState(null);
  const [openDirs, setOpenDirs] = useState(() => new Set(['']));
  const [busy, setBusy] = useState('');
  const [overDir, setOverDir] = useState(null);
  const load = () => api('GET', '/api/library').then(setItems).catch(() => setItems([]));
  useEffect(() => {
    load();
    const on = (e) => e.detail.type === 'library' && load();
    addEventListener('crew-files', on);
    return () => removeEventListener('crew-files', on);
  }, []);
  if (!items) return html`<div class="scrim" onClick=${close}></div><div class="drawer"><header>Loading…</header></div>`;

  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const children = (dir) => items.filter((i) => parentOf(i.path) === dir);
  const toggle = (p) => setOpenDirs((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const uploadTo = async (dir, fileList) => {
    if (dir === 'website' || dir.startsWith('website/')) return alert('The website folder is rebuilt automatically; drop files into another folder.');
    try {
      for (const [i, f] of [...fileList].entries()) {
        setBusy(`Uploading ${i + 1} of ${fileList.length} to ${dir || 'library'}…`);
        await upload(`/api/library/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`, f);
      }
      setOpenDirs((s) => new Set([...s, dir]));
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
      load();
    }
  };
  const newFolder = async (dir) => {
    const name = prompt(`New folder inside ${dir || 'the library'}:`);
    if (!name?.trim()) return;
    await api('POST', '/api/library/folder', { path: dir ? `${dir}/${name.trim()}` : name.trim() }).catch((e) => alert(e.message));
    setOpenDirs((s) => new Set([...s, dir]));
    load();
  };
  const remove = async (f) => {
    if (!confirm(`Delete ${f.path} from the library?`)) return;
    await api('DELETE', `/api/library?path=${encodeURIComponent(f.path)}`).catch((e) => alert(e.message));
    load();
  };
  const href = (f) => `/files/library/${f.path.split('/').map(encodeURIComponent).join('/')}`;
  const count = (dir) => items.filter((i) => !i.dir && i.path.startsWith(dir + '/') && i.name !== 'README.md').length;

  const Dir = ({ dir, depth }) => children(dir).map((f) => f.dir
    ? html`
      <div class=${'libdir' + (overDir === f.path ? ' over' : '')} style=${{ paddingLeft: depth * 16 + 'px' }}
        onDragOver=${(e) => { e.preventDefault(); e.stopPropagation(); setOverDir(f.path); }}
        onDragLeave=${() => setOverDir(null)}
        onDrop=${(e) => { e.preventDefault(); e.stopPropagation(); setOverDir(null); uploadTo(f.path, e.dataTransfer.files); }}>
        <button class="linkish" onClick=${() => toggle(f.path)}>${openDirs.has(f.path) ? '▾' : '▸'} ${f.name}/</button>
        <small class="muted">${count(f.path) || ''}</small>
        <span class="spacer"></span>
        ${!f.path.startsWith('website') && html`
          <label class="btn tiny">Add<input type="file" multiple hidden onChange=${(e) => { uploadTo(f.path, e.target.files); e.target.value = ''; }} /></label>
          <button class="btn tiny" onClick=${() => newFolder(f.path)}>+ Folder</button>
        `}
      </div>
      ${openDirs.has(f.path) && html`<${Dir} dir=${f.path} depth=${depth + 1} />`}`
    : html`
      <div class="libfile" style=${{ paddingLeft: depth * 16 + 18 + 'px' }}>
        <a href=${href(f)} target="_blank">${f.name}</a>
        <small class="muted">${fileSize(f.size)} · ${ago(f.modified)}</small>
        <span class="spacer"></span>
        <a class="btn tiny" href=${`${href(f)}?dl=1`}>↓</a>
        ${f.name !== 'README.md' && !f.path.startsWith('website/') && html`<button class="btn tiny bad" onClick=${() => remove(f)}>×</button>`}
      </div>`);

  return html`
    <div class="scrim" onClick=${close}></div>
    <div class="drawer">
      <header>
        <div class="h"><h1>Library</h1><button class="btn small" onClick=${close}>Close</button></div>
        <div class="facts"><span>Reference files every agent reads before working: brand, forms, rules, past magazines, market data. Drag files onto a folder to add them. Each folder's README says what belongs there.</span></div>
        <div class="facts">
          <span>Website snapshot of <a href=${site.site} target="_blank">${site.site.replace(/^https?:\/\//, '')}</a>: ${site.running ? `updating (${site.fetched} pages fetched)…` : `${site.saved} pages${site.finishedAt ? `, updated ${ago(site.finishedAt)}` : ''}`}${site.error ? html` <span class="err">${site.error}</span>` : ''}</span>
          <button class="btn tiny" disabled=${site.running} onClick=${() => api('POST', '/api/site/refresh')}>Refresh now</button>
        </div>
      </header>
      <div class="body library"
        onDragOver=${(e) => { e.preventDefault(); setOverDir(''); }}
        onDrop=${(e) => { e.preventDefault(); setOverDir(null); uploadTo('inbox', e.dataTransfer.files); }}>
        ${busy && html`<div class="callout info">${busy}</div>`}
        <div class="libtop"><span class="muted">Dropping outside a folder puts files in inbox/.</span><span class="spacer"></span><button class="btn tiny" onClick=${() => newFolder('')}>+ Folder</button></div>
        <${Dir} dir="" depth=${0} />
      </div>
      <footer></footer>
    </div>
  `;
}

// ---------- new agent ----------

function NewAgent({ teams }) {
  const [f, setF] = useState({ name: '', title: '', team: '', newTeam: '', description: '', instructions: '', canva: false, model: 'opus', effort: 'high', taskBudgetUsd: 5, monthlyBudgetUsd: 100, skills: [] });
  const [skills, setSkills] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api('GET', '/api/skills').then(setSkills); }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (k, v) => setF((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));
  const team = f.team === '__new' ? f.newTeam.trim() : f.team;
  const draft = async () => {
    setBusy('draft');
    setErr('');
    try {
      const r = await api('POST', '/api/agents/draft', { name: f.name, title: f.title, description: f.description, team });
      set('instructions', r.instructions);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const create = async () => {
    setBusy('create');
    setErr('');
    try {
      const a = await api('POST', '/api/agents', { ...f, team });
      go(`/agent/${a.id}`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  return html`
    <div class="scrim" onClick=${close}></div>
    <div class="drawer">
      <header>
        <div class="h"><h1>New agent</h1><button class="btn small" onClick=${close}>Close</button></div>
        <div class="facts"><span>Creates <code>agents/&lt;name&gt;.md</code> and a memory file. It's live as soon as it's created, and you can edit the file any time.</span></div>
      </header>
      <div class="body newagent">
        <div class="grid2">
          <label class="field">Name<input type="text" value=${f.name} onInput=${(e) => set('name', e.target.value)} placeholder="e.g. Maple" /></label>
          <label class="field">Title<input type="text" value=${f.title} onInput=${(e) => set('title', e.target.value)} placeholder="e.g. Open House Coordinator" /></label>
          <label class="field">Team
            <select value=${f.team} onChange=${(e) => set('team', e.target.value)}>
              <option value="">No team</option>
              ${teams.map((t) => html`<option value=${t}>${t}</option>`)}
              <option value="__new">New team…</option>
            </select>
          </label>
          ${f.team === '__new' && html`<label class="field">New team name<input type="text" value=${f.newTeam} onInput=${(e) => set('newTeam', e.target.value)} placeholder="e.g. Events" /></label>`}
        </div>
        <label class="field">What it does (the office manager uses this to route work)
          <textarea value=${f.description} onInput=${(e) => set('description', e.target.value)} placeholder="One or two sentences: the kind of work it takes and what it delivers."></textarea>
        </label>
        <div class="field">Instructions
          <textarea class="instr" value=${f.instructions} onInput=${(e) => set('instructions', e.target.value)} placeholder="How it should work: what it does, the rules that matter, what it delivers, how it checks its work. Or let AI draft it from the fields above."></textarea>
          <div><button class="btn small" disabled=${!!busy || !f.title.trim() || !f.description.trim()} onClick=${draft}>${busy === 'draft' ? 'Drafting… (about a minute)' : 'Draft with AI'}</button></div>
        </div>
        <div class="grid2">
          <label class="field">Model<select value=${f.model} onChange=${(e) => set('model', e.target.value)}>${['opus', 'sonnet', 'haiku'].map((m) => html`<option value=${m}>${m}</option>`)}</select></label>
          <label class="field">Effort<select value=${f.effort} onChange=${(e) => set('effort', e.target.value)}>${['low', 'medium', 'high', 'xhigh', 'max'].map((m) => html`<option value=${m}>${m}</option>`)}</select></label>
          <label class="field">Max $ per run<input type="number" value=${f.taskBudgetUsd} onInput=${(e) => set('taskBudgetUsd', e.target.value)} /></label>
          <label class="field">Max $ per month<input type="number" value=${f.monthlyBudgetUsd} onInput=${(e) => set('monthlyBudgetUsd', e.target.value)} /></label>
        </div>
        <div class="field">Skills
          <div class="checks">${skills.map((s) => html`<label title=${s.description}><input type="checkbox" checked=${f.skills.includes(s.name)} onChange=${() => toggle('skills', s.name)} /> ${s.name}</label>`)}</div>
        </div>
        <label class="check"><input type="checkbox" checked=${f.canva} onChange=${(e) => set('canva', e.target.checked)} /> Can use Canva</label>
        ${err && html`<div class="callout bad">${err}</div>`}
        <div><button class="btn primary" disabled=${!!busy || !f.name.trim() || !f.title.trim() || !f.description.trim()} onClick=${create}>${busy === 'create' ? 'Creating…' : 'Create agent'}</button></div>
      </div>
      <footer></footer>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
