import { FastifyInstance } from 'fastify';
import { Db } from '../db/index.js';
import { isRunning, syncSource } from '../ingest/sync.js';
import { rescanSources } from '../scheduler.js';
import { AUX_KINDS, DAY_SQL, USER_NAME_SQL, Where, intOrNull, shamsi, todayTehran, ymdOr } from './util.js';

const SUM = `
  count(*) FILTER (WHERE r.kind <> ALL($AUX)) AS requests,
  count(*) FILTER (WHERE r.kind = ANY($AUX)) AS aux_requests,
  COALESCE(sum(r.human_count),0) AS human_messages,
  COALESCE(sum(r.input_tokens),0) AS input_tokens,
  COALESCE(sum(r.output_tokens),0) AS output_tokens,
  COALESCE(sum(r.cache_read),0) AS cache_read,
  COALESCE(sum(r.cache_write),0) AS cache_write,
  COALESCE(sum(r.input_tokens + r.output_tokens) FILTER (WHERE r.kind = ANY($AUX)),0) AS aux_tokens`;

/** Binds the classifier/title kinds as one extra trailing parameter, without mutating the caller's list. */
const withAux = (sql: string, params: unknown[]): [string, unknown[]] =>
  sql.includes('$AUX') ? [sql.replaceAll('$AUX', `$${params.length + 1}`), [...params, AUX_KINDS]] : [sql, params];
const qAux = (db: Db, sql: string, params: unknown[]) => db.query(...withAux(sql, params));

type Q = Record<string, string | undefined>;

/** Filters shared by overview / explorer / reports. */
function requestFilter(q: Q, defaultDays: number) {
  const to = ymdOr(q.to, todayTehran());
  const from = ymdOr(q.from, todayTehran(-(defaultDays - 1)));
  const w = new Where().range('r.ts', from, to);
  const source = intOrNull(q.source);
  const user = intOrNull(q.user);
  if (source) w.add('r.source_id = ?', source);
  if (user) w.add('r.user_id = ?', user);
  if (q.client) w.add('r.client = ?', q.client);
  if (q.model) w.add('r.model = ?', q.model);
  return { w, from, to };
}

