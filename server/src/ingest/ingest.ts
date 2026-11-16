import { createHash } from 'node:crypto';
import pg from 'pg';
import { Q, lockTextsShared, storeTexts } from '../db/index.js';
import { Block, titleFromBlocks } from '../normalize/blocks.js';
import { ParsedRecord, blockHash, parseRow, RawRow } from '../normalize/record.js';
import { searchFold } from '../normalize/text.js';
import { firstPrompt, refineKinds, stable } from '../normalize/turns.js';
import { KeyIndex } from './keys.js';

export interface IngestCtx {
  db: pg.Pool;
  sourceId: number;
  /** session id -> stored content hashes by seq (index 0 = seq 1); filled lazily, per sync run */
  hashCache: Map<number, Stored[]>;
  /** api keys and usage of this source: tells which key (= which person) sent a request */
  keys: KeyIndex;
  /** fingerprint -> user id, per sync run */
  userCache?: Map<string, number>;
}

export interface IngestResult {
  isNew: boolean;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

/** A person is a 9router api key. A source without any key gets one "source" user, never an "unknown" one. */
export async function upsertUser(c: Q, sourceId: number, fingerprint: string, hint: string, cache?: Map<string, number>): Promise<number> {
  const hit = cache?.get(fingerprint);
  if (hit) return hit;
  const r = await c.query(
    `INSERT INTO users(source_id, fingerprint, hint) VALUES($1,$2,$3)
     ON CONFLICT (source_id, fingerprint) DO UPDATE SET hint = CASE WHEN EXCLUDED.hint <> '' THEN EXCLUDED.hint ELSE users.hint END
     RETURNING id, merged_into`,
    [sourceId, fingerprint, hint],
  );
  const id = (r.rows[0].merged_into ?? r.rows[0].id) as number;
  cache?.set(fingerprint, id);
  return id;
}

type KeyCtx = Pick<IngestCtx, 'sourceId' | 'keys' | 'userCache'>;

export const keyUser = (c: Q, ctx: KeyCtx, keyId: string) => upsertUser(c, ctx.sourceId, `key:${keyId}`, ctx.keys.keys.get(keyId)?.name ?? '', ctx.userCache);
export const sourceUser = (c: Q, ctx: KeyCtx) => upsertUser(c, ctx.sourceId, 'source', '', ctx.userCache);

/** When 9router logged no usage row for a request: the only key in use around then, else the source's main key. */
export async function fallbackUser(c: Q, ctx: KeyCtx, ts: string): Promise<number> {
  const k = ctx.keys.around(ts) ?? ctx.keys.fallback();
  return k ? keyUser(c, ctx, k) : sourceUser(c, ctx);
}

/** The only OS account that used this key in the last 30 minutes, else the only one it was ever used from. */
export async function soleClient(c: Q, userId: number, ts: string): Promise<string> {
  const near = await c.query(
    `SELECT client FROM requests WHERE user_id=$1 AND client <> '' AND ts BETWEEN $2::timestamptz - interval '30 minutes' AND $2::timestamptz GROUP BY client LIMIT 2`,
    [userId, ts],
  );
  if (near.rows.length === 1) return near.rows[0].client as string;
  if (near.rows.length > 1) return '';
  const r = await c.query(`SELECT client FROM requests WHERE user_id=$1 AND client <> '' GROUP BY client LIMIT 2`, [userId]);
  return r.rows.length === 1 ? (r.rows[0].client as string) : '';
}

interface Conv {
  id: number;
  user_id: number;
}

async function findConversation(c: Q, ctx: IngestCtx, rec: ParsedRecord): Promise<Conv | null> {
  if (rec.externalSessionId) {
    const r = await c.query(
      `(SELECT id, user_id FROM conversations WHERE source_id=$1 AND external_session_id=$2 LIMIT 1)
       UNION ALL
       (SELECT c.id, c.user_id FROM sessions s JOIN conversations c ON c.id=s.conversation_id WHERE s.source_id=$1 AND s.external_session_id=$2 LIMIT 1)
       LIMIT 1`,
      [ctx.sourceId, rec.externalSessionId],
    );
    if (r.rows[0]) return r.rows[0];
  }
  // A chat resumed under a new session id replays its old history: same first turn, same first answer.
  if (rec.rootHash && rec.kind === 'main') {
    const r = await c.query(
      `SELECT c.id, c.user_id FROM sessions s JOIN conversations c ON c.id=s.conversation_id
       WHERE s.source_id=$1 AND s.root_hash=$2 AND s.thread_kind <> 'subagent' ORDER BY s.last_at DESC LIMIT 1`,
      [ctx.sourceId, rec.rootHash],
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

/**
 * 9router keeps only a preview of very large requests. The prompt tells where they belong: a chat's next request
 * re-reads from cache what the previous one sent (cache_read ≈ previous prompt), and once the cache has expired
 * its prompt is the previous prompt plus what was added since.
 */
export async function chainConversation(
  c: Q,
  sourceId: number,
  ts: string,
  tok: { input: number; cacheRead: number; cacheWrite: number },
  userId: number | null = null,
): Promise<number | null> {
  const r = await c.query(
    `SELECT DISTINCT ON (conversation_id) conversation_id, (input_tokens + cache_read + cache_write) AS total, ts
     FROM requests WHERE source_id=$1 AND conversation_id IS NOT NULL AND kind IN ('main','compact')
       AND ts > $2::timestamptz - interval '24 hours' AND ts < $2::timestamptz AND ($3::int IS NULL OR user_id = $3)
     ORDER BY conversation_id, ts DESC`,
    [sourceId, ts, userId],
  );
  const rows = r.rows as Array<{ conversation_id: number; total: number; ts: Date }>;
  const prompt = tok.input + tok.cacheRead + tok.cacheWrite;
  let best: { id: number; d: number } | null = null;
  const take = (id: number, d: number) => {
    if (!best || d < best.d) best = { id, d };
  };
  if (tok.cacheRead > 0)
    for (const x of rows) {
      const d = Math.abs(x.total - tok.cacheRead);
      if (d <= Math.max(5_000, tok.cacheRead * 0.1)) take(x.conversation_id, d);
    }
  if (!best && prompt > 0)
    for (const x of rows) {
      const grow = prompt - x.total;
      if (grow >= -prompt * 0.02 && grow <= 80_000) take(x.conversation_id, Math.abs(grow));
    }
  return (best as { id: number } | null)?.id ?? null;
}

/** Title of a conversation known only from requests 9router could not keep. */
export const TRUNCATED_TITLE = '(گفتگوی بزرگ: متن پیام‌ها در 9router ذخیره نشده)';

const isMainThread = async (c: Q, sourceId: number, convId: number, firstTurnHash: string) =>
  ((await c.query(`SELECT 1 FROM sessions WHERE source_id=$1 AND thread_key=$2`, [sourceId, threadKey(convId, false, firstTurnHash)])).rowCount ?? 0) > 0;

export interface Stored {
  h: string;
  /** the client may drop or rewrite this block in later requests (old tool calls, thinking, its own reminders) */
  loose: boolean;
}

const LOOSE_KINDS = new Set(['tool_use', 'tool_result', 'thinking', 'image']);
export const isLoose = (b: Pick<Block, 'kind' | 'meta'>) => LOOSE_KINDS.has(b.kind) || !stable(b as Block);

async function loadHashes(c: pg.PoolClient, ctx: IngestCtx, sessionId: number): Promise<Stored[]> {
  const hit = ctx.hashCache.get(sessionId);
  if (hit) return hit;
  const r = await c.query(`SELECT content_hash, kind, meta->>'tag' AS tag FROM messages WHERE session_id=$1 ORDER BY seq`, [sessionId]);
  const arr = r.rows.map((x) => ({ h: x.content_hash as string, loose: isLoose({ kind: x.kind, meta: { tag: x.tag } }) }));
  ctx.hashCache.set(sessionId, arr);
  return arr;
}

export type Alignment =
  | { diverged: false; consumed: number; next: number; reach: number[] }
  | { diverged: true; at: number };

/**
 * Lines an incoming history up with what a thread already has. Between two requests of the same chat the client
 * may drop old tool calls and results, thinking and its own reminders, or rewrite them; what the person and
 * Claude said must still be there in order, otherwise it is a rewind / edit (diverged).
 * `consumed`: stored blocks covered; `next`: first incoming block that is new; `reach[j]`: stored blocks
 * covered by the first j incoming blocks.
 */
const AHEAD = 50;

export function align(stored: Stored[], incoming: Stored[]): Alignment {
  // fixedAfter[k]: is there a block at or after k that the client would not drop
  const fixedAfter: boolean[] = new Array(stored.length + 1).fill(false);
  for (let k = stored.length - 1; k >= 0; k--) fixedAfter[k] = fixedAfter[k + 1] || !stored[k].loose;
  const reach: number[] = [0];
  let i = 0;
  for (let j = 0; j < incoming.length; j++) {
    let k = i;
    while (k < stored.length && stored[k].h !== incoming[j].h && stored[k].loose) k++;
    if (!(k < stored.length && stored[k].h === incoming[j].h) && !incoming[j].loose) {
      // a block we took for a message may still be client text the client dropped since: look a little further
      const ahead = stored.slice(i, i + AHEAD).findIndex((x) => x.h === incoming[j].h);
      if (ahead >= 0) k = i + ahead;
    }
    if (k < stored.length && stored[k].h === incoming[j].h) {
      i = k + 1;
      reach.push(i);
      continue;
    }
    // incoming[j] is not in what we have: the new tail starts here, unless messages we have still follow
    if (!fixedAfter[i]) {
      for (let x = j; x < incoming.length; x++) reach.push(stored.length + (x - j) + 1);
      return { diverged: false, consumed: stored.length, next: j, reach };
    }
    if (incoming[j].loose) {
      reach.push(i); // a rewritten old tool result / reminder: keep ours
      continue;
    }
    return { diverged: true, at: j };
  }
  return { diverged: false, consumed: i, next: incoming.length, reach };
}

const COUNTED = new Set(['human', 'command']);
const SEARCHED = new Set(['human', 'assistant_text', 'command', 'agent_prompt']);

/** Insert only the blocks that the thread does not have yet; returns the (from, to] seq range added. */
async function storeHistory(
  c: pg.PoolClient,
  ctx: IngestCtx,
  sessionId: number,
  history: Block[],
  ts: string,
  /** a new branch repeats its parent up to here: those messages were counted already */
  countAfter = 0,
): Promise<{ from: number; to: number; end: number; humanAdded: number } | { divergedAt: string }> {
  const stored = await loadHashes(c, ctx, sessionId);
  const incoming = history.map((b) => ({ b, h: blockHash(b), loose: isLoose(b) }));

  const al = align(stored, incoming);
  // Divergence inside the stored range (rewind/edit/retry): keep what we have and let the
  // caller put this history in a branch thread instead of overwriting the original.
  if (al.diverged) return { divergedAt: `${al.at}:${incoming[al.at].h.slice(0, 8)}` };
  // Nothing past the stored range: an older/shorter request of the same thread.
  const add = al.consumed < stored.length ? [] : incoming.slice(al.next);
  let humanAdded = 0;
  if (add.length) {
    const cols: string[] = [];
    const vals: unknown[] = [];
    add.forEach((x, k) => {
      const o = k * 8;
      cols.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6}::jsonb,$${o + 7},$${o + 8})`);
      vals.push(
        sessionId,
        stored.length + k + 1,
        x.b.role,
        x.b.kind,
        x.h,
        x.b.meta ? JSON.stringify(x.b.meta) : null,
        ts,
        // folded text only for the kinds people actually look for
        SEARCHED.has(x.b.kind) ? searchFold(x.b.text).slice(0, 20_000) : '',
      );
      if (COUNTED.has(x.b.kind) && stored.length + k + 1 > countAfter) humanAdded++;
    });
    // the text goes in once, whole, whatever its size; a text another thread already has is not stored again
    await lockTextsShared(c);
    await storeTexts(c, add.map((x) => ({ h: x.h, text: x.b.text })));
    await c.query(
      `INSERT INTO messages(session_id, seq, role, kind, content_hash, meta, created_at, search) VALUES ${cols.join(',')} ON CONFLICT (session_id, seq) DO NOTHING`,
      vals,
    );
    for (const x of add) stored.push({ h: x.h, loose: x.loose });
  }
  const to = stored.length;
  return { from: to - add.length, to, end: add.length ? to : al.consumed, humanAdded };
}

export async function ingestRow(ctx: IngestCtx, row: RawRow): Promise<IngestResult | null> {
  const rec = parseRow(row);
  if (!rec) return null;
  const c = await ctx.db.connect();
  try {
    await c.query('BEGIN');
    const res = await ingestParsed(c, ctx, rec);
    await c.query('COMMIT');
    return res;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    // the caches may now disagree with the rolled back state
    ctx.hashCache.clear();
    ctx.userCache?.clear();
    throw e;
  } finally {
    c.release();
  }
}

export async function ingestParsed(c: pg.PoolClient, ctx: IngestCtx, rec: ParsedRecord): Promise<IngestResult> {
  const existing = await c.query('SELECT 1 FROM requests WHERE id=$1', [rec.id]);
  if (existing.rowCount) {
    // Re-read inside the overlap window: only the mutable columns change (tokens, status, response).
    await c.query(
      `UPDATE requests SET status=$2, model=$3, input_tokens=$4, output_tokens=$5, cache_read=$6, cache_write=$7,
         latency_ms=$8, ttft_ms=$9, response=$10::jsonb, truncated=$11, preview=$12 WHERE id=$1`,
      [
        rec.id,
        rec.status,
        rec.model,
        rec.tokens.input,
        rec.tokens.output,
        rec.tokens.cacheRead,
        rec.tokens.cacheWrite,
        rec.latencyMs,
        rec.ttftMs,
        rec.response.length ? JSON.stringify(rec.response) : null,
        rec.truncated,
        rec.preview ?? null,
      ],
    );
    return { isNew: false };
  }

  // Classifier, title and compaction helpers repeat a transcript in every call: their tokens count for the
  // conversation they serve, but they add no messages.
  const keepConversation = (rec.kind === 'main' || rec.kind === 'subagent') && !rec.truncated;

  let conv = await findConversation(c, ctx, rec);
  if (rec.kind === 'subagent' && (!conv || rec.continuation || (await isMainThread(c, ctx.sourceId, conv.id, rec.firstTurnHash)))) {
    // No Agent tool, yet this is the chat itself: it opens the conversation, continues it after compaction, or
    // extends a main thread we already have (a client whose main loop has no Agent tool).
    const history = refineKinds(rec.history, 'main');
    const first = firstPrompt(history);
    rec = { ...rec, kind: 'main', history, title: titleFromBlocks(first ? [first] : []) };
  }
  if (!conv && rec.truncated) {
    const k = ctx.keys.match(rec.ts, rec.tokens.output, rec.tokens.cacheRead);
    const id = await chainConversation(c, ctx.sourceId, rec.ts, rec.tokens, k ? await keyUser(c, ctx, k) : null);
    if (id) conv = (await c.query('SELECT id, user_id FROM conversations WHERE id=$1', [id])).rows[0] ?? null;
  }
  // A chat that was already too large when we first saw it: its requests still form one conversation.
  const startTruncated = !conv && rec.truncated && rec.tokens.cacheRead + rec.tokens.cacheWrite + rec.tokens.input > 0;

  const keyId = ctx.keys.match(rec.ts, rec.tokens.output, rec.tokens.cacheRead);
  let userId = keyId ? await keyUser(c, ctx, keyId) : conv ? conv.user_id : await fallbackUser(c, ctx, rec.ts);

  if (conv && keyId && conv.user_id !== userId) {
    // the owner was only guessed so far: the first exact key match decides whose conversation it is
    const known = await c.query('SELECT 1 FROM requests WHERE conversation_id=$1 AND api_key IS NOT NULL LIMIT 1', [conv.id]);
    if (known.rowCount) userId = conv.user_id;
    else {
      await c.query('UPDATE conversations SET user_id=$2 WHERE id=$1', [conv.id, userId]);
      await c.query('UPDATE sessions SET user_id=$2 WHERE conversation_id=$1', [conv.id, userId]);
      await c.query('UPDATE requests SET user_id=$2 WHERE conversation_id=$1', [conv.id, userId]);
      conv = { id: conv.id, user_id: userId };
    }
  }

  if (!conv && (keepConversation || startTruncated)) {
    const r = await c.query(
      `INSERT INTO conversations(source_id, user_id, external_session_id, title, machine_user, first_at, last_at)
       VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id, user_id`,
      [ctx.sourceId, userId, rec.externalSessionId, startTruncated ? TRUNCATED_TITLE : rec.kind === 'main' ? rec.title : '', rec.userHint, rec.ts],
    );
    conv = r.rows[0] as Conv;
  }
  // The person behind the key: the account of this chat, else the one seen in this request, else the only
  // account the key has been used from.
  let client = conv ? (((await c.query('SELECT machine_user FROM conversations WHERE id=$1', [conv.id])).rows[0]?.machine_user as string) ?? '') : '';
  client ||= rec.userHint || (await soleClient(c, userId, rec.ts));
  if (conv) {
    await c.query(
      `UPDATE conversations SET last_at = GREATEST(last_at, $2), first_at = LEAST(first_at, $2),
         title = CASE WHEN title = '' AND $3 THEN $4 ELSE title END,
         machine_user = CASE WHEN machine_user = '' THEN $5 ELSE machine_user END,
         external_session_id = COALESCE(external_session_id, $6)
       WHERE id=$1`,
      [conv.id, rec.ts, rec.kind === 'main' && !rec.truncated, rec.title, client, rec.externalSessionId],
    );
  }

  let sessionId: number | null = null;
  let range = { from: 0, to: 0, end: rec.history.length, humanAdded: 0 };

  if (keepConversation && conv) {
    const convId = conv.id;
    const upsertThread = async (threadKey: string, kind: string, skip: number) => {
      const s = await c.query(
        `INSERT INTO sessions(source_id, user_id, thread_key, external_session_id, title, first_at, last_at, conversation_id, thread_kind, skip_seq, root_hash)
         VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)
         ON CONFLICT (source_id, thread_key) DO UPDATE SET
           last_at = GREATEST(sessions.last_at, EXCLUDED.last_at),
           first_at = LEAST(sessions.first_at, EXCLUDED.first_at),
           external_session_id = COALESCE(sessions.external_session_id, EXCLUDED.external_session_id),
           title = CASE WHEN sessions.title = '' THEN EXCLUDED.title ELSE sessions.title END,
           root_hash = COALESCE(sessions.root_hash, EXCLUDED.root_hash)
         RETURNING id`,
        [ctx.sourceId, userId, threadKey, rec.externalSessionId, rec.title, rec.ts, convId, kind, skip, rec.rootHash],
      );
      return s.rows[0].id as number;
    };
    const key = threadKey(convId, rec.kind === 'subagent', rec.firstTurnHash);
    const kind = rec.kind === 'subagent' ? 'subagent' : rec.continuation ? 'continuation' : 'main';
    sessionId = await upsertThread(key, kind, 0);
    let r = await storeHistory(c, ctx, sessionId, rec.history, rec.ts);
    if ('divergedAt' in r) {
      // rewind / edit / retry: the new history gets its own thread, sharing the prefix with the original
      const at = Number(r.divergedAt.split(':')[0]) || 0;
      sessionId = await upsertThread(`${key}~${r.divergedAt}`, kind === 'subagent' ? 'subagent' : 'branch', at);
      r = await storeHistory(c, ctx, sessionId, rec.history, rec.ts, at);
    }
    if (!('divergedAt' in r)) range = r;
  }

  await c.query(
    `INSERT INTO requests(id, source_id, session_id, user_id, ts, model, provider, status, kind,
        input_tokens, output_tokens, cache_read, cache_write, latency_ms, ttft_ms,
        truncated, original_size, preview, msg_from_seq, msg_to_seq, history_len, response, human_count, conversation_id, api_key, client)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,$26)`,
    [
      rec.id,
      ctx.sourceId,
      sessionId,
      userId,
      rec.ts,
      rec.model,
      rec.provider,
      rec.status,
      rec.kind,
      rec.tokens.input,
      rec.tokens.output,
      rec.tokens.cacheRead,
      rec.tokens.cacheWrite,
      rec.latencyMs,
      rec.ttftMs,
      rec.truncated,
      rec.originalSize ?? null,
      rec.preview ?? null,
      sessionId ? range.from : null,
      sessionId ? range.to : null,
      // where this request's history ends in the thread: its answer is the next assistant message
      range.end,
      rec.response.length ? JSON.stringify(rec.response) : null,
      range.humanAdded,
      conv?.id ?? null,
      keyId,
      client,
    ],
  );
  return { isNew: true };
}

/** A thread is identified inside its conversation by its first user turn (and whether it is a subagent). */
export const threadKey = (convId: number, subagent: boolean, firstTurnHash: string) => sha(`${convId}|${subagent ? 'sa' : 'm'}|${firstTurnHash}`).slice(0, 24);
