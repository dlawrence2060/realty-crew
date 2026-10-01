import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SKILLS_DIR } from './config.ts';
import { loadRoster, setAgentSkills } from './roster.ts';

/**
 * Getting skills into the crew's library (skills/skills/<name>/):
 *  - from GitHub (Anthropic's official anthropics/skills, or any repo/folder),
 *  - from skills already in ~/.claude/skills on the server,
 *  - from a pasted or uploaded SKILL.md.
 * Each imported skill records where it came from in .source.json.
 */

export const OFFICIAL_REPO = 'anthropics/skills';
const LOCAL_SKILLS = path.join(os.homedir(), '.claude', 'skills');
const MAX_FILES = 200;
const MAX_BYTES = 10 * 1024 * 1024;

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function frontmatter(md: string): { name?: string; description?: string } {
  const m = md.replace(/\r\n/g, '\n').match(FRONTMATTER);
  if (!m) return {};
  try {
    return (parseYaml(m[1]) ?? {}) as { name?: string; description?: string };
  } catch {
    return {};
  }
}

function safeName(name: string) {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!n || n.length > 64) throw new Error(`"${name}" isn't a usable skill name`);
  return n;
}

function installedNames() {
  return new Set(fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR).filter((d) => fs.existsSync(path.join(SKILLS_DIR, d, 'SKILL.md'))) : []);
}

function writeSource(dir: string, source: Record<string, string>) {
  fs.writeFileSync(path.join(dir, '.source.json'), JSON.stringify({ ...source, importedAt: new Date().toISOString() }, null, 2) + '\n');
}

export function skillSource(name: string): Record<string, string> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, name, '.source.json'), 'utf8'));
  } catch {
    return null;
  }
}

// ---------- GitHub ----------

/** "owner/repo", "owner/repo/sub/dir" or a github.com URL (tree/blob links included). */
export function parseRepoRef(input: string): { repo: string; ref: string | null; dir: string } {
  const s = input.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = s.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error('Use owner/repo, owner/repo/path, or a github.com link');
  const repo = `${parts[0]}/${parts[1]}`;
  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
    const dir = parts.slice(4).join('/').replace(/\/?SKILL\.md$/i, '');
    return { repo, ref: parts[3], dir };
  }
  return { repo, ref: null, dir: parts.slice(2).join('/') };
}

/** Public GitHub REST API: no gh CLI or token needed for public skill repos (60 requests/hour unauthenticated). */
async function githubApi(pathname: string) {
  const res = await fetch(`https://api.github.com/${pathname}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'realty-crew' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} for ${pathname}`);
  return res.json();
}

type TreeEntry = { path: string; type: string; size?: number };
const treeCache = new Map<string, { at: number; ref: string; tree: TreeEntry[] }>();

async function repoTree(repo: string, ref: string | null) {
  const key = `${repo}@${ref ?? ''}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  const branch = ref ?? ((await githubApi(`repos/${repo}`)) as { default_branch: string }).default_branch;
  const data = (await githubApi(`repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)) as { tree: TreeEntry[] };
  const entry = { at: Date.now(), ref: branch as string, tree: data.tree };
  treeCache.set(key, entry);
  return entry;
}

async function rawFile(repo: string, ref: string, file: string): Promise<Buffer> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${file.split('/').map(encodeURIComponent).join('/')}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export type CatalogSkill = { name: string; description: string; path: string; installed: boolean };
const descCache = new Map<string, { name?: string; description?: string }>();

