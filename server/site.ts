import fs from 'node:fs';
import path from 'node:path';
import { BRAND, SITE_SNAPSHOT_DIR } from './config.ts';

/**
 * A plain-text snapshot of the brokerage website (virani.ca by default) in library/website/,
 * so agents and Sage can grep the team, listings, buildings, neighbourhoods, blog and testimonials
 * instead of fetching pages one at a time. Built from the Yoast sitemap; pages whose lastmod hasn't
 * changed are skipped, so a refresh only fetches what's new.
 */

type Entry = { url: string; lastmod: string | null; section: string };
export type SiteStatus = { running: boolean; startedAt: string | null; finishedAt: string | null; pages: number; fetched: number; failed: number; error: string | null };

const status: SiteStatus = { running: false, startedAt: null, finishedAt: null, pages: 0, fetched: 0, failed: 0, error: null };
const INDEX_FILE = () => path.join(SITE_SNAPSHOT_DIR, '_index.json');
const BOILERPLATE_FILE = () => path.join(SITE_SNAPSHOT_DIR, '_boilerplate.json');

function readBoilerplate(): string[] {
  try {
    return JSON.parse(fs.readFileSync(BOILERPLATE_FILE(), 'utf8'));
  } catch {
    return [];
  }
}
const UA = 'realty-crew snapshot (internal reference copy for the brokerage team)';

export function siteStatus(): SiteStatus & { site: string; saved: number } {
  let saved = 0;
  try {
    saved = Object.keys(JSON.parse(fs.readFileSync(INDEX_FILE(), 'utf8'))).length;
  } catch {
    /* none yet */
  }
  return { ...status, site: BRAND.site, saved };
}

