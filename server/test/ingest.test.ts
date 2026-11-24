import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverSources, syncSource } from '../src/ingest/sync.js';
import { META, SYS, makeSourceDir, metaFor, req, startTestDb } from './helpers.js';

const u = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const a = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const T = (m: number) => new Date(Date.UTC(2026, 9, 26, 10, m)).toISOString();

let t: Awaited<ReturnType<typeof startTestDb>>;
const src = makeSourceDir();
let sourceId = 0;

beforeAll(async () => {
  t = await startTestDb(54329);
  const db = src.open('catalog');
  const h1 = [u('<system-reminder>mem</system-reminder>\nسلام، یه PR رو ریویو کن')];
  const h2 = [...h1, a('باشه، شروع می‌کنم'), u('ممنون')];
  src.insert(db, { id: 'r1', timestamp: T(0), data: req(h1, { prompt_tokens: 100, completion_tokens: 10 }) });
  src.insert(db, { id: 'r2', timestamp: T(1), data: req(h2, { prompt_tokens: 150, completion_tokens: 30 }) });
  // same history again (retry) -> must not duplicate messages
  src.insert(db, { id: 'r3', timestamp: T(2), data: req(h2, { prompt_tokens: 150, completion_tokens: 5 }) });
  // classifier request: tokens only
  src.insert(db, {
    id: 'c1',
    timestamp: T(3),
    data: {
      tokens: { prompt_tokens: 160, completion_tokens: 9 },
      request: { metadata: META, messages: [u('<transcript>x</transcript> Err on the side of blocking. <block>')] },
      response: { content: '<block>no' },
    },
  });
  // history rewritten after the first message (e.g. rewind) -> branch session
  src.insert(db, { id: 'r4', timestamp: T(4), data: req([h1[0], a('یه چیز دیگه'), u('بازم')]) });
  // truncated
  src.insert(db, { id: 't1', timestamp: T(5), data: { tokens: { prompt_tokens: 7, completion_tokens: 1 }, request: { _truncated: true, _originalSize: 5_000_000, _preview: 'abc' } } });
  db.close();
  await discoverSources(t.pool, src.root);
  sourceId = (await t.pool.query("SELECT id FROM sources WHERE name='catalog'")).rows[0].id;
});
afterAll(async () => {
  await t.stop();
});

describe('ingest', () => {
  it('syncs all rows and is idempotent', async () => {
    const r1 = await syncSource(t.pool, src.root, sourceId, 'manual');
    expect(r1.error).toBeUndefined();
    expect(r1.rowsNew).toBe(6);
    const r2 = await syncSource(t.pool, src.root, sourceId, 'manual');
    expect(r2.rowsNew).toBe(0);
    expect((await t.pool.query('SELECT count(*)::int n FROM requests')).rows[0].n).toBe(6);
  });

  it('stores each history message once per session', async () => {
    const s = await t.pool.query(`SELECT id, title FROM sessions WHERE thread_key NOT LIKE '%~%' AND thread_key NOT LIKE 'trunc:%' ORDER BY id`);
    expect(s.rowCount).toBe(1);
    const m = await t.pool.query('SELECT seq, kind, text FROM (SELECT m.*, x.body AS text FROM messages m JOIN texts x ON x.hash = m.content_hash) m WHERE session_id=$1 ORDER BY seq', [s.rows[0].id]);
    expect(m.rows.map((x) => x.kind)).toEqual(['system_reminder', 'human', 'assistant_text', 'human']);
    expect(s.rows[0].title).toBe('سلام، یه PR رو ریویو کن');
  });

  it('attributes new messages to the request that introduced them', async () => {
    const r = await t.pool.query(`SELECT id, msg_from_seq f, msg_to_seq t, human_count h FROM requests WHERE id IN ('r1','r2','r3') ORDER BY id`);
    expect(r.rows).toEqual([
      { id: 'r1', f: 0, t: 2, h: 1 },
      { id: 'r2', f: 2, t: 4, h: 1 },
      { id: 'r3', f: 4, t: 4, h: 0 },
    ]);
  });

  it('keeps classifier requests for tokens but out of sessions', async () => {
    const c = (await t.pool.query(`SELECT kind, session_id, input_tokens FROM requests WHERE id='c1'`)).rows[0];
    expect(c).toMatchObject({ kind: 'classifier', session_id: null, input_tokens: 160 });
  });

  it('branches a session when history diverges', async () => {
    const b = await t.pool.query(`SELECT id FROM sessions WHERE thread_key LIKE '%~%'`);
    expect(b.rowCount).toBe(1);
    const r = (await t.pool.query(`SELECT session_id FROM requests WHERE id='r4'`)).rows[0];
    expect(r.session_id).toBe(b.rows[0].id);
  });

  it('records truncated rows with their tokens', async () => {
    const r = (await t.pool.query(`SELECT truncated, original_size, input_tokens FROM requests WHERE id='t1'`)).rows[0];
    expect(r).toMatchObject({ truncated: true, original_size: 5_000_000, input_tokens: 7 });
  });

  it('never creates an "unknown" user: a source without keys has one source user', async () => {
    const u = await t.pool.query(`SELECT fingerprint FROM users`);
    expect(u.rows.map((x) => x.fingerprint)).toEqual(['source']);
    const c = await t.pool.query(`SELECT machine_user FROM conversations WHERE external_session_id IS NOT NULL`);
    expect(c.rows.every((x) => x.machine_user === 'P.Ng.CORP')).toBe(true);
  });

  it('picks up an updated row inside the overlap window', async () => {
    const db = src.open('catalog');
    src.insert(db, { id: 'r3', timestamp: T(2), data: req([u('x')], { prompt_tokens: 999, completion_tokens: 77 }) });
    db.close();
    await syncSource(t.pool, src.root, sourceId, 'manual');
    const r = (await t.pool.query(`SELECT input_tokens, output_tokens FROM requests WHERE id='r3'`)).rows[0];
    expect(r).toEqual({ input_tokens: 999, output_tokens: 77 });
  });

  it('flags a gap when the source rotated past our cursor', async () => {
    const db = src.open('catalog');
    db.exec('DELETE FROM requestDetails');
    src.insert(db, { id: 'late', timestamp: new Date(Date.UTC(2026, 9, 27)).toISOString(), data: req([u('later')]) });
    db.close();
    const r = await syncSource(t.pool, src.root, sourceId, 'manual');
    expect(r.gap).toBe(true);
    expect((await t.pool.query('SELECT gap_detected FROM sources WHERE id=$1', [sourceId])).rows[0].gap_detected).toBe(true);
  });
});

