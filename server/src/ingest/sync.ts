import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { agentFetch, agentReader, RowReader, sqliteReader } from './reader.js';
import { IngestCtx, ingestRow } from './ingest.js';
import { KeyIndex } from './keys.js';

const OVERLAP_MS = 15 * 60 * 1000;
/** One source must not pin the scheduler: Cursor's sqlite (or a silent TLS socket) can sit without error. */
const SYNC_MS = 90_000;

export interface SyncOutcome {
  rowsRead: number;
  rowsNew: number;
  gap: boolean;
  error?: string;
}

/** data.sqlite of a local source; `path` is its folder under SOURCES_DIR (older rows have only the name). */
export const sourceFile = (dir: string, path: string) => join(dir, path, 'data.sqlite');

// folders a 9router keeps next to its database, and template/portal folders: never a source
const SKIP_DIR = /^(\.|_)|^(backups|logs|mitm|node_modules)$/;
const MAX_DEPTH = 5;

/** Every folder under `dir` (up to 5 levels) that holds a data.sqlite, as paths relative to `dir`. */
export function findDatabases(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    const abs = join(dir, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && entries.some((e) => e.name === 'data.sqlite' && !e.isDirectory())) {
      out.push(rel);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) if (e.isDirectory() && !SKIP_DIR.test(e.name)) walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
  };
  walk('', 0);
  return out.sort();
}

/**
 * Short name for a database folder: `example-team` for /sources/example-team, and `example-org/example-user` for
 * /sources/users/example-org/example-user/data/db (the per-user layout under SOURCES_USERS).
 */
export function sourceNameOf(rel: string): string {
  const segs = rel.split('/');
  if (segs.length > 2 && segs[segs.length - 1] === 'db' && segs[segs.length - 2] === 'data') segs.splice(-2);
  if (segs.length === 1) return segs[0];
  const [org, user] = segs.slice(-2);
  return `${org.replace(/(.)users$/, '$1')}/${user}`;
}

/**
 * Registers every 9router database found under SOURCES_DIR as a source, and marks local sources
 * whose folder is gone as missing (their data stays). Returns the ids of new or returned sources.
 */
export async function discoverSources(db: Pick<pg.Pool, 'query'>, dir: string): Promise<number[]> {
  const found = findDatabases(dir);
  const local = (await db.query('SELECT id, name, path, missing_since FROM sources WHERE server_id IS NULL')).rows as Array<{
    id: number;
    name: string;
    path: string | null;
    missing_since: string | null;
  }>;
  const byPath = new Map(local.map((s) => [s.path ?? s.name, s]));
  const names = new Set(local.map((s) => s.name));
  const fresh: number[] = [];
  for (const rel of found) {
    const known = byPath.get(rel);
    if (known) {
      if (known.missing_since) {
        await db.query('UPDATE sources SET missing_since=NULL, last_error=NULL WHERE id=$1', [known.id]);
        fresh.push(known.id);
      }
      continue;
    }
    let name = sourceNameOf(rel);
    // the same 9router mounted at another depth (e.g. its whole folder instead of data/db): move it, keep its data
    const moved = local.find((s) => s.name === name && !found.includes(s.path ?? s.name));
    if (moved) {
      await db.query('UPDATE sources SET path=$2, missing_since=NULL, last_error=NULL WHERE id=$1', [moved.id, rel]);
      moved.path = rel;
      if (moved.missing_since) fresh.push(moved.id);
      moved.missing_since = null;
      continue;
    }
    if (names.has(name)) name = rel;
    const r = await db.query(
      `INSERT INTO sources(name,label,path) VALUES($1,$1,$2) ON CONFLICT (name) DO UPDATE SET path=$2, missing_since=NULL RETURNING id`,
      [name, rel],
    );
    names.add(name);
    fresh.push(r.rows[0].id);
  }
  const present = new Set(found);
  const gone = local.filter((s) => !present.has(s.path ?? s.name) && !s.missing_since).map((s) => s.id);
  if (gone.length) await db.query('UPDATE sources SET missing_since=now() WHERE id = ANY($1)', [gone]);
  return fresh;
}

const running = new Set<number>();
export const isRunning = (sourceId: number) => running.has(sourceId);

/**
 * Ask a remote server's agent which 9routers it has and register each as a source "<server>/<name>". Returns the
 * count. Agent exe updates are not sent here; an admin pushes one from the PC card.
 */
export async function discoverRemote(db: pg.Pool, serverId: number): Promise<number> {
  const srv = (await db.query('SELECT id, name, label, url, token, cert_sha256 AS cert FROM servers WHERE id=$1', [serverId])).rows[0];
  if (!srv) throw new Error('unknown server');
  try {
    const res = await agentFetch<{ sources: Array<{ name: string }>; agent?: { version?: string } }>(srv, 'sources');
    const sources = res.sources;
    for (const s of sources)
      await db.query(
        `INSERT INTO sources(name,label,server_id,remote_name) VALUES($1,$2,$3,$4)
         ON CONFLICT (name) DO UPDATE SET server_id=$3, remote_name=$4`,
        [`${srv.name}/${s.name}`, `${srv.label} / ${s.name}`, srv.id, s.name],
      );
    // kept so the dashboard can say who is on a PC even while it is off
    const info = JSON.stringify({ agent: res.agent ?? null, sources: sources.slice(0, 200) });
    await db.query('UPDATE servers SET last_seen_at=now(), last_error=NULL, info=$2 WHERE id=$1', [serverId, info.length < 200_000 ? info : null]);
    return sources.length;
  } catch (e) {
    await db.query('UPDATE servers SET last_error=$2 WHERE id=$1', [serverId, (e as Error).message]);
    throw e;
  }
}

