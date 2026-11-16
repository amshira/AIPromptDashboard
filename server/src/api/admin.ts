import { statfs } from 'node:fs/promises';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Db, getSetting, setSetting } from '../db/index.js';
import { Schedule, nextRuns, runRetention, runSchedule, validateCron } from '../scheduler.js';
import { intOrNull } from './util.js';

const scheduleBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    source_ids: z.array(z.number().int()).default([]),
    mode: z.enum(['interval', 'cron']),
    every_min: z.number().int().min(1).max(1440).nullable().default(null),
    cron: z.string().trim().max(120).nullable().default(null),
    days: z.array(z.number().int().min(0).max(6)).nullable().default(null),
    from_hour: z.number().int().min(0).max(23).nullable().default(null),
    to_hour: z.number().int().min(0).max(24).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'interval' && !v.every_min) ctx.addIssue({ code: 'custom', message: 'every_min_required' });
    if (v.mode === 'cron') {
      const err = v.cron ? validateCron(v.cron) : 'cron_required';
      if (err) ctx.addIssue({ code: 'custom', message: `bad_cron: ${err}` });
    }
    if ((v.from_hour == null) !== (v.to_hour == null)) ctx.addIssue({ code: 'custom', message: 'hours_pair' });
  });

const preview = (s: Schedule) => nextRuns(s, new Date(), 5).map((d) => d.toISOString());

export function registerAdminApi(app: FastifyInstance, db: Db, sourcesDir: string, version: string) {
  // ---------- schedules ----------
  app.get('/api/schedules', async () => {
    const r = await db.query('SELECT * FROM schedules ORDER BY id');
    return { schedules: (r.rows as Schedule[]).map((s) => ({ ...s, next_runs: s.enabled ? preview(s) : [] })) };
  });

  app.post('/api/schedules/preview', async (req, reply) => {
    const b = scheduleBody.safeParse({ name: 'x', ...(req.body as object) });
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'invalid' });
    return { next_runs: preview({ ...b.data, id: 0, last_run_at: null } as Schedule) };
  });

  const save = async (id: number | null, body: unknown) => {
    const b = scheduleBody.safeParse(body);
    if (!b.success) return { error: b.error.issues[0]?.message ?? 'invalid' };
    const v = b.data;
    const vals = [v.name, v.source_ids, v.mode, v.mode === 'interval' ? v.every_min : null, v.mode === 'cron' ? v.cron : null, v.days?.length ? v.days : null, v.from_hour, v.to_hour, v.enabled];
    if (id) {
      await db.query(`UPDATE schedules SET name=$2, source_ids=$3, mode=$4, every_min=$5, cron=$6, days=$7, from_hour=$8, to_hour=$9, enabled=$10 WHERE id=$1`, [id, ...vals]);
      return { id };
    }
    const r = await db.query(`INSERT INTO schedules(name, source_ids, mode, every_min, cron, days, from_hour, to_hour, enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, vals);
    return { id: r.rows[0].id as number };
  };

  app.post('/api/schedules', async (req, reply) => {
    const r = await save(null, req.body);
    return 'error' in r ? reply.code(400).send(r) : r;
  });
  app.put('/api/schedules/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = await save(id, req.body);
    return 'error' in r ? reply.code(400).send(r) : r;
  });
  app.delete('/api/schedules/:id', async (req) => {
    await db.query('DELETE FROM schedules WHERE id=$1', [intOrNull((req.params as { id: string }).id)]);
    return { ok: true };
  });
  app.post('/api/schedules/:id/run', async (req, reply) => {
    const s = (await db.query('SELECT * FROM schedules WHERE id=$1', [intOrNull((req.params as { id: string }).id)])).rows[0] as Schedule | undefined;
    if (!s) return reply.code(404).send({ error: 'not_found' });
    void runSchedule(db, sourcesDir, s, 'manual').catch((e) => req.log.error(e, 'manual schedule run failed'));
    return reply.code(202).send({ ok: true });
  });

  app.get('/api/runs', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(500, intOrNull(q.limit) ?? 100);
    const src = intOrNull(q.source);
    const r = await db.query(
      `SELECT r.*, s.label AS source, sc.name AS schedule FROM sync_runs r JOIN sources s ON s.id=r.source_id LEFT JOIN schedules sc ON sc.id=r.schedule_id
       WHERE ($1::int IS NULL OR r.source_id=$1) ORDER BY r.started_at DESC LIMIT $2`,
      [src, limit],
    );
    return { runs: r.rows };
  });

  // ---------- settings ----------
  app.get('/api/settings', async () => {
    const [retention, last, size, tables] = await Promise.all([
      getSetting<number | null>(db, 'retention_days', null),
      getSetting<unknown>(db, 'retention_last', null),
      db.query(`SELECT pg_database_size(current_database())::bigint AS bytes`),
      db.query(
        `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes, c.reltuples::bigint AS rows
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind='r' ORDER BY 2 DESC`,
      ),
    ]);
    let disk: { total: number; free: number } | null = null;
    try {
      const st = await statfs(process.env.PGDATA_PATH ?? '/');
      disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
    } catch {
      disk = null;
    }
    return { retention_days: retention, retention_last: last, db_bytes: size.rows[0].bytes, tables: tables.rows, disk, version };
  });

  app.put('/api/settings/retention', async (req, reply) => {
    const v = (req.body as { days?: unknown } | undefined)?.days;
    if (v !== null && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650)) return reply.code(400).send({ error: 'bad_retention' });
    await setSetting(db, 'retention_days', v);
    return { ok: true };
  });

  app.post('/api/settings/retention/run', async () => runRetention(db));
}
