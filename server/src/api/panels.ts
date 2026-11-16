import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Db } from '../db/index.js';
import { detectPanels, openPassword, PANEL_KEEP_DAYS, purgePanels, sealPassword } from '../ingest/panels.js';
import { intOrNull } from './util.js';

// "panel.example.org" or "https://panel.example.org/" -> a URL without the trailing slash
const domain = z
  .string()
  .trim()
  .max(300)
  .transform((v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v).replace(/\/+$/, ''))
  .refine((v) => !v || URL.canParse(v), 'bad_url')
  .transform((v) => v || null);

const editable = {
  name: z.string().trim().min(1).max(80),
  org: z.string().trim().max(40),
  panel_domain: domain.nullable(),
  quota_domain: domain.nullable(),
  notes: z.string().max(2000),
  password: z.string().max(200).nullable(),
};
const createBody = z.object(editable).partial().required({ name: true });
const patchBody = z.object(editable).partial();

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'invalid';

interface Check {
  ok: boolean;
  code?: number;
  ms?: number;
  error?: string;
}

/** Any HTTP answer counts as reachable (a login page or redirect is fine); only no answer is a failure. */
async function check(url: string | null): Promise<Check | null> {
  if (!url) return null;
  const t = Date.now();
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await r.body?.cancel();
    return { ok: r.status < 500, code: r.status, ms: Date.now() - t };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code ?? (err.name === 'TimeoutError' ? 'TIMEOUT' : err.message);
    return { ok: false, error: code };
  }
}

export function registerPanelsApi(app: FastifyInstance, db: Db, sourcesDir: string, secret: string) {
  app.get('/api/panels', async () => {
    const r = await db.query(
      `SELECT p.id, p.source_id, p.name, p.org, p.container, p.quota_port, p.panel_domain, p.quota_domain, p.notes, p.password_enc IS NOT NULL AS has_password, p.password_from, p.password_at,
              p.deleted_at, p.deleted_at + interval '${PANEL_KEEP_DAYS} days' AS purge_at,
              p.updated_at, s.name AS source_name, s.label AS source_label, s.missing_since, s.last_sync_at,
              u.requests_today, u.tokens_today, u.requests_30d, u.last_request_at, u.clients, u.keys
       FROM panels p
       LEFT JOIN sources s ON s.id = p.source_id
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE r.ts >= date_trunc('day', now() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran')::int AS requests_today,
                COALESCE(sum(r.input_tokens + r.output_tokens) FILTER (WHERE r.ts >= date_trunc('day', now() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran'), 0)::bigint AS tokens_today,
                count(*)::int AS requests_30d, max(r.ts) AS last_request_at,
                count(DISTINCT NULLIF(r.client, ''))::int AS clients,
                (SELECT count(*)::int FROM users k WHERE k.source_id = p.source_id AND k.merged_into IS NULL) AS keys
         FROM requests r WHERE r.source_id = p.source_id AND r.ts > now() - interval '30 days') u ON p.source_id IS NOT NULL
       WHERE p.purged_at IS NULL
       ORDER BY s.missing_since IS NOT NULL, p.org = '', p.org, p.name`,
    );
    return { panels: r.rows.map((p) => ({ ...p, tokens_today: Number(p.tokens_today ?? 0) })), keep_days: PANEL_KEEP_DAYS };
  });

  // re-reads every compose file now instead of within the next minute
  app.post('/api/panels/detect', async () => {
    await detectPanels(db, sourcesDir);
    return { ok: true };
  });

  // Live state checked from this server: the 9router itself (by container name on 9router-net) and both domains.
  app.get('/api/panels/status', async () => {
    const rows = (await db.query('SELECT id, container, panel_domain, quota_domain FROM panels WHERE deleted_at IS NULL')).rows;
    const out: Record<number, Record<string, Check | null>> = {};
    await Promise.all(
      rows.map(async (p) => {
        const [a, c, d] = await Promise.all([
          check(p.container ? `http://${p.container}:20128` : null),
          check(p.panel_domain),
          check(p.quota_domain ? `${p.quota_domain}/quota` : null),
        ]);
        out[p.id] = { router: a, panel_domain: c, quota_domain: d };
      }),
    );
    return { status: out, checked_at: new Date().toISOString() };
  });

  app.get('/api/panels/:id/password', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = (await db.query('SELECT password_enc FROM panels WHERE id=$1', [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    reply.header('cache-control', 'no-store');
    if (!r.password_enc) return { password: null };
    try {
      return { password: openPassword(secret, r.password_enc) };
    } catch {
      // the session secret changed since it was saved
      return reply.code(409).send({ error: 'password_unreadable' });
    }
  });

  const setFields = (b: z.infer<typeof patchBody>) => {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      if (k === 'password') {
        vals.push(v ? sealPassword(secret, v as string) : null, v ? 'دستی' : null);
        cols.push(`password_enc=$${vals.length - 1}`, `password_from=$${vals.length}`, 'password_at=now()');
      } else {
        vals.push(v);
        cols.push(`${k}=$${vals.length}`);
      }
    }
    return { cols, vals };
  };

  app.post('/api/panels', async (req, reply) => {
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: firstIssue(b.error) });
    const r = await db.query(`INSERT INTO panels(name) VALUES($1) RETURNING id`, [b.data.name]);
    const id = r.rows[0].id as number;
    const { cols, vals } = setFields(b.data);
    if (cols.length) await db.query(`UPDATE panels SET ${cols.join(', ')} WHERE id=$${vals.length + 1}`, [...vals, id]);
    return { id };
  });

  app.patch('/api/panels/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: firstIssue(b.error) });
    const { cols, vals } = setFields(b.data);
    if (!cols.length) return { ok: true };
    const r = await db.query(`UPDATE panels SET ${cols.join(', ')}, updated_at=now() WHERE id=$${vals.length + 1} AND purged_at IS NULL`, [...vals, id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Moves a panel to the deleted list for PANEL_KEEP_DAYS; ?now=1 on an already deleted one purges it at once.
  // Nothing is done to the 9router itself.
  app.delete('/api/panels/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    if ((req.query as { now?: string }).now === '1') {
      if (!(await purgePanels(db, id))) return reply.code(409).send({ error: 'not_deleted' });
      return { ok: true, purged: true };
    }
    const r = await db.query('UPDATE panels SET deleted_at=COALESCE(deleted_at, now()) WHERE id=$1 AND purged_at IS NULL', [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post('/api/panels/:id/restore', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = await db.query('UPDATE panels SET deleted_at=NULL WHERE id=$1 AND purged_at IS NULL', [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
