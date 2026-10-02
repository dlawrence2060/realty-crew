import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { AGENTS_DIR, MEMORY_DIR, PLUGIN_NAME, SKILLS_DIR } from './config.ts';

export type AgentDef = {
  id: string;
  name: string;
  title: string;
  /** assistant: Sage, the chat-only guide. Never assigned tasks. */
  kind: 'manager' | 'specialist' | 'assistant';
  /** Block on the org chart; teammates can consult each other with ask_teammate. */
  team: string | null;
  /** Skill names: ones in skills/skills/ (the crew library) or Claude Code built-ins. */
  skills: string[];
  /** Can use the Canva connector (designs, brand templates, exports). */
  canva: boolean;
  /** Can use Google Drive (read her docs, create new Docs/Sheets). */
  drive: boolean;
  /** Can use Google Calendar (read; changes ask first). */
  calendar: boolean;
  description: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Hard cap on one run (one task message), in USD. */
  taskBudgetUsd: number;
  /** Agent stops picking up work once its tasks this month cost this much. */
  monthlyBudgetUsd: number;
  maxTurns: number;
  instructions: string;
  order: number;
};

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function loadOne(file: string): AgentDef {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(FRONTMATTER);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const fm = parseYaml(m[1]) as Partial<AgentDef>;
  const id = path.basename(file, '.md');
  return {
    id,
    name: fm.name ?? id,
    title: fm.title ?? '',
    kind: fm.kind ?? 'specialist',
    team: fm.team ?? null,
    skills: fm.skills ?? [],
    canva: fm.canva === true,
    drive: fm.drive === true,
    calendar: fm.calendar === true,
    description: fm.description ?? '',
    model: fm.model ?? 'opus',
    effort: fm.effort ?? 'high',
    taskBudgetUsd: fm.taskBudgetUsd ?? 10,
    monthlyBudgetUsd: fm.monthlyBudgetUsd ?? 200,
    maxTurns: fm.maxTurns ?? 200,
    order: fm.order ?? 100,
    instructions: m[2].trim(),
  };
}

/** Re-read on every call so edits to agents/*.md apply without a restart. */
export function loadRoster(): AgentDef[] {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .flatMap((f) => {
      try {
        return [loadOne(path.join(AGENTS_DIR, f))];
      } catch (e) {
        console.error(`Skipping agents/${f}: ${(e as Error).message.split('\n')[0]}`);
        return [];
      }
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function getAgent(id: string): AgentDef | undefined {
  return loadRoster().find((a) => a.id === id);
}

export function managerAgent(): AgentDef {
  const m = loadRoster().find((a) => a.kind === 'manager');
  if (!m) throw new Error('No agent with kind: manager in agents/');
  return m;
}

export function memoryPath(agentId: string) {
  return path.join(MEMORY_DIR, `${agentId}.md`);
}

export function readMemory(agentId: string): string {
  try {
    return fs.readFileSync(memoryPath(agentId), 'utf8');
  } catch {
    return '';
  }
}

export function writeMemory(agentId: string, content: string) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(memoryPath(agentId), content.endsWith('\n') ? content : content + '\n');
}

export function appendMemory(agentId: string, note: string) {
  const date = new Date().toISOString().slice(0, 10);
  const current = readMemory(agentId);
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  writeMemory(agentId, `${current}${sep}- (${date}) ${note.trim()}\n`);
}

// ---------- skills ----------

export type SkillInfo = { name: string; description: string; source: 'library' | 'builtin' };

/** Claude Code skills every agent can use without the library. */
const BUILTIN_SKILLS: SkillInfo[] = [
  { name: 'deep-research', description: 'Multi-source research with a written report.', source: 'builtin' },
];

export function listSkills(): SkillInfo[] {
  const lib: SkillInfo[] = [];
  for (const dir of fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR) : []) {
    const file = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, 'utf8').match(FRONTMATTER);
    const fm = (m ? parseYaml(m[1]) : {}) as { name?: string; description?: string };
    lib.push({ name: fm.name ?? dir, description: fm.description ?? '', source: 'library' });
  }
  return [...lib.sort((a, b) => a.name.localeCompare(b.name)), ...BUILTIN_SKILLS];
}

/** SDK skill ids: library skills are namespaced by the crew's plugin. */
export function sdkSkillIds(agent: AgentDef): string[] {
  const lib = new Set(listSkills().filter((s) => s.source === 'library').map((s) => s.name));
  return agent.skills.map((s) => (lib.has(s) ? `${PLUGIN_NAME}:${s}` : s));
}

/** Rewrite one agent's `skills:` frontmatter, keeping everything else in the file as is. */
export function setAgentSkills(agentId: string, skills: string[]) {
  const file = path.join(AGENTS_DIR, `${agentId}.md`);
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(FRONTMATTER);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const doc = parseDocument(m[1]);
  const unique = [...new Set(skills.map((s) => s.trim()).filter(Boolean))];
  if (unique.length) {
    doc.set('skills', unique);
    const node = doc.get('skills', true) as { flow?: boolean } | undefined;
    if (node) node.flow = true;
  } else doc.delete('skills');
  fs.writeFileSync(file, `---\n${String(doc).trimEnd()}\n---\n${m[2]}`);
}

/** The claude.ai connectors an agent may use. */
export function agentConnectors(a: AgentDef): Array<'canva' | 'drive' | 'calendar'> {
  return (['canva', 'drive', 'calendar'] as const).filter((k) => a[k]);
}

/** Set or clear a connector flag in an agent's frontmatter, keeping the rest of the file. */
export function setAgentFlag(agentId: string, key: 'canva' | 'drive' | 'calendar', on: boolean) {
  const file = path.join(AGENTS_DIR, `${agentId}.md`);
  const m = fs.readFileSync(file, 'utf8').match(FRONTMATTER);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const doc = parseDocument(m[1]);
  if (on) doc.set(key, true);
  else doc.delete(key);
  fs.writeFileSync(file, `---\n${String(doc).trimEnd()}\n---\n${m[2]}`);
}