export function registerDataApi(app: FastifyInstance, db: Db, sourcesDir: string) {
  app.get('/api/meta', async () => {
    const [sources, models, keys, clients] = await Promise.all([
      db.query(`SELECT id, name, label, enabled FROM sources ORDER BY id`),
      db.query(`SELECT model, count(*)::int n FROM requests GROUP BY model ORDER BY n DESC`),
      db.query(`SELECT u.id, u.source_id, ${USER_NAME_SQL('u')} AS name FROM users u WHERE u.merged_into IS NULL AND EXISTS (SELECT 1 FROM requests r WHERE r.user_id=u.id) ORDER BY 3`),
      db.query(`SELECT client AS name, array_agg(DISTINCT source_id) AS source_ids FROM requests WHERE client <> '' GROUP BY client ORDER BY client`),
    ]);
    return { sources: sources.rows, models: models.rows.map((m) => m.model).filter(Boolean), keys: keys.rows, clients: clients.rows, today: todayTehran() };
  });

  // ---------- overview ----------
  app.get('/api/overview', async (req) => {
    const q = req.query as Q;
    const { w, from, to } = requestFilter(q, 7);
    const dayCol = DAY_SQL('r.ts');
    const run = (sql: string) => qAux(db, sql, w.params);

    const [kpi, uniq, bySource, byModel, top, byDay] = await Promise.all([
      run(`SELECT ${SUM} FROM requests r ${w.sql}`),
      run(`SELECT count(DISTINCT NULLIF(r.client, ''))::int AS users, count(DISTINCT r.user_id)::int AS keys, count(DISTINCT r.conversation_id)::int AS sessions FROM requests r ${w.sql}`),
      run(`SELECT to_char(${dayCol},'YYYY-MM-DD') AS day, s.label AS key, ${SUM} FROM requests r JOIN sources s ON s.id=r.source_id ${w.sql} GROUP BY 1,2 ORDER BY 1`),
      run(`SELECT to_char(${dayCol},'YYYY-MM-DD') AS day, r.model AS key, ${SUM} FROM requests r ${w.sql} GROUP BY 1,2 ORDER BY 1`),
      run(
        `SELECT r.client AS name, s.label AS source, r.source_id, array_agg(DISTINCT ${USER_NAME_SQL('u')}) AS keys,
                ${SUM}, count(DISTINCT r.conversation_id)::int AS sessions
         FROM requests r JOIN users u ON u.id=r.user_id JOIN sources s ON s.id=r.source_id ${w.sql}
         GROUP BY r.client, s.label, r.source_id ORDER BY sum(r.input_tokens + r.output_tokens) DESC LIMIT 8`,
      ),
      run(`SELECT r.model, ${SUM} FROM requests r ${w.sql} GROUP BY r.model ORDER BY sum(r.input_tokens + r.output_tokens) DESC`),
    ]);
    const sources = await db.query(
      `SELECT id, name, label, enabled, last_sync_at, last_error, gap_detected, last_cursor_ts,
              (SELECT count(*)::int FROM requests WHERE source_id=sources.id) AS total_requests
       FROM sources ORDER BY id`,
    );
    return {
      from,
      to,
      kpi: { ...kpi.rows[0], ...uniq.rows[0] },
      daily_by_source: bySource.rows,
      daily_by_model: byModel.rows,
      top_users: top.rows,
      models: byDay.rows,
      sources: sources.rows.map((s) => ({ ...s, syncing: isRunning(s.id) })),
    };
  });

  // ---------- explorer ----------
  app.get('/api/users', async (req) => {
    const q = req.query as Q;
    const { w } = requestFilter({ ...q, user: undefined }, 30);
    w.raw('u.merged_into IS NULL');
    const r = await qAux(
      db,
      `SELECT u.id, u.source_id, ${USER_NAME_SQL('u')} AS name, u.display_name, u.hint, u.fingerprint, src.label AS source,
              ${SUM}, count(DISTINCT r.conversation_id)::int AS sessions, max(r.ts) AS last_at,
              array_agg(DISTINCT r.client) FILTER (WHERE r.client <> '') AS machines
       FROM requests r JOIN users u ON u.id=r.user_id JOIN sources src ON src.id=u.source_id ${w.sql}
       GROUP BY u.id, src.label ORDER BY max(r.ts) DESC`,
      w.params,
    );
    return { users: r.rows };
  });

  // People: the OS accounts behind the keys (one key may serve several people, one person may use several keys).
  app.get('/api/clients', async (req) => {
    const q = req.query as Q;
    const { w } = requestFilter({ ...q, client: undefined }, 30);
    const r = await qAux(
      db,
      `SELECT r.client AS name, r.source_id, src.label AS source,
              ${SUM}, count(DISTINCT r.conversation_id)::int AS sessions, max(r.ts) AS last_at,
              array_agg(DISTINCT ${USER_NAME_SQL('u')}) AS keys
       FROM requests r JOIN users u ON u.id=r.user_id JOIN sources src ON src.id=r.source_id ${w.sql}
       GROUP BY r.client, r.source_id, src.label ORDER BY (r.client = ''), max(r.ts) DESC`,
      w.params,
    );
    return { clients: r.rows };
  });

  // A "session" in the UI is a conversation: every thread of one chat (main, after compaction, rewinds, subagents).
  app.get('/api/sessions', async (req) => {
    const q = req.query as Q;
    const { w } = requestFilter({ ...q, user: undefined, client: undefined }, 30);
    const outer = new Where();
    const user = intOrNull(q.user);
    if (user) outer.add('c.user_id = ?', user);
    if (q.client) outer.add('c.machine_user = ?', q.client);
    const term = q.q?.trim();
    if (term) {
      const fold = term.toLowerCase().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0)).replace(/[‌‍]/g, '');
      const like = `%${fold.replace(/[%_\\]/g, '\\$&')}%`;
      outer.add(`(EXISTS (SELECT 1 FROM sessions t JOIN messages m ON m.session_id = t.id WHERE t.conversation_id = c.id AND m.search LIKE ?)`, like);
      outer.parts[outer.parts.length - 1] += ` OR lower(c.title) LIKE $${outer.params.push(like)})`;
    }
    const limit = Math.min(200, intOrNull(q.limit) ?? 50);
    const offset = Math.max(0, intOrNull(q.offset) ?? 0);
    // outer params continue after the request-filter params
    const base = w.params.length;
    const outerSql = outer.sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + base}`);
    const params = [...w.params, ...outer.params];
    const [sql, sqlParams] = withAux(
      `SELECT c.id, c.source_id, src.label AS source, c.user_id, ${USER_NAME_SQL('u')} AS user_name, c.title, c.first_at, c.last_at, c.machine_user,
              a.requests, a.aux_requests, a.human_messages, a.input_tokens, a.output_tokens, a.cache_read, a.cache_write, a.aux_tokens, a.models,
              count(*) OVER()::int AS total
       FROM conversations c
       JOIN sources src ON src.id = c.source_id
       JOIN users u ON u.id = c.user_id
       JOIN (SELECT r.conversation_id, ${SUM}, array_agg(DISTINCT r.model) FILTER (WHERE r.kind <> ALL($AUX) AND r.model <> '') AS models
             FROM requests r ${w.sql} GROUP BY r.conversation_id) a ON a.conversation_id = c.id
       ${outerSql}
       ORDER BY c.last_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const r = await db.query(sql, sqlParams);
    const ids = r.rows.map((x) => x.id as number);
    if (ids.length) {
      const [threads, visits, last] = await Promise.all([
        db.query(`SELECT conversation_id AS id, thread_kind AS k, count(*)::int AS n FROM sessions WHERE conversation_id = ANY($1) GROUP BY 1, 2`, [ids]),
        // visits: bursts of activity more than 30 minutes apart, i.e. how often the person came back to this chat
        db.query(
          `SELECT conversation_id AS id, (1 + count(*) FILTER (WHERE gap > interval '30 minutes'))::int AS visits
           FROM (SELECT conversation_id, ts - lag(ts) OVER (PARTITION BY conversation_id ORDER BY ts) AS gap
                 FROM requests WHERE conversation_id = ANY($1) AND kind IN ('main','subagent')) x GROUP BY 1`,
          [ids],
        ),
        db.query(
          `SELECT DISTINCT ON (t.conversation_id) t.conversation_id AS id, left(x.body, 220) AS text, m.created_at
           FROM messages m JOIN sessions t ON t.id = m.session_id JOIN texts x ON x.hash = m.content_hash
           WHERE t.conversation_id = ANY($1) AND m.kind = 'human' AND t.thread_kind <> 'subagent'
           ORDER BY t.conversation_id, m.created_at DESC, m.seq DESC`,
          [ids],
        ),
      ]);
      const v = new Map(visits.rows.map((x) => [x.id as number, x.visits as number]));
      const l = new Map(last.rows.map((x) => [x.id as number, x]));
      for (const row of r.rows) {
        const n = (k: string) => threads.rows.find((x) => x.id === row.id && x.k === k)?.n ?? 0;
        Object.assign(row, {
          subagents: n('subagent'),
          branches: n('branch'),
          compactions: n('continuation'),
          visits: v.get(row.id) ?? 1,
          last_human: l.get(row.id)?.text ?? null,
          last_human_at: l.get(row.id)?.created_at ?? null,
          models: row.models ?? [],
        });
      }
    }
    return { total: r.rows[0]?.total ?? 0, sessions: r.rows };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const s = await db.query(
      `SELECT c.id, c.source_id, src.label AS source, c.user_id, ${USER_NAME_SQL('u')} AS user_name, c.title, c.first_at, c.last_at,
              c.external_session_id, c.machine_user
       FROM conversations c JOIN sources src ON src.id=c.source_id JOIN users u ON u.id=c.user_id WHERE c.id=$1`,
      [id],
    );
    if (!s.rows[0]) return reply.code(404).send({ error: 'not_found' });
    const [threads, msgs, reqs, aux] = await Promise.all([
      db.query(`SELECT id, thread_kind AS kind, title, first_at, last_at, skip_seq FROM sessions WHERE conversation_id=$1 ORDER BY first_at, id`, [id]),
      // a branch repeats its parent up to skip_seq: only what is new in it is sent
      db.query(
        // tool output and client text are collapsed in the page: a preview is enough, the rest loads on demand
        `SELECT m.id, m.session_id, m.seq, m.role, m.kind, x.len, m.meta, m.created_at,
                left(x.body, CASE WHEN m.kind IN ('human','assistant_text','agent_prompt','command') THEN 12000 ELSE 600 END) AS text
         FROM messages m JOIN sessions t ON t.id = m.session_id JOIN texts x ON x.hash = m.content_hash
         WHERE t.conversation_id=$1 AND m.seq > t.skip_seq ORDER BY t.first_at, t.id, m.seq`,
        [id],
      ),
      db.query(
        `SELECT id, session_id, ts, model, provider, status, kind, input_tokens, output_tokens, cache_read, cache_write, latency_ms, ttft_ms,
                truncated, original_size, preview, msg_from_seq, msg_to_seq, history_len, human_count,
                -- the answer is already in a later history, except for the last request of a thread and body-less ones
                CASE WHEN truncated OR session_id IS NULL OR history_len >= COALESCE(
                  (SELECT max(m.seq) FROM messages m WHERE m.session_id = r.session_id AND m.role = 'assistant'), 0) THEN response END AS response
         FROM requests r WHERE conversation_id=$1 AND kind <> ALL($2) ORDER BY ts, id`,
        [id, AUX_KINDS],
      ),
      db.query(
        `SELECT id, ts, model, kind, input_tokens, output_tokens, cache_read, cache_write, latency_ms,
                jsonb_build_array(jsonb_build_object('kind', 'assistant_text', 'text', left(response->0->>'text', 300))) AS response
         FROM requests WHERE conversation_id=$1 AND kind = ANY($2) ORDER BY ts LIMIT 500`,
        [id, AUX_KINDS],
      ),
    ]);
    return { session: s.rows[0], threads: threads.rows, messages: msgs.rows, requests: reqs.rows, aux: aux.rows };
  });

  app.get('/api/messages/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    const r = id ? await db.query('SELECT m.id, x.body AS text FROM messages m JOIN texts x ON x.hash = m.content_hash WHERE m.id=$1', [id]) : { rows: [] };
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    return r.rows[0];
  });

  // ---------- reports ----------
  const DIMS = ['source', 'client', 'user', 'model'] as const;
  app.get('/api/reports/daily', async (req, reply) => {
    const q = req.query as Q;
    const { w, from, to } = requestFilter(q, 14);
    const by = (q.by ?? 'user').split(',').filter((x): x is (typeof DIMS)[number] => (DIMS as readonly string[]).includes(x));
    const cols: string[] = [`to_char(${DAY_SQL('r.ts')},'YYYY-MM-DD') AS day`];
    const group: string[] = ['1'];
    const joins: string[] = [];
    if (by.includes('source')) {
      joins.push('JOIN sources src ON src.id=r.source_id');
      cols.push('src.label AS source');
      group.push('src.label');
    }
    if (by.includes('client')) {
      cols.push('r.client AS client');
      group.push('r.client');
    }
    if (by.includes('user')) {
      joins.push('JOIN users u ON u.id=r.user_id');
      cols.push(`${USER_NAME_SQL('u')} AS user_name`, 'u.id AS user_id');
      group.push('u.id', 'u.display_name', 'u.hint', 'u.fingerprint');
    }
    if (by.includes('model')) {
      cols.push('r.model AS model');
      group.push('r.model');
    } else {
      cols.push(`array_agg(DISTINCT r.model) FILTER (WHERE r.model <> '' AND r.kind <> ALL($AUX)) AS models`);
    }
    const [sql, sqlParams] = withAux(
      `SELECT ${cols.join(', ')}, ${SUM}, count(DISTINCT r.conversation_id)::int AS sessions,
              COALESCE(round(avg(r.latency_ms) FILTER (WHERE r.kind <> ALL($AUX)))::int, 0) AS avg_latency_ms
       FROM requests r ${joins.join(' ')} ${w.sql} GROUP BY ${group.join(', ')} ORDER BY 1 DESC, sum(r.input_tokens + r.output_tokens) DESC`,
      w.params,
    );
    const rows = (await db.query(sql, sqlParams)).rows.map((r) => ({ ...r, day_shamsi: shamsi(r.day), models: r.models ?? (r.model ? [r.model] : []) }));

    if (q.format === 'csv') {
      const head = ['تاریخ شمسی', 'تاریخ میلادی', ...(by.includes('source') ? ['منبع'] : []), ...(by.includes('client') ? ['کاربر'] : []), ...(by.includes('user') ? ['کلید'] : []), 'مدل', 'پیام کاربر', 'درخواست', 'توکن ورودی', 'توکن خروجی', 'کش خوانده', 'کش نوشته', 'توکن کمکی', 'session'];
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = rows.map((r) =>
        [r.day_shamsi, r.day, ...(by.includes('source') ? [r.source] : []), ...(by.includes('client') ? [r.client || '—'] : []), ...(by.includes('user') ? [r.user_name] : []), r.models.join(' | '), r.human_messages, r.requests, r.input_tokens, r.output_tokens, r.cache_read, r.cache_write, r.aux_tokens, r.sessions].map(esc).join(','),
      );
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="usage-${from}_${to}.csv"`);
      return '﻿' + [head.map(esc).join(','), ...lines].join('\r\n');
    }
    return { from, to, by, rows };
  });

  // ---------- sources & users ----------
  app.get('/api/sources', async () => {
    const r = await db.query(
      `SELECT s.*, (SELECT count(*)::int FROM requests WHERE source_id=s.id) AS total_requests,
              (SELECT count(*)::int FROM conversations WHERE source_id=s.id) AS total_sessions
       FROM sources s ORDER BY id`,
    );
    return { sources: r.rows.map((s) => ({ ...s, syncing: isRunning(s.id) })) };
  });

  app.patch('/api/sources/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { label?: string; enabled?: boolean; retention_days?: number | null };
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    if (b.retention_days != null && !(Number.isInteger(b.retention_days) && b.retention_days >= 1 && b.retention_days <= 3650)) return reply.code(400).send({ error: 'bad_retention' });
    await db.query(
      `UPDATE sources SET label = COALESCE(NULLIF($2,''), label), enabled = COALESCE($3, enabled),
         retention_days = CASE WHEN $4::boolean THEN $5::int ELSE retention_days END WHERE id=$1`,
      [id, b.label?.trim().slice(0, 80) ?? null, b.enabled ?? null, 'retention_days' in b, b.retention_days ?? null],
    );
    return { ok: true };
  });

  // finds 9routers added or removed under SOURCES_DIR now, instead of within the next minute
  app.post('/api/sources/discover', async () => {
    const fresh = await rescanSources(db, sourcesDir);
    const all = (await db.query('SELECT count(*)::int AS n, count(missing_since)::int AS missing FROM sources WHERE server_id IS NULL')).rows[0];
    return { added: fresh.length, total: all.n, missing: all.missing };
  });

  // Only for a source whose folder is gone: removes it and everything ingested from it.
  app.delete('/api/sources/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    if (isRunning(id)) return reply.code(409).send({ error: 'already_running' });
    const r = await db.query('DELETE FROM sources WHERE id=$1 AND server_id IS NULL AND missing_since IS NOT NULL', [id]);
    if (!r.rowCount) return reply.code(409).send({ error: 'not_missing' });
    // its keys, conversations and requests go with it (ON DELETE CASCADE)
    return { ok: true };
  });

  app.post('/api/sources/:id/sync', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    if (isRunning(id)) return reply.code(409).send({ error: 'already_running' });
    void syncSource(db, sourcesDir, id, 'manual').catch((e) => req.log.error(e, 'manual sync failed'));
    return reply.code(202).send({ ok: true });
  });

  app.patch('/api/users/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { display_name?: string | null };
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [id, b.display_name?.trim().slice(0, 80) || null]);
    return { ok: true };
  });

  /** Merges user `id` into `into` (same source): history moves over and future records follow. */
  app.post('/api/users/:id/merge', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    const into = intOrNull((req.body as { into?: unknown } | undefined)?.into);
    if (!id || !into || id === into) return reply.code(400).send({ error: 'bad_ids' });
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const u = (await c.query('SELECT id, source_id FROM users WHERE id = ANY($1)', [[id, into]])).rows;
      if (u.length !== 2 || u[0].source_id !== u[1].source_id) {
        await c.query('ROLLBACK');
        return reply.code(400).send({ error: 'different_source' });
      }
      await c.query('UPDATE conversations SET user_id=$2 WHERE user_id=$1', [id, into]);
      await c.query('UPDATE sessions SET user_id=$2 WHERE user_id=$1', [id, into]);
      await c.query('UPDATE requests SET user_id=$2 WHERE user_id=$1', [id, into]);
      await c.query('UPDATE users SET merged_into=$2 WHERE merged_into=$1', [id, into]);
      await c.query('UPDATE users SET merged_into=$2 WHERE id=$1', [id, into]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    return { ok: true };
  });
}
