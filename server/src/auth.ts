import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Config } from './config.js';
import { Db, getSetting, setSetting } from './db/index.js';

const COOKIE = 'pd_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** Loads the admin hash, creating it from ADMIN_PASSWORD on first start (or when a reset is requested). */
export async function ensureAdmin(db: Db, cfg: Config, log: { warn: (m: string) => void }): Promise<void> {
  const existing = await getSetting<string | null>(db, 'admin_hash', null);
  if (existing && !cfg.resetAdminPassword) return;
  let pw = cfg.adminPassword;
  if (!pw) {
    pw = randomBytes(9).toString('base64url');
    log.warn(`ADMIN_PASSWORD is not set. Generated a one-time admin password: ${pw}`);
  }
  await setSetting(db, 'admin_hash', await argon2.hash(pw));
}

export async function ensureSecret(db: Db, cfg: Config): Promise<string> {
  if (cfg.sessionSecret) return cfg.sessionSecret;
  let s = await getSetting<string | null>(db, 'session_secret', null);
  if (!s) {
    s = randomBytes(32).toString('hex');
    await setSetting(db, 'session_secret', s);
  }
  return s;
}

const sign = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

export function registerAuth(app: FastifyInstance, db: Db, cfg: Config, secret: string) {
  // The signing key mixes in the password hash, so changing the password logs every session out.
  const keyFor = async () => createHash('sha256').update(secret + (await getSetting<string>(db, 'admin_hash', ''))).digest();
  const fails = new Map<string, { n: number; until: number }>();

  const valid = async (req: FastifyRequest): Promise<boolean> => {
    const raw = req.cookies[COOKIE];
    if (!raw) return false;
    const [exp, mac] = raw.split('.');
    if (!exp || !mac || Number(exp) < Date.now()) return false;
    const want = sign(await keyFor(), exp);
    const a = Buffer.from(mac);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const issue = async (reply: FastifyReply) => {
    const exp = String(Date.now() + SESSION_MS);
    reply.setCookie(COOKIE, `${exp}.${sign(await keyFor(), exp)}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cfg.cookieSecure,
      path: '/',
      maxAge: SESSION_MS / 1000,
    });
  };

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || url === '/api/auth/login' || url === '/api/auth/me') return;
    if (!(await valid(req))) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/api/auth/me', async (req) => ({ authenticated: await valid(req) }));

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ password: z.string().min(1).max(256) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    // keep the map small when many addresses try
    if (fails.size > 5000) for (const [ip, v] of fails) if (v.until < Date.now()) fails.delete(ip);
    const f = fails.get(req.ip);
    if (f && f.until > Date.now()) {
      return reply.code(429).send({ error: 'locked', retryAfterSec: Math.ceil((f.until - Date.now()) / 1000) });
    }
    const hash = await getSetting<string>(db, 'admin_hash', '');
    const ok = hash ? await argon2.verify(hash, body.data.password).catch(() => false) : false;
    if (!ok) {
      const n = (f?.n ?? 0) + 1;
      fails.set(req.ip, { n: n >= MAX_FAILS ? 0 : n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      return reply.code(401).send({ error: 'bad_password', remaining: Math.max(0, MAX_FAILS - n) });
    }
    fails.delete(req.ip);
    await issue(reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const body = z.object({ current: z.string().min(1), next: z.string().min(8).max(256) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'password_too_short' });
    const hash = await getSetting<string>(db, 'admin_hash', '');
    if (!(await argon2.verify(hash, body.data.current).catch(() => false))) return reply.code(403).send({ error: 'bad_password' });
    await setSetting(db, 'admin_hash', await argon2.hash(body.data.next));
    await issue(reply); // keep the current browser logged in with the new key
    return { ok: true };
  });
}
