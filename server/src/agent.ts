import { existsSync, readdirSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import { sqliteReader } from './ingest/reader.js';

// no leading dot, so '..' cannot climb out of sourcesDir
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

/**
 * Read-only agent for a server that runs 9router but not the dashboard. It serves the rows of every
 * `<sourcesDir>/<name>/data.sqlite` over HTTP to a dashboard that knows the shared token.
 */
export async function buildAgent(opts: { sourcesDir: string; token: string; logger?: boolean }) {
  if (opts.token.length < 16) throw new Error('AGENT_TOKEN must be at least 16 characters');
  const want = Buffer.from(opts.token);
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: false });

  app.get('/healthz', async () => ({ ok: true, agent: true }));

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/agent/')) return;
    const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send({ error: 'unauthorized' });
  });

  const fileOf = (name: unknown) => {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
    const f = join(opts.sourcesDir, name, 'data.sqlite');
    return existsSync(f) ? f : null;
  };

  app.get('/agent/v1/sources', async () => {
    const out: Array<{ name: string }> = [];
    if (existsSync(opts.sourcesDir))
      for (const n of readdirSync(opts.sourcesDir).sort()) if (NAME_RE.test(n) && statSync(join(opts.sourcesDir, n)).isDirectory() && fileOf(n)) out.push({ name: n });
    return { sources: out };
  });

  app.get('/agent/v1/oldest', async (req, reply) => {
    const f = fileOf((req.query as { source?: string }).source);
    if (!f) return reply.code(404).send({ error: 'unknown_source' });
    const r = sqliteReader(f);
    try {
      return { oldest: await r.oldest() };
    } finally {
      r.close();
    }
  });

  app.get('/agent/v1/rows', async (req, reply) => {
    const q = req.query as { source?: string; ts?: string; id?: string; limit?: string };
    const f = fileOf(q.source);
    if (!f) return reply.code(404).send({ error: 'unknown_source' });
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
    const r = sqliteReader(f);
    try {
      return { rows: await r.batch(q.ts ?? '', q.id ?? '', limit) };
    } finally {
      r.close();
    }
  });

  app.get('/agent/v1/keys', async (req, reply) => {
    const q = req.query as { source?: string; from?: string; to?: string };
    const f = fileOf(q.source);
    if (!f) return reply.code(404).send({ error: 'unknown_source' });
    const r = sqliteReader(f);
    try {
      return await r.keyInfo(q.from ?? '', q.to ?? '9999');
    } finally {
      r.close();
    }
  });

  return app;
}
