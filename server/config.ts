import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CREW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Who the crew works for. Used in prompts and the UI ("Needs you", "Stopped by ..."). */
export const OWNER = process.env.CREW_OWNER?.trim() || 'the realtor';
export const BRAND = {
  name: process.env.CREW_BRAND?.trim() || 'Virani Real Estate Advisors',
  site: (process.env.CREW_SITE?.trim() || 'https://virani.ca').replace(/\/+$/, ''),
};

export const DATA_DIR = process.env.CREW_DATA_DIR ?? path.join(CREW_ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'crew.db');
/** One folder per task: what the agent produced (drafts, CMAs, brochure copy, exports) plus anything uploaded with the task. */
export const OUTPUTS_DIR = path.join(DATA_DIR, 'outputs');
/** Reference material every agent can read: forms, rules, brand, past magazines, market data. */
export const LIBRARY_DIR = process.env.CREW_LIBRARY_DIR ?? path.join(CREW_ROOT, 'library');
/** A text snapshot of the brokerage website, refreshed by the server. Lives inside the library. */
export const SITE_SNAPSHOT_DIR = path.join(LIBRARY_DIR, 'website');
export const AGENTS_DIR = path.join(CREW_ROOT, 'agents');
export const MEMORY_DIR = path.join(CREW_ROOT, 'memory');
export const UI_DIR = path.join(CREW_ROOT, 'ui');
/** The crew's skill library, loaded into every agent as the local plugin "realty-crew". */
export const SKILLS_PLUGIN_DIR = path.join(CREW_ROOT, 'skills');
export const SKILLS_DIR = path.join(SKILLS_PLUGIN_DIR, 'skills');
export const PLUGIN_NAME = 'realty-crew';

/** 127.0.0.1 locally; 0.0.0.0 inside Docker, where Caddy (with the login) is the only way in. */
export const HOST = process.env.HOST ?? '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 4477);
/** The public origin (e.g. https://realtytorealty.com), accepted for writes alongside localhost. */
export const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN?.replace(/\/+$/, '') ?? null;

/** Hard cap on agents running at once (each is a Claude Code process). */
export const MAX_CONCURRENT = 2;

export const DEFAULTS = {
  autorun: true,
  /** At most MAX_CONCURRENT; the droplet hosts other sites too. */
  maxConcurrent: 2,
  /** Bill an API key instead of the claude.ai login. Only honoured when ANTHROPIC_API_KEY is set. */
  useApiKey: false,
  /** Browser notifications when agents need the owner or finish. */
  notifications: true,
  /** Seconds between starting queued tasks. */
  startGapSeconds: 10,
};

/** True when the server was started with an API key in its environment (e.g. from .env). */
export const API_KEY_AVAILABLE = !!process.env.ANTHROPIC_API_KEY?.trim();

/** Upload limit for the library and task attachments. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
