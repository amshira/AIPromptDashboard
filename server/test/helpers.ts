import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import Database from 'better-sqlite3';
import { createPool, migrate } from '../src/db/index.js';

/** In-process Postgres (pglite) exposed over a socket so the real `pg` pool code is exercised. */
export async function startTestDb(port: number) {
  const mem = await PGlite.create();
  const server = new PGLiteSocketServer({ db: mem, port, host: '127.0.0.1' });
  await server.start();
  const pool = createPool(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, 1);
  await migrate(pool);
  return {
    pool,
    async stop() {
      await pool.end().catch(() => undefined);
      await server.stop();
      await mem.close();
    },
  };
}

export interface FixtureRow {
  id: string;
  timestamp: string;
  provider?: string;
  model?: string;
  status?: string;
  data: object;
}

/** Creates `<root>/<name>/data.sqlite` with a 9router-shaped requestDetails table. */
export function makeSourceDir() {
  const root = mkdtempSync(join(tmpdir(), 'pd-src-'));
  const open = (name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    const db = new Database(join(root, name, 'data.sqlite'));
    db.exec(
      `CREATE TABLE IF NOT EXISTS requestDetails (id TEXT PRIMARY KEY, timestamp TEXT, provider TEXT, model TEXT, connectionId TEXT, status TEXT, data TEXT);
       CREATE TABLE IF NOT EXISTS apiKeys (id TEXT PRIMARY KEY, key TEXT, name TEXT, machineId TEXT, isActive INTEGER, createdAt TEXT);
       CREATE TABLE IF NOT EXISTS usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT,
         apiKey TEXT, endpoint TEXT, promptTokens INTEGER DEFAULT 0, completionTokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, status TEXT, tokens TEXT, meta TEXT);`,
    );
    return db;
  };
  const key = (db: Database.Database, id: string, secret: string, name: string, active = true) =>
    db.prepare('INSERT OR REPLACE INTO apiKeys VALUES (?,?,?,?,?,?)').run(id, secret, name, 'm', active ? 1 : 0, '2026-10-01');
  /** the row 9router writes next to each request: which key paid for it */
  const usage = (db: Database.Database, ts: string, secret: string, out: number, cached = 0) =>
    db
      .prepare('INSERT INTO usageHistory(timestamp, apiKey, promptTokens, completionTokens, tokens) VALUES (?,?,?,?,?)')
      .run(ts, secret, 0, out, JSON.stringify({ completion_tokens: out, cached_tokens: cached }));
  const insert = (db: Database.Database, r: FixtureRow) =>
    db
      .prepare('INSERT OR REPLACE INTO requestDetails VALUES (?,?,?,?,?,?,?)')
      .run(r.id, r.timestamp, r.provider ?? 'claude', r.model ?? 'claude-opus-5-5', null, r.status ?? 'success', JSON.stringify(r.data));
  return { root, open, insert, key, usage };
}

export const SYS = [{ type: 'text', text: 'You are Claude Code. cwd: C:\\Users\\P.Sahebi.ABNOOSGASHT\\repos\\HC' }];
export const META = { user_id: 'user_dead01_account_aaaa1111-0000-0000-0000-000000000000_session_bbbb2222-0000-0000-0000-000000000000' };
export const metaFor = (session: string) => ({ user_id: JSON.stringify({ device_id: 'dead01', account_uuid: '', session_id: session }) });

export const req = (
  messages: unknown[],
  tokens: Record<string, number> = { prompt_tokens: 10, completion_tokens: 20 },
  extra: object = {},
  opts: { session?: string; tools?: string[] } = {},
) => ({
  tokens,
  latency: { ttft: 100, total: 900 },
  request: { system: SYS, tools: (opts.tools ?? ['Bash', 'Agent']).map((name) => ({ name })), metadata: opts.session ? metaFor(opts.session) : META, messages },
  response: { content: '[Empty streaming response]' },
  ...extra,
});
