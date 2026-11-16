import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { Db, getSetting, setSetting, storeTexts } from '../db/index.js';
import { Block } from '../normalize/blocks.js';
import { blockHash, turnHash } from '../normalize/record.js';
import { searchFold } from '../normalize/text.js';
import { firstPrompt, firstTurn, identityOf, injectedTag, refineKinds, stable } from '../normalize/turns.js';
import { Stored, TRUNCATED_TITLE, align, chainConversation, fallbackUser, isLoose, keyUser, sourceUser, threadKey } from './ingest.js';
import { KeyIndex } from './keys.js';
import { agentReader, sqliteReader } from './reader.js';
import { sourceFile } from './sync.js';

/**
 * Data version 2: people are api keys, conversations group their threads, and message roles are decided per turn.
 * 9router keeps only its latest requests, so stored data is upgraded in place instead of being read again.
 */
export const DATA_VERSION = 4;

interface Log {
  info: (m: string) => void;
  error: (e: unknown, m: string) => void;
}

export async function upgradeData(db: Db, sourcesDir: string, log: Log): Promise<void> {
  const version = await getSetting<number>(db, 'data_version', 1);
  if (version >= DATA_VERSION) return;
  if (version < 2) await upgradeV2(db, sourcesDir, log);
  await fillClients(db);
  await setSetting(db, 'data_version', DATA_VERSION);
}

/** Versions 3-4: the person (OS account) of each request, separate from its key. */
export async function fillClients(db: Pick<Db, 'query'>): Promise<void> {
  const fromConversations = `UPDATE requests r SET client = c.machine_user FROM conversations c WHERE c.id = r.conversation_id AND r.client = '' AND c.machine_user <> ''`;
  await db.query(fromConversations);
  // a conversation with no visible account (it was too large from the start): the only account that used the
  // same key around that time
  await db.query(
    `UPDATE conversations c SET machine_user = x.client FROM (
       SELECT c2.id, min(r.client) AS client FROM conversations c2
       JOIN requests r ON r.user_id = c2.user_id AND r.client <> '' AND r.ts BETWEEN c2.first_at - interval '30 minutes' AND c2.last_at + interval '30 minutes'
       WHERE c2.machine_user = '' GROUP BY c2.id HAVING count(DISTINCT r.client) = 1) x
     WHERE x.id = c.id`,
  );
  await db.query(fromConversations);
  await db.query(
    `UPDATE requests r SET client = x.client FROM (
       SELECT r2.id, min(o.client) AS client FROM requests r2
       JOIN requests o ON o.user_id = r2.user_id AND o.client <> '' AND o.ts BETWEEN r2.ts - interval '30 minutes' AND r2.ts + interval '30 minutes'
       WHERE r2.client = '' GROUP BY r2.id HAVING count(DISTINCT o.client) = 1) x
     WHERE x.id = r.id`,
  );
  // a key used from a single account: its requests without a visible account are that account's
  await db.query(
    `WITH one AS (SELECT user_id, min(client) AS client FROM requests WHERE client <> '' GROUP BY user_id HAVING count(DISTINCT client) = 1)
     UPDATE requests r SET client = one.client FROM one WHERE r.user_id = one.user_id AND r.client = ''`,
  );
  await db.query(
    `WITH one AS (SELECT user_id, min(client) AS client FROM requests WHERE client <> '' GROUP BY user_id HAVING count(DISTINCT client) = 1)
     UPDATE conversations c SET machine_user = one.client FROM one WHERE c.user_id = one.user_id AND c.machine_user = ''`,
  );
}