async function get(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const locs = (xml: string) =>
  [...xml.matchAll(/<(?:url|sitemap)>[\s\S]*?<loc>([^<]+)<\/loc>(?:[\s\S]*?<lastmod>([^<]+)<\/lastmod>)?[\s\S]*?<\/(?:url|sitemap)>/g)].map((m) => ({
    loc: m[1].trim(),
    lastmod: m[2]?.trim() ?? null,
  }));

async function sitemapEntries(): Promise<Entry[]> {
  const index = await get(`${BRAND.site}/sitemap_index.xml`);
  const out: Entry[] = [];
  for (const sm of locs(index)) {
    // post-sitemap.xml -> "post"; taxonomy query sitemaps are just filtered listing pages, skip them.
    const section = path.basename(new URL(sm.loc).pathname).replace(/-sitemap\d*\.xml$/, '');
    if (/query|category|tag|author/.test(section)) continue;
    try {
      for (const u of locs(await get(sm.loc))) out.push({ url: u.loc, lastmod: u.lastmod, section });
    } catch (e) {
      console.error('[site]', (e as Error).message);
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™' };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m,
  );

/** Readable markdown-ish text from a WordPress page: headings, paragraphs, list items, table cells. */
export function htmlToText(html: string) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const description = decode(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] ?? '').trim();
  let body = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  body = body
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<(br|\/p|\/div|\/tr|\/section|\/article|\/ul|\/ol)[^>]*>/gi, '\n')
    .replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, ' [image: $1] ')
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ' ');
  const text = decode(body)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l, i, a) => l && l !== '-' && !(l === a[i - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { title, description, text };
}

function fileFor(e: Entry) {
  const slug = new URL(e.url).pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '__') || 'home';
  return path.join(SITE_SNAPSHOT_DIR, e.section, `${slug.slice(0, 150)}.md`);
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** Fetch new or changed pages. Polite: 3 at a time, with a short pause between requests. */
export async function refreshSite(onProgress?: () => void) {
  if (status.running) return;
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, pages: 0, fetched: 0, failed: 0, error: null });
  onProgress?.();
  try {
    fs.mkdirSync(SITE_SNAPSHOT_DIR, { recursive: true });
    let index: Record<string, { lastmod: string | null; file: string; title: string }> = {};
    try {
      index = JSON.parse(fs.readFileSync(INDEX_FILE(), 'utf8'));
    } catch {
      /* first run */
    }
    const entries = await sitemapEntries();
    status.pages = entries.length;
    const todo = entries.filter((e) => !index[e.url] || index[e.url].lastmod !== e.lastmod || !fs.existsSync(index[e.url].file));
    const pages: Array<{ e: Entry; title: string; description: string; lines: string[] }> = [];
    await pool(todo, 3, async (e) => {
      try {
        const { title, description, text } = htmlToText(await get(e.url));
        pages.push({ e, title, description, lines: text.split('\n') });
        status.fetched++;
      } catch (err) {
        status.failed++;
        console.error('[site]', (err as Error).message);
      }
      if (status.fetched % 25 === 0) onProgress?.();
      await new Promise((r) => setTimeout(r, 250));
    });
    // Site chrome (menus, language and currency pickers, sign-in modals, footers) repeats on most
    // pages. Learn it from a big enough batch and keep it, so small refreshes strip it too.
    let boilerplate = new Set<string>(readBoilerplate());
    if (pages.length >= 50) {
      const seen = new Map<string, number>();
      for (const p of pages) for (const l of new Set(p.lines)) seen.set(l, (seen.get(l) ?? 0) + 1);
      boilerplate = new Set([...seen].filter(([l, n]) => n >= pages.length * 0.3 && !l.startsWith('# ')).map(([l]) => l));
      fs.writeFileSync(BOILERPLATE_FILE(), JSON.stringify([...boilerplate], null, 1));
    }
    for (const { e, title, description, lines } of pages) {
      const body = lines.filter((l) => !boilerplate.has(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      const file = fileFor(e);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# ${title}\n\nURL: ${e.url}\nSection: ${e.section}\nLast modified: ${e.lastmod ?? 'unknown'}\n${description ? `Summary: ${description}\n` : ''}\n${body}\n`);
      index[e.url] = { lastmod: e.lastmod, file, title };
    }
    // Pages gone from the sitemap (sold listings taken down, deleted posts) leave the snapshot too.
    const live = new Set(entries.map((e) => e.url));
    for (const [url, v] of Object.entries(index)) {
      if (live.has(url)) continue;
      fs.rmSync(v.file, { force: true });
      delete index[url];
    }
    fs.writeFileSync(INDEX_FILE(), JSON.stringify(index, null, 1));
    writeOverview(index);
  } catch (e) {
    status.error = (e as Error).message;
  } finally {
    status.running = false;
    status.finishedAt = new Date().toISOString();
    onProgress?.();
  }
}

/** library/website/README.md: what's in the snapshot, by section, so agents know where to grep. */
function writeOverview(index: Record<string, { file: string; title: string }>) {
  const bySection = new Map<string, Array<{ url: string; title: string; file: string }>>();
  for (const [url, v] of Object.entries(index)) {
    const section = path.basename(path.dirname(v.file));
    bySection.set(section, [...(bySection.get(section) ?? []), { url, ...v }]);
  }
  const lines = [
    `# ${BRAND.name} website snapshot`,
    '',
    `Plain-text copy of ${BRAND.site}, refreshed automatically by the crew server (daily, and from the Library panel). Don't edit these files; they are overwritten.`,
    `Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. ${Object.keys(index).length} pages.`,
    '',
    'Grep this folder before fetching the live site. Sections:',
    '',
  ];
  for (const [section, items] of [...bySection].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- \`${section}/\` (${items.length})${section === 'team' ? ': ' + items.map((i) => i.title.split(/[-|–]/)[0].trim()).join(', ') : ''}`);
  }
  fs.writeFileSync(path.join(SITE_SNAPSHOT_DIR, 'README.md'), lines.join('\n') + '\n');
}

export function startSiteRefresh(onProgress: () => void) {
  const stale = () => {
    const done = status.finishedAt ?? (fs.existsSync(INDEX_FILE()) ? fs.statSync(INDEX_FILE()).mtime.toISOString() : null);
    return !done || Date.now() - Date.parse(done) > 20 * 3600_000;
  };
  if (stale()) refreshSite(onProgress);
  setInterval(() => stale() && refreshSite(onProgress), 3600_000).unref();
}
