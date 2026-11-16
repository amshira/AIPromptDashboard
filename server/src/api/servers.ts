import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Db } from '../db/index.js';
import { AgentConn, agentFetch, normCert } from '../ingest/reader.js';
import { MIN_SELF_UPDATE, readAgentExe } from '../ingest/agentUpdate.js';
import { discoverRemote, syncSource } from '../ingest/sync.js';
import { intOrNull } from './util.js';

const urlField = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'bad_url')
  .transform((u) => u.replace(/\/+$/, ''));
const tokenField = z.string().trim().min(16).max(200);
// SHA-256 of a Windows agent's certificate, with or without colons
const certField = z
  .string()
  .trim()
  .transform(normCert)
  .refine((c) => /^[0-9a-f]{64}$/.test(c), 'bad_cert');

const connBody = z
  .object({ url: urlField, token: tokenField, cert: certField.nullish() })
  // a paired agent: https only, and the token is its 32-byte hex key
  .refine((v) => !v.cert || (v.url.startsWith('https://') && /^[0-9a-f]{64,}$/i.test(v.token)), 'bad_pairing');

const createBody = z.intersection(
  z.object({
    name: z.string().trim().regex(/^[A-Za-z0-9._-]{1,40}$/, 'bad_name'),
    label: z.string().trim().max(80).optional(),
  }),
  connBody,
);
const patchBody = z.object({ label: z.string().trim().max(80).optional(), url: urlField.optional(), token: tokenField.optional(), enabled: z.boolean().optional() });

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'invalid';

async function probe(conn: AgentConn) {
  try {
    const r = await agentFetch<{ sources: Array<{ name: string }> }>(conn, 'sources');
    return { ok: true as const, sources: r.sources.map((s) => s.name) };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

/** Remote servers whose 9routers are read through the agent (see agent.ts). Tokens are write-only. */
export function registerServersApi(app: FastifyInstance, db: Db, sourcesDir: string, agentBinDir?: string) {
  const syncAllOf = async (serverId: number) => {
    const { rows } = await db.query('SELECT id FROM sources WHERE server_id=$1 AND enabled', [serverId]);
    for (const r of rows) void syncSource(db, sourcesDir, r.id, 'manual').catch(() => undefined);
  };

  app.get('/api/servers', async () => {
    const r = await db.query(
      `SELECT v.id, v.name, v.label, v.url, v.enabled, v.last_seen_at, v.last_error, v.created_at,
              CASE WHEN v.cert_sha256 IS NULL THEN 'server' ELSE 'windows' END AS kind,
              (SELECT count(*)::int FROM sources WHERE server_id=v.id) AS source_count
       FROM servers v ORDER BY v.id`,
    );
    return { servers: r.rows };
  });

  // Paired Windows PCs: who is on each (from the agent's last answer) and what was read from each profile.
  app.get('/api/pcs', async () => {
    const r = await db.query(
      `SELECT v.id, v.name, v.label, v.url, v.enabled, v.last_seen_at, v.last_error, v.created_at, v.info,
              COALESCE((SELECT json_agg(json_build_object(
                         'id', s.id, 'remote_name', s.remote_name, 'last_sync_at', s.last_sync_at, 'last_error', s.last_error,
                         'requests', (SELECT count(*) FROM requests q WHERE q.source_id = s.id),
                         'last_at', (SELECT max(q.ts) FROM requests q WHERE q.source_id = s.id)) ORDER BY s.remote_name)
                        FROM sources s WHERE s.server_id = v.id), '[]'::json) AS sources
       FROM servers v WHERE v.cert_sha256 IS NOT NULL ORDER BY v.label, v.id`,
    );
    const exe = agentBinDir ? readAgentExe(agentBinDir) : null;
    return { pcs: r.rows, agent: exe?.version ? { version: exe.version, min: MIN_SELF_UPDATE } : null };
  });

  // Ask every paired PC again now (who is on it, new profiles) instead of waiting for the schedule.
  app.post('/api/pcs/refresh', async () => {
    const { rows } = await db.query('SELECT id FROM servers WHERE cert_sha256 IS NOT NULL AND enabled');
    const res = await Promise.allSettled(rows.map((r) => discoverRemote(db, r.id)));
    return { checked: rows.length, reachable: res.filter((x) => x.status === 'fulfilled').length };
  });

  // Try a URL + token before saving them.
  app.post('/api/servers/probe', async (req, reply) => {
    const b = connBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: firstIssue(b.error) });
    return probe(b.data);
  });

  app.post('/api/servers', async (req, reply) => {
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: firstIssue(b.error) });
    const v = b.data;
    const exists = await db.query('SELECT 1 FROM servers WHERE name=$1', [v.name]);
    if (exists.rowCount) return reply.code(409).send({ error: 'name_taken' });
    const p = await probe(v);
    if (!p.ok) return reply.code(422).send({ error: p.error });
    const r = await db.query('INSERT INTO servers(name,label,url,token,cert_sha256) VALUES($1,$2,$3,$4,$5) RETURNING id', [
      v.name,
      v.label || v.name,
      v.url,
      v.token,
      v.cert ?? null,
    ]);
    const id = r.rows[0].id as number;
    const count = await discoverRemote(db, id);
    await syncAllOf(id);
    return { id, sources: count };
  });

  app.patch('/api/servers/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    const b = patchBody.safeParse(req.body ?? {});
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    if (!b.success) return reply.code(400).send({ error: firstIssue(b.error) });
    const v = b.data;
    await db.query(
      `UPDATE servers SET label=COALESCE(NULLIF($2,''),label), url=COALESCE($3,url), token=COALESCE($4,token), enabled=COALESCE($5,enabled) WHERE id=$1`,
      [id, v.label ?? null, v.url ?? null, v.token ?? null, v.enabled ?? null],
    );
    if (v.label) await db.query(`UPDATE sources SET label = $2 || ' / ' || remote_name WHERE server_id=$1`, [id, v.label]);
    return { ok: true };
  });

  // Re-ask the agent for its 9routers (picks up newly added ones) and sync them now.
  app.post('/api/servers/:id/refresh', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    try {
      const count = await discoverRemote(db, id);
      await syncAllOf(id);
      return { ok: true, sources: count };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Removes the server, its sources and everything ingested from them.
  app.delete('/api/servers/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    await db.query('DELETE FROM sources WHERE server_id=$1', [id]);
    await db.query('DELETE FROM servers WHERE id=$1', [id]);
    return { ok: true };
  });
}