async function upgradeV2(db: Db, sourcesDir: string, log: Log): Promise<void> {
  const sources = (await db.query('SELECT s.id, s.name, s.path, s.remote_name, v.url, v.token FROM sources s LEFT JOIN servers v ON v.id=s.server_id ORDER BY s.id')).rows;
  for (const s of sources) {
    const keys = new KeyIndex();
    try {
      if (s.url) {
        const r = agentReader({ url: s.url, token: s.token }, s.remote_name);
        keys.add(await r.keyInfo('', '9999'));
      } else if (existsSync(sourceFile(sourcesDir, s.path ?? s.name))) {
        const r = sqliteReader(sourceFile(sourcesDir, s.path ?? s.name));
        try {
          keys.add(await r.keyInfo('', '9999'));
        } finally {
          r.close();
        }
      }
    } catch (e) {
      log.error(e, `upgrade: api keys of ${s.name} not readable, using fallbacks`);
    }
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const n = await upgradeSource(c, s.id, keys);
      await c.query('COMMIT');
      log.info(`upgrade: ${s.name}: ${n.conversations} conversations, ${n.threads} threads (+${n.merged} re-rendered copies merged), ${n.helpers} helper threads removed, ${n.matched}/${n.requests} requests matched to a key`);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  await db.query(
    `DELETE FROM users u WHERE u.fingerprint NOT LIKE 'key:%' AND u.fingerprint <> 'source'
       AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.user_id=u.id) AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id=u.id)
       AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.user_id=u.id) AND NOT EXISTS (SELECT 1 FROM users m WHERE m.merged_into=u.id)`,
  );
  await setSetting(db, 'data_version', 2);
}

interface Thread {
  id: number;
  key: string;
  ext: string | null;
  firstAt: number;
  lastAt: string;
  hint: string;
  blocks: Array<Block & { id: number; seq: number; at: number }>;
  /** when the Agent calls of this thread were running: [start, end] ms */
  agents: Array<[number, number]>;
  turnHash: string;
  root: string | null;
  helper: string | null;
  continuation: boolean;
  subagent: boolean;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

export async function upgradeSource(c: pg.PoolClient, sourceId: number, keys: KeyIndex) {
  const ctx = { sourceId, keys, userCache: new Map<string, number>() };
  const rows = (
    await c.query(
      `SELECT s.id, s.thread_key, s.external_session_id, s.first_at, s.last_at, u.hint
       FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.source_id=$1 ORDER BY s.first_at, s.id`,
      [sourceId],
    )
  ).rows;

  const threads: Thread[] = [];
  const truncated: number[] = [];
  for (const r of rows) {
    if (String(r.thread_key).startsWith('trunc:')) {
      truncated.push(r.id);
      continue;
    }
    const msgs = (await c.query('SELECT m.id, m.seq, m.role, m.kind, x.body AS text, m.meta, m.created_at FROM messages m JOIN texts x ON x.hash = m.content_hash WHERE m.session_id=$1 ORDER BY m.seq', [r.id])).rows;
    const blocks = msgs.map((m) => ({ id: Number(m.id), seq: m.seq, role: m.role, kind: m.kind, text: m.text, meta: m.meta ?? undefined, at: new Date(m.created_at).getTime() }));
    const turn = firstTurn(blocks);
    const answer = blocks[turn.length];
    // identity as the ingest computes it: on refined kinds, without the client's volatile reminders
    const id = identityOf(firstTurn(refineKinds(blocks, 'main')));
    const th = turnHash(id.length ? id : [{ role: 'user', text: `thread:${r.id}` }]);
    // An Agent call reaches the history only with the request that carries its result, so the subagent ran
    // between the previous request of this thread and that one.
    const agents: Array<[number, number]> = [];
    blocks.forEach((b, i) => {
      if (b.kind !== 'tool_use' || (b.meta?.name !== 'Agent' && b.meta?.name !== 'Task')) return;
      let k = i - 1;
      while (k >= 0 && blocks[k].at >= b.at) k--;
      agents.push([k >= 0 ? blocks[k].at : b.at - 3600_000, b.at]);
    });
    const helperTag = turn.map((b) => (b.role === 'user' ? injectedTag(b.text) : null)).find((t) => t === 'helper');
    const helperText = helperTag ? turn.map((b) => b.text).join('\n') : '';
    threads.push({
      id: r.id,
      key: r.thread_key,
      ext: r.external_session_id,
      firstAt: new Date(r.first_at).getTime(),
      lastAt: r.last_at,
      hint: r.hint ?? '',
      blocks,
      agents,
      turnHash: th,
      root: id.length && answer ? sha1(th + '|' + blockHash(answer)).slice(0, 24) : null,
      helper: helperTag ? (/You are coming up with a succinct title/.test(helperText) ? 'title' : 'classifier') : null,
      continuation: turn.some((b) => b.meta?.tag === 'continuation-summary'),
      subagent: false,
    });
  }

  // ---- group threads into conversations
  const groups = new Map<string, Thread[]>();
  for (const t of threads) {
    const g = t.ext ? `ext:${t.ext}` : t.root ? `root:${t.root}` : `thread:${t.id}`;
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }

  let nConv = 0;
  let nThreads = 0;
  let nHelpers = 0;
  let nMerged = 0;
  for (const [, list] of groups) {
    const real = list.filter((t) => !t.helper);
    const helpers = list.filter((t) => t.helper);
    const main = real[0];
    let convId: number | null = null;
    if (main) {
      // a thread that starts while another thread waits for an Agent call is that call's subagent
      const intervals = real.flatMap((t) => t.agents.map(([a, b]) => ({ t, a, b })));
      for (const t of real.slice(1)) {
        if (t.continuation || t.turnHash === main.turnHash) continue;
        t.subagent = intervals.some((x) => x.t !== t && t.firstAt >= x.a - 2000 && t.firstAt <= x.b + 2000);
      }
      for (const t of real) {
        const refined = refineKinds(t.blocks, t.subagent ? 'subagent' : 'main');
        t.blocks = t.blocks.map((b, i) => ({ ...b, kind: refined[i].kind, meta: refined[i].meta }));
      }
      const head = real.find((t) => !t.subagent) ?? main;
      const title = firstPrompt(head.blocks)?.text.split('\n').find((l) => l.trim()) ?? '';
      const r = await c.query(
        `INSERT INTO conversations(source_id, user_id, external_session_id, title, machine_user, first_at, last_at)
         VALUES($1,(SELECT user_id FROM sessions WHERE id=$2),$3,$4,$5,
                (SELECT min(first_at) FROM sessions WHERE id = ANY($6)),(SELECT max(last_at) FROM sessions WHERE id = ANY($6))) RETURNING id`,
        [sourceId, main.id, main.ext, title.length > 60 ? title.slice(0, 60) + '…' : title, real.find((t) => t.hint)?.hint ?? '', real.map((t) => t.id)],
      );
      convId = r.rows[0].id as number;
      nConv++;

      // Threads with the same identity are one thread the client re-rendered (a reminder came or went) or a
      // rewind. The one holding most of the chat keeps the key, so the next request continues it.
      const st = (x: Thread): Stored[] => x.blocks.map((b) => ({ h: blockHash(b), loose: isLoose(b) }));
      const plan = new Map<Thread, { key: string; kind: string; skip: number; into?: Thread }>();
      const byKey = new Map<string, Thread[]>();
      for (const t of real) {
        const branchOf = t.key.includes('~') ? t.key.slice(t.key.indexOf('~')) : '';
        const key = threadKey(convId, t.subagent, t.turnHash) + branchOf;
        plan.set(t, {
          key,
          kind: t.subagent ? 'subagent' : branchOf ? 'branch' : t.continuation ? 'continuation' : 'main',
          skip: branchOf ? Number(branchOf.slice(1).split(':')[0]) || 0 : 0,
        });
        byKey.set(key, [...(byKey.get(key) ?? []), t]);
      }
      for (const [key, members] of byKey) {
        if (members.length < 2) continue;
        const size = (x: Thread) => x.blocks.filter(stable).length;
        const owner = members.slice().sort((x, y) => size(y) - size(x) || Date.parse(y.lastAt) - Date.parse(x.lastAt))[0];
        for (const m of members) {
          if (m === owner) continue;
          const al = align(st(owner), st(m));
          const p = plan.get(m)!;
          if (!al.diverged) p.into = owner;
          else Object.assign(p, { key: `${key}~m${m.id}`, kind: m.subagent ? 'subagent' : 'branch', skip: al.at });
        }
      }

      for (const t of real) {
        const p = plan.get(t)!;
        if (p.into) {
          // everything of t is already in the owner: its requests move over (their messages were counted there)
          const at = positionMap(st(p.into), st(t));
          const reqs = (await c.query('SELECT id, history_len FROM requests WHERE session_id=$1', [t.id])).rows;
          for (const r of reqs) {
            const end = at(Number(r.history_len));
            await c.query(
              `UPDATE requests SET session_id=$2, conversation_id=$3, history_len=$4, msg_from_seq=$4, msg_to_seq=$4, human_count=0,
                 kind = CASE WHEN $5 THEN 'subagent' WHEN kind='subagent' THEN 'main' ELSE kind END WHERE id=$1`,
              [r.id, p.into.id, convId, end, t.subagent],
            );
          }
          await c.query(
            `UPDATE sessions o SET first_at = LEAST(o.first_at, t.first_at), last_at = GREATEST(o.last_at, t.last_at) FROM sessions t WHERE o.id=$1 AND t.id=$2`,
            [p.into.id, t.id],
          );
          await c.query('DELETE FROM sessions WHERE id=$1', [t.id]);
          nMerged++;
          continue;
        }
        await c.query(`UPDATE sessions SET thread_key=$2, conversation_id=$3, thread_kind=$4, skip_seq=$5, root_hash=$6, title=$7 WHERE id=$1`, [
          t.id,
          p.key,
          convId,
          p.kind,
          p.skip,
          t.root,
          firstPrompt(t.blocks)?.text.split('\n').find((l) => l.trim())?.slice(0, 60) ?? '',
        ]);
        // a hash computed differently than before needs its text under the new hash
        if (t.blocks.length) await storeTexts(c, t.blocks.map((b) => ({ h: blockHash(b), text: b.text })));
        if (t.blocks.length)
          await c.query(
            `UPDATE messages m SET kind=v.kind, meta=v.meta::jsonb, content_hash=v.h, search=v.search
             FROM (SELECT unnest($1::bigint[]) id, unnest($2::text[]) kind, unnest($3::text[]) meta, unnest($4::text[]) h, unnest($5::text[]) search) v
             WHERE m.id=v.id`,
            [
              t.blocks.map((b) => b.id),
              t.blocks.map((b) => b.kind),
              t.blocks.map((b) => (b.meta ? JSON.stringify(b.meta) : null)),
              t.blocks.map((b) => blockHash(b)),
              t.blocks.map((b) => (['human', 'assistant_text', 'command', 'agent_prompt'].includes(b.kind) ? searchFold(b.text).slice(0, 20_000) : '')),
            ],
          );
        await c.query(`UPDATE requests SET conversation_id=$2, kind = CASE WHEN $3 THEN 'subagent' WHEN kind='subagent' THEN 'main' ELSE kind END WHERE session_id=$1`, [t.id, convId, t.subagent]);
        nThreads++;
      }
    } else if (helpers[0]?.ext) {
      convId = (await c.query('SELECT id FROM conversations WHERE source_id=$1 AND external_session_id=$2 LIMIT 1', [sourceId, helpers[0].ext])).rows[0]?.id ?? null;
    }
    for (const h of helpers) {
      await c.query(`UPDATE requests SET kind=$2, session_id=NULL, conversation_id=$3, msg_from_seq=NULL, msg_to_seq=NULL, human_count=0 WHERE session_id=$1`, [h.id, h.helper, convId]);
      await c.query('DELETE FROM sessions WHERE id=$1', [h.id]);
      nHelpers++;
    }
  }

  // ---- per-request facts that depend on the refined message kinds
  await c.query(
    `UPDATE requests r SET human_count = CASE WHEN r.kind = 'subagent' THEN 0 ELSE
        (SELECT count(*) FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.session_id=r.session_id
           AND m.seq > GREATEST(r.msg_from_seq, s.skip_seq) AND m.seq <= r.msg_to_seq AND m.kind IN ('human','command')) END
     WHERE r.source_id=$1 AND r.session_id IS NOT NULL`,
    [sourceId],
  );
  await c.query(
    `UPDATE requests r SET kind='compact' WHERE r.source_id=$1 AND r.session_id IS NOT NULL AND EXISTS
       (SELECT 1 FROM messages m WHERE m.session_id=r.session_id AND m.seq > r.msg_from_seq AND m.seq <= r.msg_to_seq AND m.meta->>'tag'='compact-request')`,
    [sourceId],
  );

  // ---- truncated requests follow the prompt cache to their conversation
  if (truncated.length) {
    await c.query('UPDATE requests SET session_id=NULL, kind=$2 WHERE session_id = ANY($1)', [truncated, 'main']);
    await c.query('DELETE FROM sessions WHERE id = ANY($1)', [truncated]);
  }
  const trunc = (
    await c.query(`SELECT id, ts, input_tokens, cache_read, cache_write, user_id FROM requests WHERE source_id=$1 AND truncated AND conversation_id IS NULL ORDER BY ts`, [sourceId])
  ).rows;
  for (const r of trunc) {
    const tok = { input: Number(r.input_tokens), cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write) };
    let conv = await chainConversation(c, sourceId, new Date(r.ts).toISOString(), tok);
    if (!conv && tok.input + tok.cacheRead + tok.cacheWrite > 0) {
      // already too large when first seen: the chain becomes a conversation of its own
      conv = (
        await c.query(`INSERT INTO conversations(source_id, user_id, title, first_at, last_at) VALUES($1,$2,$3,$4,$4) RETURNING id`, [sourceId, r.user_id, TRUNCATED_TITLE, r.ts])
      ).rows[0].id as number;
      nConv++;
    }
    if (conv) await c.query('UPDATE requests SET conversation_id=$2 WHERE id=$1', [r.id, conv]);
  }
  await c.query(
    `UPDATE conversations c SET first_at = LEAST(c.first_at, x.a), last_at = GREATEST(c.last_at, x.b)
     FROM (SELECT conversation_id, min(ts) a, max(ts) b FROM requests WHERE source_id=$1 AND conversation_id IS NOT NULL GROUP BY 1) x WHERE x.conversation_id=c.id`,
    [sourceId],
  );
  // ---- helper calls without a session id: the conversation running at that moment
  await c.query(
    `UPDATE requests r SET conversation_id = (
       SELECT q.conversation_id FROM requests q WHERE q.source_id=r.source_id AND q.conversation_id IS NOT NULL AND q.kind IN ('main','subagent')
         AND q.ts BETWEEN r.ts - interval '3 minutes' AND r.ts + interval '1 minute'
       ORDER BY abs(extract(epoch FROM q.ts - r.ts)) LIMIT 1)
     WHERE r.source_id=$1 AND r.conversation_id IS NULL AND r.kind IN ('classifier','title','compact')`,
    [sourceId],
  );

  // ---- people: the api key of every request, the main key of every conversation
  const reqs = (await c.query('SELECT id, ts, output_tokens, cache_read, conversation_id FROM requests WHERE source_id=$1', [sourceId])).rows;
  const keyOf = new Map<string, string | null>();
  const votes = new Map<number, Map<string, number>>();
  let matched = 0;
  for (const r of reqs) {
    const k = keys.match(new Date(r.ts).toISOString(), Number(r.output_tokens), Number(r.cache_read));
    keyOf.set(r.id, k);
    if (!k) continue;
    matched++;
    if (r.conversation_id) {
      const v = votes.get(r.conversation_id) ?? new Map<string, number>();
      v.set(k, (v.get(k) ?? 0) + 1);
      votes.set(r.conversation_id, v);
    }
  }
  const convs = (await c.query('SELECT id, first_at FROM conversations WHERE source_id=$1', [sourceId])).rows;
  const owner = new Map<number, number>();
  for (const cv of convs) {
    const v = votes.get(cv.id);
    const top = v ? [...v.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
    owner.set(cv.id, top ? await keyUser(c, ctx, top) : await fallbackUser(c, ctx, new Date(cv.first_at).toISOString()));
  }
  const ids: string[] = [];
  const users: number[] = [];
  const apiKeys: Array<string | null> = [];
  for (const r of reqs) {
    const k = keyOf.get(r.id) ?? null;
    ids.push(r.id);
    apiKeys.push(k);
    users.push(k ? await keyUser(c, ctx, k) : r.conversation_id ? owner.get(r.conversation_id)! : await fallbackUser(c, ctx, new Date(r.ts).toISOString()));
  }
  if (ids.length)
    await c.query(
      `UPDATE requests r SET user_id=v.u, api_key=v.k FROM (SELECT unnest($1::text[]) id, unnest($2::int[]) u, unnest($3::text[]) k) v WHERE r.id=v.id`,
      [ids, users, apiKeys],
    );
  if (convs.length) {
    await c.query(`UPDATE conversations c SET user_id=v.u FROM (SELECT unnest($1::int[]) id, unnest($2::int[]) u) v WHERE c.id=v.id`, [[...owner.keys()], [...owner.values()]]);
    await c.query(`UPDATE sessions s SET user_id=c.user_id FROM conversations c WHERE c.id=s.conversation_id AND s.source_id=$1`, [sourceId]);
  }
  // any thread left outside a conversation (should not happen) still must not point at a removed user
  const loose = await c.query('SELECT 1 FROM sessions WHERE source_id=$1 AND conversation_id IS NULL LIMIT 1', [sourceId]);
  if (loose.rowCount) await c.query('UPDATE sessions SET user_id=$2 WHERE source_id=$1 AND conversation_id IS NULL', [sourceId, await sourceUser(c, ctx)]);

  return { conversations: nConv, threads: nThreads, merged: nMerged, helpers: nHelpers, matched, requests: reqs.length };
}

/** For a history of the first `len` blocks of `b`, how far it reaches in `a` (`b` is covered by `a`). */
function positionMap(a: Stored[], b: Stored[]) {
  const al = align(a, b);
  const reach = al.diverged ? [0] : al.reach;
  return (len: number) => Math.min(a.length, reach[Math.max(0, Math.min(len, reach.length - 1))]);
}
