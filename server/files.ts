import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_DIR, OUTPUTS_DIR } from './config.ts';

/**
 * Two file areas the UI can browse, upload into and download from:
 * - library/: reference material every agent reads (forms, rules, brand, past magazines, market data).
 * - data/outputs/<task>/: what an agent produced for one task, plus files attached to it.
 */

export type FileEntry = { path: string; name: string; dir: boolean; size: number; modified: string };

/** Resolve a user-supplied relative path inside root, or null if it escapes. */
export function safeJoin(root: string, rel: string): string | null {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((p) => p === '..')) return null;
  const abs = path.resolve(root, clean);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

const HIDDEN = /^\.|^node_modules$/;

export function listTree(root: string, maxEntries = 2000): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (HIDDEN.test(e.name) || out.length >= maxEntries) continue;
      const abs = path.join(dir, e.name);
      const st = fs.statSync(abs);
      out.push({ path: path.relative(root, abs), name: e.name, dir: e.isDirectory(), size: st.size, modified: st.mtime.toISOString() });
      if (e.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out;
}

export function taskDir(taskId: string) {
  if (!/^[a-z0-9-]+$/i.test(taskId)) throw new Error('Bad task id');
  const dir = path.join(OUTPUTS_DIR, taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function taskFiles(taskId: string): FileEntry[] {
  const dir = path.join(OUTPUTS_DIR, taskId);
  return fs.existsSync(dir) ? listTree(dir) : [];
}

export function removeTaskDir(taskId: string) {
  if (!/^[a-z0-9-]+$/i.test(taskId)) return;
  fs.rmSync(path.join(OUTPUTS_DIR, taskId), { recursive: true, force: true });
}

/** A file name safe to write: no folders, no leading dots, nothing odd. */
export function cleanName(name: string) {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[^\w.\- ()&,'+]/g, '_').replace(/^\.+/, '').trim();
  return base.slice(0, 160) || 'upload';
}

/** Library layout with what goes where; the README in each folder tells agents the same thing. */
export function libraryReady() {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  return LIBRARY_DIR;
}

const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', '.html': 'text/plain; charset=utf-8', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function contentType(file: string) {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
