import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { compactStorage, migrate, pruneTexts } from '../src/db/index.js';
import { discoverSources, syncSource } from '../src/ingest/sync.js';
import { messageToBlocks } from '../src/normalize/blocks.js';
import { cleanText } from '../src/normalize/text.js';
import { makeSourceDir, req, startTestDb } from './helpers.js';

const u = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const T = (m: number) => new Date(Date.UTC(2026, 10, 7, 9, m)).toISOString();

// what Claude Code repeats in every chat: one copy must be enough
const REMINDER_BODY = 'CLAUDE.md: کد را تمیز نگه دار. '.repeat(1500);
const REMINDER = `<system-reminder>${REMINDER_BODY}</system-reminder>`;
// a prompt far larger than anything seen so far (~3 million characters), Persian and ASCII mixed
const HUGE = 'این یک متن خیلی بزرگ است / a very large prompt. '.repeat(64_000);
// what the ingest keeps: the same text, with Persian letters and spacing normalised
const HUGE_KEPT = cleanText(HUGE).trim();
const REMINDER_LEN = cleanText(REMINDER_BODY).trim().length;

let t: Awaited<ReturnType<typeof startTestDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;
const src = makeSourceDir();
let cookie = '';
const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: { cookie } })).json();

const convOf = async (session: string) =>
  (await t.pool.query('SELECT id FROM conversations WHERE external_session_id=$1', [session])).rows[0]?.id as number;
const messagesOf = async (session: string) => (await get(`/api/sessions/${await convOf(session)}`)).messages as Array<{ id: number; kind: string; len: number; text: string }>;

beforeAll(async () => {
  t = await startTestDb(54339);
  app = await buildApp(t.pool, { ...loadConfig({}), adminPassword: 'storage-test-pass', sessionSecret: 's'.repeat(40), sourcesDir: src.root, webDir: '/nonexistent' }, { logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'storage-test-pass' } });
  cookie = `pd_session=${login.cookies.find((c) => c.name === 'pd_session')!.value}`;

  const db = src.open('acme');
  // a one-letter prompt
  src.insert(db, { id: 'tiny', timestamp: T(0), data: req([u(`${REMINDER}\nk`)], { prompt_tokens: 3, completion_tokens: 1 }, {}, { session: 'tiny-chat' }) });
  // a huge prompt in another chat, with the same reminder
  src.insert(db, { id: 'huge', timestamp: T(1), data: req([u(`${REMINDER}\n${HUGE}`)], { prompt_tokens: 900_000, completion_tokens: 5 }, {}, { session: 'huge-chat' }) });
  // a bare API call: no system prompt, no tools, no session id
  src.insert(db, {
    id: 'bare',
    timestamp: T(2),
    data: { tokens: { prompt_tokens: 2, completion_tokens: 1 }, request: { max_tokens: 100, messages: [u('hi')] }, response: { content: 'hello' } },
  });
  db.close();
  await discoverSources(t.pool, src.root);
  const id = (await t.pool.query('SELECT id FROM sources')).rows[0].id;
  const r = await syncSource(t.pool, src.root, id, 'manual');
  expect(r.error).toBeUndefined();
});
afterAll(async () => {
  await app.close();
  await t.stop();
});

describe('message storage', () => {
  it('keeps a one-letter prompt', async () => {
    const m = await messagesOf('tiny-chat');
    expect(m.find((x) => x.kind === 'human')).toMatchObject({ text: 'k', len: 1 });
  });

  it('keeps a huge prompt whole, and the page gets a preview of it', async () => {
    const m = (await messagesOf('huge-chat')).find((x) => x.kind === 'human')!;
    expect(m.len).toBe(HUGE_KEPT.length);
    expect(m.text.length).toBe(12_000);
    const full = await get(`/api/messages/${m.id}`);
    expect(full.text).toBe(HUGE_KEPT);
  });

  it('keeps a bare API call with its prompt', async () => {
    const r = await t.pool.query(`SELECT r.conversation_id, x.body FROM requests r
      JOIN sessions s ON s.id = r.session_id JOIN messages m ON m.session_id = s.id JOIN texts x ON x.hash = m.content_hash WHERE r.id='bare'`);
    expect(r.rows.map((x) => x.body)).toContain('hi');
  });

  it('stores a text repeated in several chats once', async () => {
    const r = await t.pool.query(`SELECT count(*)::int AS msgs, count(DISTINCT m.content_hash)::int AS texts FROM messages m WHERE m.kind='system_reminder'`);
    expect(r.rows[0]).toEqual({ msgs: 2, texts: 1 });
    expect((await t.pool.query(`SELECT count(*)::int n FROM texts WHERE body LIKE 'CLAUDE.md%'`)).rows[0].n).toBe(1);
    for (const s of ['tiny-chat', 'huge-chat']) expect((await messagesOf(s)).find((x) => x.kind === 'system_reminder')?.len).toBe(REMINDER_LEN);
  });

  it('drops a text only when no chat uses it any more', async () => {
    await t.pool.query('DELETE FROM conversations WHERE id=$1', [await convOf('tiny-chat')]);
    expect(await pruneTexts(t.pool)).toBe(1); // the 'k'; the reminder is still used by the huge chat
    expect((await t.pool.query(`SELECT count(*)::int n FROM texts WHERE body='k'`)).rows[0].n).toBe(0);
    expect((await messagesOf('huge-chat')).find((x) => x.kind === 'system_reminder')?.len).toBe(REMINDER_LEN);
  });

  it('moves the text of an older database without losing any of it', async () => {
    // the layout before texts: the text inside each message row
    await t.pool.query('ALTER TABLE messages ADD COLUMN text TEXT');
    await t.pool.query('UPDATE messages m SET text = x.body FROM texts x WHERE x.hash = m.content_hash');
    await t.pool.query('DELETE FROM texts');
    await migrate(t.pool);
    const col = await t.pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='text'`);
    expect(col.rowCount).toBe(0);
    await compactStorage(t.pool);
    expect((await t.pool.query(`SELECT value FROM settings WHERE key='storage_version'`)).rows[0].value).toBe(2);
    const m = (await messagesOf('huge-chat')).find((x) => x.kind === 'human')!;
    expect((await get(`/api/messages/${m.id}`)).text).toBe(HUGE_KEPT);
  });
});

describe('normalised blocks', () => {
  it('cuts no tool output, tool call or answer, whatever its size', () => {
    const big = 'x'.repeat(250_000);
    const user = messageToBlocks('user', [{ type: 'tool_result', tool_use_id: 't1', content: big }]);
    expect(user[0].text.length).toBe(big.length);
    const asst = messageToBlocks('assistant', [
      { type: 'text', text: big },
      { type: 'thinking', thinking: big },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: big } },
      { type: 'tool_use', id: 't3', name: 'mcp__db__query', input: { sql: big } },
    ]);
    expect(asst.map((b) => b.text.length)).toEqual([big.length, big.length, big.length, JSON.stringify({ sql: big }).length]);
  });
});
