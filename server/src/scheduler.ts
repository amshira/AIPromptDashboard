import { Cron } from 'croner';
import { Db, getSetting, pruneTexts, setSetting } from './db/index.js';
import { detectPanels, purgePanels } from './ingest/panels.js';
import { discoverAllRemotes, discoverSources, isRunning, syncSource } from './ingest/sync.js';

export const TZ = 'Asia/Tehran';

export interface Schedule {
  id: number;
  name: string;
  source_ids: number[];
  mode: 'interval' | 'cron';
  every_min: number | null;
  cron: string | null;
  days: number[] | null;
  from_hour: number | null;
  to_hour: number | null;
  enabled: boolean;
  last_run_at: Date | string | null;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Hour (0-23) and weekday (0=Sunday) of an instant on the Tehran wall clock. */
export function tehranParts(d: Date): { hour: number; day: number; ymd: string } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), day: WEEKDAY[p.weekday], ymd: `${p.year}-${p.month}-${p.day}` };
}

export function inWindow(s: Pick<Schedule, 'days' | 'from_hour' | 'to_hour'>, now: Date): boolean {
  const { hour, day } = tehranParts(now);
  if (s.days && s.days.length && !s.days.includes(day)) return false;
  const { from_hour: from, to_hour: to } = s;
  if (from == null || to == null || from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to; // wraps past midnight
}

/** Pure: should this schedule fire at `now`? */
export function isDue(s: Schedule, now: Date): boolean {
  if (!s.enabled || !inWindow(s, now)) return false;
  const last = s.last_run_at ? new Date(s.last_run_at).getTime() : null;
  if (s.mode === 'interval') {
    const every = Math.max(1, s.every_min ?? 5) * 60_000;
    return last == null || now.getTime() - last >= every - 1000;
  }
  if (!s.cron) return false;
  const prev = new Cron(s.cron, { timezone: TZ }).previousRuns(1, now)[0];
  if (!prev) return false;
  return last == null ? now.getTime() - prev.getTime() < 60_000 : prev.getTime() > last;
}

export function validateCron(expr: string): string | null {
  try {
    new Cron(expr, { timezone: TZ, paused: true });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Next fire times of a schedule, honouring its window — shown as a preview in the UI. */
export function nextRuns(s: Schedule, from: Date, count = 5): Date[] {
  const out: Date[] = [];
  if (s.mode === 'cron' && s.cron) {
    const c = new Cron(s.cron, { timezone: TZ, paused: true });
    let ref = from;
    for (let i = 0; i < 2000 && out.length < count; i++) {
      const n = c.nextRun(ref);
      if (!n) break;
      ref = n;
      if (inWindow(s, n)) out.push(n);
    }
    return out;
  }
  const step = Math.max(1, s.every_min ?? 5) * 60_000;
  let t = (s.last_run_at ? new Date(s.last_run_at).getTime() : from.getTime()) + step;
  if (t < from.getTime()) t = from.getTime();
  for (let i = 0; i < 20_000 && out.length < count; i++, t += step) {
    if (inWindow(s, new Date(t))) out.push(new Date(t));
  }
  return out;
}

export async function runSchedule(db: Db, sourcesDir: string, s: Schedule, trigger = 'schedule') {
  // picks up 9routers added on remote servers and keeps their "last seen" fresh
  await discoverAllRemotes(db);
  const ids = s.source_ids.length
    ? (await db.query('SELECT id FROM sources WHERE enabled AND missing_since IS NULL AND id = ANY($1)', [s.source_ids])).rows
    : (await db.query('SELECT id FROM sources WHERE enabled AND missing_since IS NULL')).rows;
  await db.query('UPDATE schedules SET last_run_at=now() WHERE id=$1', [s.id]);
  await Promise.all(ids.map((r) => syncSource(db, sourcesDir, r.id, trigger, s.id)));
}

export async function tick(db: Db, sourcesDir: string, now = new Date()): Promise<number> {
  const rows = (await db.query('SELECT * FROM schedules WHERE enabled')).rows as Schedule[];
  const due = rows.filter((s) => isDue(s, now));
  await Promise.all(due.map((s) => runSchedule(db, sourcesDir, s, 'schedule')));
  return due.length;
}

export async function ensureDefaultSchedule(db: Db): Promise<void> {
  const n = (await db.query('SELECT count(*)::int n FROM schedules')).rows[0].n;
  if (n === 0) await db.query(`INSERT INTO schedules(name, mode, every_min) VALUES ('همه منابع، هر ۵ دقیقه','interval',5)`);
}

// ---------- retention ----------

export interface RetentionResult {
  requests: number;
  sessions: number;
  runs: number;
  texts: number;
}

export async function runRetention(db: Db, now = new Date(), vacuum = true): Promise<RetentionResult> {
  const globalDays = await getSetting<number | null>(db, 'retention_days', null);
  const res: RetentionResult = { requests: 0, sessions: 0, runs: 0, texts: 0 };
  const sources = (await db.query('SELECT id, retention_days FROM sources')).rows as Array<{ id: number; retention_days: number | null }>;
  for (const s of sources) {
    const days = s.retention_days ?? globalDays;
    if (!days || days <= 0) continue;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    res.requests += (await db.query('DELETE FROM requests WHERE source_id=$1 AND ts < $2', [s.id, cutoff])).rowCount ?? 0;
    // a conversation is dropped as a whole once its last activity is older than the cutoff (messages cascade)
    res.sessions += (await db.query('DELETE FROM conversations WHERE source_id=$1 AND last_at < $2', [s.id, cutoff])).rowCount ?? 0;
    await db.query('DELETE FROM sessions WHERE source_id=$1 AND last_at < $2', [s.id, cutoff]);
  }
  await db.query(`DELETE FROM users u WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id=u.id) AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.user_id=u.id) AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.user_id=u.id) AND u.merged_into IS NULL AND u.display_name IS NULL AND NOT EXISTS (SELECT 1 FROM users m WHERE m.merged_into=u.id)`);
  res.runs = (await db.query(`DELETE FROM sync_runs WHERE started_at < $1`, [new Date(now.getTime() - 30 * 86_400_000)])).rowCount ?? 0;
  // texts of the removed messages, and of sources removed since the last run
  res.texts = await pruneTexts(db);
  await setSetting(db, 'retention_last', { at: now.toISOString(), ...res });
  if (vacuum && (res.requests || res.sessions || res.texts)) await db.query('VACUUM (ANALYZE)');
  return res;
}

/** Looks for 9routers added or removed under SOURCES_DIR, refreshes their panel cards and syncs the new ones right away. */
export async function rescanSources(db: Db, sourcesDir: string): Promise<number[]> {
  const fresh = await discoverSources(db, sourcesDir);
  await detectPanels(db, sourcesDir);
  await purgePanels(db);
  for (const id of fresh) void syncSource(db, sourcesDir, id, 'discover').catch(() => undefined);
  return fresh;
}

/** Starts the 20-second scheduler tick (with a 9router rescan every minute) and the nightly (03:00 Tehran) retention job. */
export function startScheduler(db: Db, sourcesDir: string, log: { error: (e: unknown, m: string) => void }) {
  let busy = false;
  let lastScan = 0;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const now = new Date();
      if (now.getTime() - lastScan >= 60_000) {
        lastScan = now.getTime();
        await rescanSources(db, sourcesDir);
      }
      await tick(db, sourcesDir, now);
      const { hour, ymd } = tehranParts(now);
      const last = await getSetting<{ ymd?: string }>(db, 'retention_ymd', {});
      if (hour === 3 && last.ymd !== ymd) {
        await setSetting(db, 'retention_ymd', { ymd });
        await runRetention(db, now);
      }
    } catch (e) {
      log.error(e, 'scheduler tick failed');
    } finally {
      busy = false;
    }
  }, 20_000);
  timer.unref();
  return () => clearInterval(timer);
}

export { isRunning };