void SYS;

describe('people and conversations', () => {
  let t2: Awaited<ReturnType<typeof startTestDb>>;
  const s2 = makeSourceDir();
  let sid = 0;
  const at = (m: number, s = 0) => new Date(Date.UTC(2026, 9, 27, 9, m, s)).toISOString();
  const sync = () => syncSource(t2.pool, s2.root, sid, 'manual');

  beforeAll(async () => {
    t2 = await startTestDb(54335);
    const db = s2.open('team');
    s2.key(db, 'k-other', 'sk-secret-other-0001', 'ClaudeOther');
    s2.key(db, 'k-shop', 'sk-secret-shop-0002', 'ClaudeShop');
    const first = [u('<system-reminder>ctx</system-reminder>\nیک API بساز')];
    const turn2 = [...first, a('ساختم'), u('تست هم بنویس')];
    // two Claude Code processes on two machines, same key: one person
    s2.insert(db, { id: 'p1', timestamp: at(0), data: req(first, { prompt_tokens: 1, completion_tokens: 11, cache_read_input_tokens: 500 }, {}, { session: 's-1' }) });
    s2.usage(db, at(0), 'sk-secret-shop-0002', 11, 500);
    // a subagent of the same session (no Agent tool, its own first turn written by Claude)
    s2.insert(db, { id: 'sa1', timestamp: at(1), data: req([u('Find the handlers and report paths.')], { prompt_tokens: 1, completion_tokens: 12 }, {}, { session: 's-1', tools: ['Bash', 'Read'] }) });
    s2.usage(db, at(1), 'sk-secret-shop-0002', 12);
    s2.insert(db, { id: 'p2', timestamp: at(2), data: req(turn2, { prompt_tokens: 1, completion_tokens: 13, cache_read_input_tokens: 900 }, {}, { session: 's-1' }) });
    s2.usage(db, at(2), 'sk-secret-shop-0002', 13, 900);
    // the 9router dropped the body of a huge request: it follows the prompt cache to s-1
    s2.insert(db, { id: 'big', timestamp: at(3), data: { tokens: { prompt_tokens: 4, completion_tokens: 14, cache_read_input_tokens: 905 }, request: { _truncated: true, _originalSize: 2e6, _preview: '{"messages":[' } } });
    s2.usage(db, at(3), 'sk-secret-shop-0002', 14, 905);
    // another chat of the other key, at the same time
    s2.insert(db, { id: 'o1', timestamp: at(3, 30), data: req([u('سلام از امین')], { prompt_tokens: 1, completion_tokens: 15 }, {}, { session: 's-2' }) });
    s2.usage(db, at(3, 30), 'sk-secret-other-0001', 15);
    // auto-mode classifier of s-1: tokens go to the conversation, no messages
    s2.insert(db, { id: 'cl1', timestamp: at(4), data: { tokens: { prompt_tokens: 50, completion_tokens: 1 }, request: { max_tokens: 2112, metadata: metaFor('s-1'), messages: [u('<transcript>\n{"user":"x"}\n</transcript>')] } } });
    s2.usage(db, at(4), 'sk-secret-shop-0002', 1);
    db.close();
    await discoverSources(t2.pool, s2.root);
    sid = (await t2.pool.query("SELECT id FROM sources WHERE name='team'")).rows[0].id;
    const r = await sync();
    expect(r.error).toBeUndefined();
  });
  afterAll(async () => {
    await t2.stop();
  });

  const convOf = async (id: string) => (await t2.pool.query('SELECT conversation_id FROM requests WHERE id=$1', [id])).rows[0].conversation_id;

  it('identifies people by api key name, without storing the secret', async () => {
    const r = await t2.pool.query(`SELECT r.id, u.hint, r.api_key FROM requests r JOIN users u ON u.id=r.user_id ORDER BY r.id`);
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x.hint]));
    expect(by).toMatchObject({ p1: 'ClaudeShop', p2: 'ClaudeShop', sa1: 'ClaudeShop', big: 'ClaudeShop', o1: 'ClaudeOther', cl1: 'ClaudeShop' });
    expect((await t2.pool.query(`SELECT count(*)::int n FROM users`)).rows[0].n).toBe(2);
    const dump = JSON.stringify((await t2.pool.query('SELECT * FROM requests')).rows) + JSON.stringify((await t2.pool.query('SELECT * FROM users')).rows);
    expect(dump).not.toContain('sk-secret');
  });

  it('keeps one conversation per chat, with its subagent, helpers and truncated requests', async () => {
    const c1 = await convOf('p1');
    expect(await convOf('p2')).toBe(c1);
    expect(await convOf('sa1')).toBe(c1);
    expect(await convOf('big')).toBe(c1);
    expect(await convOf('cl1')).toBe(c1);
    expect(await convOf('o1')).not.toBe(c1);
    const threads = await t2.pool.query('SELECT thread_kind FROM sessions WHERE conversation_id=$1 ORDER BY first_at', [c1]);
    expect(threads.rows.map((x) => x.thread_kind)).toEqual(['main', 'subagent']);
    const sub = await t2.pool.query(`SELECT m.kind FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.thread_kind='subagent'`);
    expect(sub.rows.map((x) => x.kind)).toEqual(['agent_prompt']);
    expect((await t2.pool.query(`SELECT kind, human_count FROM requests WHERE id='sa1'`)).rows[0]).toEqual({ kind: 'subagent', human_count: 0 });
  });

  it('brings a chat back when the person returns to it, even under a new session id', async () => {
    const c1 = await convOf('p1');
    const db = s2.open('team');
    const turn3 = [u('<system-reminder>ctx</system-reminder>\nیک API بساز'), a('ساختم'), u('تست هم بنویس'), a('نوشتم'), u('دو روز بعد: حالا مستند کن')];
    s2.insert(db, { id: 'back', timestamp: new Date(Date.UTC(2026, 9, 29, 8, 0)).toISOString(), data: req(turn3, { prompt_tokens: 1, completion_tokens: 16 }, {}, { session: 's-1-resumed' }) });
    db.close();
    await sync();
    expect(await convOf('back')).toBe(c1);
    const human = await t2.pool.query(
      `SELECT m.text FROM (SELECT m.*, x.body AS text FROM messages m JOIN texts x ON x.hash = m.content_hash) m JOIN sessions s ON s.id=m.session_id WHERE s.conversation_id=$1 AND m.kind='human' ORDER BY m.created_at, m.seq`,
      [c1],
    );
    expect(human.rows.map((x) => x.text)).toEqual(['یک API بساز', 'تست هم بنویس', 'دو روز بعد: حالا مستند کن']);
  });

  it('keeps one thread when the client re-renders a reminder (e.g. the date changes)', async () => {
    const db = s2.open('team');
    const base = [u('<system-reminder>ctx</system-reminder>\nصبح بخیر'), u("Today's date is 2026-10-31.")];
    const h1 = [...base, a('سلام'), u('کار اول')];
    // next day the client drops the old date reminder and adds a new one at the end
    const h2 = [base[0], a('سلام'), u('کار اول'), a('انجام شد'), u("Today's date is 2026-11-01."), u('کار دوم')];
    s2.insert(db, { id: 'd1', timestamp: new Date(Date.UTC(2026, 9, 31, 20, 0)).toISOString(), data: req(h1, { completion_tokens: 21 }, {}, { session: 's-date' }) });
    s2.insert(db, { id: 'd2', timestamp: new Date(Date.UTC(2026, 10, 1, 6, 0)).toISOString(), data: req(h2, { completion_tokens: 22 }, {}, { session: 's-date' }) });
    db.close();
    await sync();
    const c = await convOf('d1');
    const threads = await t2.pool.query('SELECT id FROM sessions WHERE conversation_id=$1', [c]);
    expect(threads.rowCount).toBe(1);
    const human = await t2.pool.query(`SELECT m.text FROM (SELECT m.*, x.body AS text FROM messages m JOIN texts x ON x.hash = m.content_hash) m WHERE m.session_id=$1 AND m.kind='human' ORDER BY m.seq`, [threads.rows[0].id]);
    expect(human.rows.map((x) => x.text)).toEqual(['صبح بخیر', 'کار اول', 'کار دوم']);
    expect((await t2.pool.query(`SELECT human_count FROM requests WHERE id='d2'`)).rows[0].human_count).toBe(1);
  });

  it('keeps one thread when the client prunes old tool calls, and branches on a real edit', async () => {
    const db = s2.open('team');
    const tu = (id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } }] });
    const tr = (id: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `out ${id}` }, { type: 'text', text: '<total_tokens>9 tokens left</total_tokens>' }] });
    const head = [u('PRها را بررسی کن'), tu('t1'), tr('t1'), a('چیزی برای بررسی نیست'), u('دوباره نگاه کن')];
    s2.insert(db, { id: 'pr1', timestamp: new Date(Date.UTC(2026, 10, 1, 9, 0)).toISOString(), data: req(head, { completion_tokens: 31 }, {}, { session: 's-prune' }) });
    // the client dropped the old tool call and its result, then the chat went on
    const pruned = [u('PRها را بررسی کن'), a('چیزی برای بررسی نیست'), u('دوباره نگاه کن'), a('باشه'), u('حالا کامیت کن')];
    s2.insert(db, { id: 'pr2', timestamp: new Date(Date.UTC(2026, 10, 1, 9, 5)).toISOString(), data: req(pruned, { completion_tokens: 32 }, {}, { session: 's-prune' }) });
    // the person went back and changed their second message: that is a branch
    const edited = [u('PRها را بررسی کن'), a('چیزی برای بررسی نیست'), u('فقط PR شماره ۵ را ببین')];
    s2.insert(db, { id: 'pr3', timestamp: new Date(Date.UTC(2026, 10, 1, 9, 9)).toISOString(), data: req(edited, { completion_tokens: 33 }, {}, { session: 's-prune' }) });
    db.close();
    await sync();
    const c = await convOf('pr1');
    const threads = await t2.pool.query('SELECT id, thread_kind, skip_seq FROM sessions WHERE conversation_id=$1 ORDER BY first_at, id', [c]);
    expect(threads.rows.map((x) => x.thread_kind)).toEqual(['main', 'branch']);
    const main = await t2.pool.query(`SELECT text FROM (SELECT m.*, x.body AS text FROM messages m JOIN texts x ON x.hash = m.content_hash) m WHERE session_id=$1 AND kind='human' ORDER BY seq`, [threads.rows[0].id]);
    expect(main.rows.map((x) => x.text)).toEqual(['PRها را بررسی کن', 'دوباره نگاه کن', 'حالا کامیت کن']);
    const branchNew = await t2.pool.query(`SELECT text FROM (SELECT m.*, x.body AS text FROM messages m JOIN texts x ON x.hash = m.content_hash) m WHERE session_id=$1 AND kind='human' AND seq > $2 ORDER BY seq`, [threads.rows[1].id, threads.rows[1].skip_seq]);
    expect(branchNew.rows.map((x) => x.text)).toEqual(['فقط PR شماره ۵ را ببین']);
    const counts = await t2.pool.query(`SELECT id, human_count FROM requests WHERE id IN ('pr1','pr2','pr3') ORDER BY id`);
    expect(counts.rows.map((x) => x.human_count)).toEqual([2, 1, 1]);
  });

  it('does not count prompts that /loop fires by itself as typed by the person', async () => {
    const db = s2.open('team');
    const cmd = (name: string, args = '') => u(`<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>${args ? `\n<command-args>${args}</command-args>` : ''}`);
    const h = [cmd('/loop', '15min /watch-prs'), a('scheduled'), cmd('/watch-prs'), a('nothing'), cmd('/watch-prs'), a('nothing')];
    s2.insert(db, { id: 'l1', timestamp: new Date(Date.UTC(2026, 10, 1, 10, 0)).toISOString(), data: req(h, { completion_tokens: 23 }, {}, { session: 's-loop' }) });
    db.close();
    await sync();
    const r = (await t2.pool.query(`SELECT human_count FROM requests WHERE id='l1'`)).rows[0];
    expect(r.human_count).toBe(1);
    const tags = await t2.pool.query(`SELECT m.meta->>'tag' tag FROM messages m JOIN requests q ON q.session_id=m.session_id WHERE q.id='l1' AND m.kind='system_reminder'`);
    expect(tags.rows.map((x) => x.tag)).toEqual(['scheduled', 'scheduled']);
  });
});
