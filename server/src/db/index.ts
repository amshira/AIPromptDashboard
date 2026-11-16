import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = pg.Pool;
export type Q = Pick<pg.Pool, 'query'>;

// BIGINT / COUNT come back as strings by default; token sums fit safely in a double.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export function createPool(url: string, max = 8): Db {
  const pool = new pg.Pool({ connectionString: url, max });
  // an idle connection dropped by a Postgres restart must not crash the app; the pool reconnects on the next query
  pool.on('error', (e) => console.warn('postgres connection lost:', e.message));
  return pool;
}

export async function migrate(db: Db): Promise<void> {
  const candidates = [join(here, 'schema.sql'), join(here, '../../src/db/schema.sql')];
  let sql = '';
  for (const p of candidates) {
    try {
      sql = readFileSync(p, 'utf8');
      break;
    } catch {
      /* try next */
    }
  }
  if (!sql) throw new Error('schema.sql not found');
  await db.query(sql);
}

/**
 * Message texts are shared between threads, so a text may only be removed while nobody is adding a message that
 * points at it: writers hold this lock shared for their transaction, pruneTexts holds it exclusively.
 */
const TEXTS_LOCK = 7_301_001;
export const lockTextsShared = (c: Q) => c.query('SELECT pg_advisory_xact_lock_shared($1)', [TEXTS_LOCK]);

/** Adds the texts that are not stored yet (call inside a transaction holding lockTextsShared). */
export async function storeTexts(c: Q, items: Array<{ h: string; text: string }>): Promise<void> {
  const seen = new Map<string, string>();
  for (const x of items) seen.set(x.h, x.text);
  if (!seen.size) return;
  await c.query(
    `INSERT INTO texts(hash, len, body) SELECT h, length(b), b FROM unnest($1::text[], $2::text[]) AS v(h, b) ON CONFLICT (hash) DO NOTHING`,
    [[...seen.keys()], [...seen.values()]],
  );
}

/** Removes texts no message points at any more (after retention or a removed source). */
export async function pruneTexts(db: Db): Promise<number> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [TEXTS_LOCK]);
    const r = await c.query('DELETE FROM texts t WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.content_hash = t.hash)');
    await c.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Once after the move of message text into `texts`: rewrite the tables so the disk space of the dropped column is
 * given back (a dropped column keeps its bytes until the rows are rewritten).
 */
const STORAGE_VERSION = 2;
export async function compactStorage(db: Db, log: (m: string) => void = () => undefined): Promise<void> {
  if ((await getSetting<number>(db, 'storage_version', 1)) >= STORAGE_VERSION) return;
  const size = async () => Number((await db.query('SELECT pg_database_size(current_database()) AS n')).rows[0].n);
  const before = await size();
  await db.query('VACUUM FULL messages');
  await db.query('VACUUM (ANALYZE) texts');
  await setSetting(db, 'storage_version', STORAGE_VERSION);
  log(`storage compacted: ${(before / 1048576).toFixed(1)} MB -> ${((await size()) / 1048576).toFixed(1)} MB`);
}

export async function getSetting<T>(db: Q, key: string, fallback: T): Promise<T> {
  const r = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0] ? (r.rows[0].value as T) : fallback;
}

export async function setSetting(db: Q, key: string, value: unknown): Promise<void> {
  await db.query(
    'INSERT INTO settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
    [key, JSON.stringify(value)],
  );
}
