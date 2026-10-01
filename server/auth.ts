import http from 'node:http';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

/**
 * A single shared login for the hosted crew. Set CREW_PASSWORD in .env to turn it on
 * (it's off when unset, e.g. on localhost). A signed cookie keeps you in for 30 days.
 */

const PASSWORD = process.env.CREW_PASSWORD?.trim() || '';
export const AUTH_ON = PASSWORD.length > 0;
const COOKIE = 'crew_session';
const MAX_AGE_S = 30 * 86400;

// The signing key survives restarts so sessions do too; rotate it by deleting the file.
const KEY_FILE = path.join(DATA_DIR, 'session.key');
function signingKey() {
  try {
    return fs.readFileSync(KEY_FILE);
  } catch {
    const k = randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
    return k;
  }
}
const KEY = AUTH_ON ? signingKey() : Buffer.alloc(0);

const sign = (v: string) => createHmac('sha256', KEY).update(v).digest('base64url');

function cookieValue() {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  return `${exp}.${sign(String(exp))}`;
}

function validCookie(req: http.IncomingMessage) {
  const raw = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

function passwordMatches(given: string) {
  // Compare fixed-length derived keys so timing doesn't leak the password length.
  const salt = 'realty-crew';
  return timingSafeEqual(scryptSync(given, salt, 32), scryptSync(PASSWORD, salt, 32));
}

// Slow down guessing: 10 failures per IP per 15 minutes.
const failures = new Map<string, { n: number; since: number }>();
function tooMany(ip: string) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60_000) return false;
  return f.n >= 10;
}
function failed(ip: string) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60_000) failures.set(ip, { n: 1, since: Date.now() });
  else f.n++;
}

const page = (error = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Realty Crew</title>
<style>
:root{--bg:#f6f5f1;--panel:#fff;--line:#e2dfd6;--text:#1d1b16;--muted:#6d685c;--accent:#8a6a3c;--bad:#b3261e;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#14130f;--panel:#1c1b16;--line:#34312a;--text:#ece8dc;--muted:#a19b8b;--accent:#c9a46a;--bad:#f08a80;color-scheme:dark}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:16px;box-sizing:border-box}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px;width:100%;max-width:340px;display:grid;gap:14px}
h1{margin:0;font-size:20px}p{margin:0;color:var(--muted);font-size:13.5px}
input{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
button{font:inherit;font-weight:600;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--bad);font-size:13.5px}
</style></head><body>
<form method="post" action="/login">
<h1>Realty Crew</h1><p>Sign in to continue.</p>
${error ? `<div class="err">${error}</div>` : ''}
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button>Sign in</button>
</form></body></html>`;

function clientIp(req: http.IncomingMessage) {
  return String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

/**
 * Handles /login and /logout, and stops unauthenticated requests.
 * Returns true when it has answered the request.
 */
export async function gate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!AUTH_ON) return false;
  const secure = req.headers['x-forwarded-proto'] === 'https';
  if (url.pathname === '/login' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) break;
    }
    const ip = clientIp(req);
    const given = new URLSearchParams(raw).get('password') ?? '';
    if (tooMany(ip)) {
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Too many attempts. Try again in 15 minutes.'));
      return true;
    }
    if (!passwordMatches(given)) {
      failed(ip);
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('That password is not right.'));
      return true;
    }
    failures.delete(ip);
    res.writeHead(303, {
      location: '/',
      'set-cookie': `${COOKIE}=${cookieValue()}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    });
    res.end();
    return true;
  }
  if (url.pathname === '/logout') {
    res.writeHead(303, { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}` });
    res.end();
    return true;
  }
  if (validCookie(req)) {
    if (url.pathname === '/login') {
      res.writeHead(303, { location: '/' });
      res.end();
      return true;
    }
    return false;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Signed out. Reload the page to sign in.' }));
    return true;
  }
  res.writeHead(url.pathname === '/login' ? 200 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page());
  return true;
}