export async function discoverAllRemotes(db: pg.Pool): Promise<void> {
  const { rows } = await db.query('SELECT id FROM servers WHERE enabled');
  for (const r of rows) await discoverRemote(db, r.id).catch(() => undefined);
}

export async function syncSource(db: pg.Pool, dir: string, sourceId: number, trigger: string, scheduleId: number | null = null): Promise<SyncOutcome> {
  if (running.has(sourceId)) return { rowsRead: 0, rowsNew: 0, gap: false, error: 'sync already running' };
  running.add(sourceId);
  const out: SyncOutcome = { rowsRead: 0, rowsNew: 0, gap: false };
  const run = await db.query('INSERT INTO sync_runs(source_id, schedule_id, trigger) VALUES($1,$2,$3) RETURNING id', [sourceId, scheduleId, trigger]);
  const runId = run.rows[0].id as number;
  let reader: RowReader | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        reader?.close();
      } catch {
        /* the next tick must proceed even if this reader ignores close */
      }
      reject(new Error('sync timed out'));
    }, SYNC_MS);
  });
  try {
    await Promise.race([
      (async () => {
    const src = (
      await db.query(
        `SELECT s.name, s.path, s.last_cursor_ts, s.remote_name, v.url, v.token, v.cert_sha256 AS cert, v.enabled AS server_enabled
         FROM sources s LEFT JOIN servers v ON v.id = s.server_id WHERE s.id=$1`,
        [sourceId],
      )
    ).rows[0];
    if (!src) throw new Error('unknown source');
    if (src.url) {
      if (!src.server_enabled) throw new Error('server is disabled');
      reader = agentReader({ url: src.url, token: src.token, cert: src.cert }, src.remote_name);
    } else {
      const file = sourceFile(dir, src.path ?? src.name);
      if (!existsSync(file)) throw new Error(`database not found: ${file}`);
      reader = sqliteReader(file);
    }

    const cursor: Date | null = src.last_cursor_ts ? new Date(src.last_cursor_ts) : null;
    const from = cursor ? new Date(cursor.getTime() - OVERLAP_MS).toISOString() : '';

    // Records 9router already rotated out before we saw them => the data has a hole.
    if (cursor) {
      const oldest = await reader.oldest();
      if (oldest && new Date(oldest).getTime() > cursor.getTime()) out.gap = true;
    }

    // Which api key sent each request: 9router writes it to usageHistory, not to requestDetails.
    const keys = new KeyIndex();
    const keysFrom = from ? new Date(Date.parse(from) - 86_400_000).toISOString() : '';
    keys.add(await reader.keyInfo(keysFrom, '9999'));
    const ctx: IngestCtx = { db, sourceId, hashCache: new Map(), keys, userCache: new Map() };
    const size = reader.batchSize;
    let lastTs = from;
    let lastId = '';
    let maxTs = cursor ? cursor.toISOString() : '';
    for (;;) {
      const rows = await reader.batch(lastTs, lastId, size);
      if (!rows.length) break;
      for (const row of rows) {
        out.rowsRead++;
        try {
          const r = await ingestRow(ctx, row);
          if (r?.isNew) out.rowsNew++;
        } catch (e) {
          // one bad record must not block the whole source; remember the first error
          out.error ??= `${row.id}: ${(e as Error).message}`;
        }
        if (row.timestamp > maxTs) maxTs = row.timestamp;
      }
      const last = rows[rows.length - 1];
      lastTs = last.timestamp;
      lastId = last.id;
      // keep the cursor even if this run later times out, so an 8-day catch-up can finish across ticks
      if (maxTs) {
        await db.query('UPDATE sources SET last_cursor_ts=$2, last_sync_at=now() WHERE id=$1', [sourceId, maxTs]);
      }
      if (rows.length < size) break;
    }
    await db.query('UPDATE sources SET last_cursor_ts=$2, last_sync_at=now(), last_error=$3, gap_detected = gap_detected OR $4 WHERE id=$1', [
      sourceId,
      maxTs || null,
      out.error ?? null,
      out.gap,
    ]);
      })(),
      timedOut,
    ]);
  } catch (e) {
    out.error = (e as Error).message;
    await db.query('UPDATE sources SET last_error=$2, last_sync_at=now() WHERE id=$1', [sourceId, out.error]);
  } finally {
    if (timer) clearTimeout(timer);
    reader?.close();
    running.delete(sourceId);
    await db.query('UPDATE sync_runs SET finished_at=now(), rows_read=$2, rows_new=$3, gap=$4, error=$5 WHERE id=$1', [
      runId,
      out.rowsRead,
      out.rowsNew,
      out.gap,
      out.error ?? null,
    ]);
  }
  return out;
}
