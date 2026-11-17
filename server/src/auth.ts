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

declare module 'fastify' {
  interface FastifyRequest {
    /** set after the session cookie is checked; null on public routes */
    role: 'admin' | 'super' | null;
  }
}

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

/** Optional second password. Same login field; this one can delete prompts and open the archive. */
export async function ensureSuper(db: Db, cfg: Config, log: { warn: (m: string) => void }): Promise<void> {
  const existing = await getSetting<string | null>(db, 'super_hash', null);
  if (!cfg.superPassword) return;
  if (existing && !cfg.resetSuperPassword) return;
  const adminHash = await getSetting<string>(db, 'admin_hash', '');
  if (adminHash && (await argon2.verify(adminHash, cfg.superPassword).catch(() => false))) {
    log.warn('SUPER_PASSWORD matches the admin password; super login was not set. Use a different password.');
    return;
  }
  await setSetting(db, 'super_hash', await argon2.hash(cfg.superPassword));
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

export function requireSuper(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.role === 'super') return true;
  reply.code(403).send({ error: 'forbidden' });
  return false;
}

export function registerAuth(app: FastifyInstance, db: Db, cfg: Config, secret: string) {
  // The signing key mixes in both hashes, so changing either password logs every session out.
  const keyFor = async () =>
    createHash('sha256')
      .update(secret + (await getSetting<string>(db, 'admin_hash', '')) + ':' + (await getSetting<string>(db, 'super_hash', '')))
      .digest();
  const fails = new Map<string, { n: number; until: number }>();

  const readSession = async (req: FastifyRequest): Promise<'admin' | 'super' | null> => {
    const raw = req.cookies[COOKIE];
    if (!raw) return null;
    const parts = raw.split('.');
    const exp = parts[0];
    const roleFlag = parts.length === 3 ? parts[1] : 'a';
    const mac = parts.length === 3 ? parts[2] : parts[1];
    if (!exp || !mac || Number(exp) < Date.now()) return null;
    const payload = parts.length === 3 ? `${exp}.${roleFlag}` : exp;
    const want = sign(await keyFor(), payload);
    const a = Buffer.from(mac);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return roleFlag === 's' ? 'super' : 'admin';
  };

  const issue = async (reply: FastifyReply, role: 'admin' | 'super') => {
    const exp = String(Date.now() + SESSION_MS);
    const flag = role === 'super' ? 's' : 'a';
    const payload = `${exp}.${flag}`;
    reply.setCookie(COOKIE, `${payload}.${sign(await keyFor(), payload)}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cfg.cookieSecure,
      path: '/',
      maxAge: SESSION_MS / 1000,
    });
  };

  app.addHook('onRequest', async (req, reply) => {
    req.role = null;
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || url === '/api/auth/login' || url === '/api/auth/me') return;
    const role = await readSession(req);
    if (!role) return reply.code(401).send({ error: 'unauthorized' });
    req.role = role;
  });

  app.get('/api/auth/me', async (req) => {
    const role = await readSession(req);
    return { authenticated: !!role, super: role === 'super' };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ password: z.string().min(1).max(256) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    if (fails.size > 5000) for (const [ip, v] of fails) if (v.until < Date.now()) fails.delete(ip);
    const f = fails.get(req.ip);
    if (f && f.until > Date.now()) {
      return reply.code(429).send({ error: 'locked', retryAfterSec: Math.ceil((f.until - Date.now()) / 1000) });
    }
    const pw = body.data.password;
    const adminHash = await getSetting<string>(db, 'admin_hash', '');
    const superHash = await getSetting<string | null>(db, 'super_hash', null);
    const superOk = superHash ? await argon2.verify(superHash, pw).catch(() => false) : false;
    const adminOk = adminHash ? await argon2.verify(adminHash, pw).catch(() => false) : false;
    if (!superOk && !adminOk) {
      const n = (f?.n ?? 0) + 1;
      fails.set(req.ip, { n: n >= MAX_FAILS ? 0 : n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      return reply.code(401).send({ error: 'bad_password', remaining: Math.max(0, MAX_FAILS - n) });
    }
    fails.delete(req.ip);
    const role = superOk ? 'super' : 'admin';
    await issue(reply, role);
    return { ok: true, super: role === 'super' };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  const otherMatches = async (hashKey: 'admin_hash' | 'super_hash', pw: string) => {
    const hash = await getSetting<string | null>(db, hashKey, null);
    return hash ? argon2.verify(hash, pw).catch(() => false) : false;
  };

  app.post('/api/auth/password', async (req, reply) => {
    const body = z.object({ current: z.string().min(1), next: z.string().min(8).max(256) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'password_too_short' });
    const hash = await getSetting<string>(db, 'admin_hash', '');
    if (!(await argon2.verify(hash, body.data.current).catch(() => false))) return reply.code(403).send({ error: 'bad_password' });
    if (await otherMatches('super_hash', body.data.next)) return reply.code(400).send({ error: 'password_same' });
    await setSetting(db, 'admin_hash', await argon2.hash(body.data.next));
    await issue(reply, req.role === 'super' ? 'super' : 'admin');
    return { ok: true };
  });

  app.post('/api/auth/super-password', async (req, reply) => {
    if (!requireSuper(req, reply)) return;
    const body = z.object({ current: z.string().min(1), next: z.string().min(8).max(256) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'password_too_short' });
    const hash = await getSetting<string | null>(db, 'super_hash', null);
    if (!hash || !(await argon2.verify(hash, body.data.current).catch(() => false))) return reply.code(403).send({ error: 'bad_password' });
    if (await otherMatches('admin_hash', body.data.next)) return reply.code(400).send({ error: 'password_same' });
    await setSetting(db, 'super_hash', await argon2.hash(body.data.next));
    await issue(reply, 'super');
    return { ok: true };
  });
}