/** Every SKILL.md under the repo (or sub-folder), with its name and description. */
export async function githubCatalog(input: string): Promise<{ repo: string; ref: string; skills: CatalogSkill[] }> {
  const { repo, ref, dir } = parseRepoRef(input);
  const { ref: branch, tree } = await repoTree(repo, ref);
  const prefix = dir ? `${dir}/` : '';
  const files = tree.filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/.test(t.path) && (t.path.startsWith(prefix) || t.path === `${dir}/SKILL.md`));
  const installed = installedNames();
  const skills = await Promise.all(
    files.slice(0, 100).map(async (f) => {
      const key = `${repo}@${branch}:${f.path}`;
      let fm = descCache.get(key);
      if (!fm) {
        fm = frontmatter((await rawFile(repo, branch, f.path)).toString('utf8'));
        descCache.set(key, fm);
      }
      const folder = path.posix.dirname(f.path);
      const name = fm.name ?? path.posix.basename(folder);
      return { name, description: fm.description ?? '', path: folder, installed: installed.has(name) };
    }),
  );
  return { repo, ref: branch, skills: skills.filter((s) => s.path !== '.' && !s.path.startsWith('template')).sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Copy one skill folder from GitHub into the library. */
export async function importFromGitHub(input: string, folder: string, overwrite = false) {
  const { repo, ref } = parseRepoRef(input);
  const { ref: branch, tree } = await repoTree(repo, ref);
  const files = tree.filter((t) => t.type === 'blob' && t.path.startsWith(`${folder}/`));
  const skillMd = files.find((f) => f.path === `${folder}/SKILL.md`);
  if (!skillMd) throw new Error(`No SKILL.md in ${repo}/${folder}`);
  if (files.length > MAX_FILES) throw new Error(`${folder} has ${files.length} files; that's more than a skill should`);
  const total = files.reduce((n, f) => n + (f.size ?? 0), 0);
  if (total > MAX_BYTES) throw new Error(`${folder} is ${(total / 1e6).toFixed(1)} MB; too big to import`);

  const fm = frontmatter((await rawFile(repo, branch, skillMd.path)).toString('utf8'));
  const name = safeName(fm.name ?? path.posix.basename(folder));
  const dest = path.join(SKILLS_DIR, name);
  if (fs.existsSync(dest) && !overwrite) throw new Error(`A skill named ${name} is already in the library`);
  const tmp = `${dest}.importing`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const rel = f.path.slice(folder.length + 1);
    const out = path.join(tmp, rel);
    if (!out.startsWith(tmp + path.sep)) continue; // no path tricks
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await rawFile(repo, branch, f.path));
  }
  writeSource(tmp, { from: 'github', repo, ref: branch, path: folder });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  return { name, files: files.length };
}

// ---------- ~/.claude/skills ----------

export function localCatalog(): CatalogSkill[] {
  if (!fs.existsSync(LOCAL_SKILLS)) return [];
  const installed = installedNames();
  return fs
    .readdirSync(LOCAL_SKILLS)
    .filter((d) => fs.existsSync(path.join(LOCAL_SKILLS, d, 'SKILL.md')))
    .map((d) => {
      const fm = frontmatter(fs.readFileSync(path.join(LOCAL_SKILLS, d, 'SKILL.md'), 'utf8'));
      const name = fm.name ?? d;
      return { name, description: fm.description ?? '', path: d, installed: installed.has(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function importLocal(folder: string, overwrite = false) {
  const src = path.join(LOCAL_SKILLS, path.basename(folder));
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`No SKILL.md in ${src}`);
  const fm = frontmatter(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'));
  const name = safeName(fm.name ?? folder);
  const dest = path.join(SKILLS_DIR, name);
  if (fs.existsSync(dest) && !overwrite) throw new Error(`A skill named ${name} is already in the library`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  writeSource(dest, { from: 'local', path: src });
  return { name };
}

// ---------- your own markdown ----------

export function importMarkdown(content: string, filename?: string, overwrite = false) {
  const text = content.replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('The file is empty');
  if (text.length > 512 * 1024) throw new Error('That skill is over 512 KB');
  let fm = frontmatter(text);
  let body = text;
  // A plain markdown file without frontmatter: name it after the file, describe it from its first heading.
  if (!fm.name || !fm.description) {
    const fallbackName = fm.name ?? filename?.replace(/\.md$/i, '').replace(/^SKILL$/i, '') ?? '';
    const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const description = fm.description ?? (heading ? `${heading}.` : '');
    if (!fallbackName) throw new Error('Add frontmatter with name: and description:, or upload it with a descriptive file name');
    if (!description) throw new Error('Add a description: to the frontmatter so agents know when to use it');
    fm = { name: fallbackName, description };
    body = text.replace(FRONTMATTER, '$2').trim();
    body = `---\nname: ${safeName(fallbackName)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
  }
  const name = safeName(fm.name!);
  const dest = path.join(SKILLS_DIR, name);
  if (fs.existsSync(dest) && !overwrite) throw new Error(`A skill named ${name} is already in the library`);
  fs.mkdirSync(dest, { recursive: true });
  // Keep the frontmatter name in sync with the folder name.
  const final = body.startsWith('---') ? body.replace(/^(---\n[\s\S]*?\bname:\s*)([^\n]+)/, `$1${name}`) : body;
  fs.writeFileSync(path.join(dest, 'SKILL.md'), final.endsWith('\n') ? final : final + '\n');
  writeSource(dest, { from: 'upload', file: filename ?? 'pasted' });
  return { name };
}

// ---------- removal ----------

export function deleteSkill(name: string) {
  const dir = path.join(SKILLS_DIR, path.basename(name));
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`No library skill named ${name}`);
  for (const a of loadRoster()) if (a.skills.includes(name)) setAgentSkills(a.id, a.skills.filter((s) => s !== name));
  fs.rmSync(dir, { recursive: true, force: true });
}
