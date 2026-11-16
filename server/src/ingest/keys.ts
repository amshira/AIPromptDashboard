import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/** A 9router api key as the dashboard sees it: id and name, never the secret. */
export interface KeyRow {
  id: string;
  name: string;
  active: boolean;
  /** `sk-…1650`: enough to recognise the key */
  masked: string;
}

/** One `usageHistory` row of 9router: which key paid for a request, at what time, with which token counts. */
export interface UsageRow {
  ts: string;
  keyId: string;
  out: number;
  cached: number;
}

export interface KeyInfo {
  keys: KeyRow[];
  usage: UsageRow[];
}

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 3)}…${k.slice(-4)}` : '…');
const hashId = (k: string) => 'h' + createHash('sha1').update(k).digest('hex').slice(0, 12);

const hasTable = (db: Database.Database, name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);

/** Reads the api keys and the usage rows of [from, to] from a 9router sqlite file (opened read-only by the caller). */
export function readKeyInfo(db: Database.Database, from: string, to: string): KeyInfo {
  const keys: KeyRow[] = [];
  const bySecret = new Map<string, string>();
  if (hasTable(db, 'apiKeys')) {
    for (const r of db.prepare('SELECT id, key, name, isActive FROM apiKeys').all() as Array<{ id: string; key: string; name: string | null; isActive: number | null }>) {
      bySecret.set(r.key, String(r.id));
      keys.push({ id: String(r.id), name: r.name || mask(r.key), active: r.isActive !== 0, masked: mask(r.key) });
    }
  }
  const usage: UsageRow[] = [];
  if (hasTable(db, 'usageHistory')) {
    const rows = db
      .prepare('SELECT timestamp, apiKey, completionTokens, tokens FROM usageHistory WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp')
      .all(from, to) as Array<{ timestamp: string; apiKey: string | null; completionTokens: number | null; tokens: string | null }>;
    for (const r of rows) {
      if (!r.apiKey) continue;
      let keyId = bySecret.get(r.apiKey);
      if (!keyId) {
        // a key that was deleted from 9router since: still one person, just without a name
        keyId = hashId(r.apiKey);
        bySecret.set(r.apiKey, keyId);
        keys.push({ id: keyId, name: mask(r.apiKey), active: false, masked: mask(r.apiKey) });
      }
      let cached = 0;
      try {
        cached = Number(JSON.parse(r.tokens ?? '{}').cached_tokens ?? 0) || 0;
      } catch {
        /* keep 0 */
      }
      usage.push({ ts: r.timestamp, keyId, out: r.completionTokens ?? 0, cached });
    }
  }
  return { keys, usage };
}

const MATCH_MS = 5_000;

/** Finds keys for requests: exact usage match first, then what the source's usage around that time allows. */
export class KeyIndex {
  readonly keys = new Map<string, KeyRow>();
  private usage: Array<UsageRow & { t: number }> = [];

  add(info: KeyInfo) {
    for (const k of info.keys) this.keys.set(k.id, k);
    const seen = new Set(this.usage.map((u) => `${u.ts}|${u.keyId}|${u.out}`));
    for (const u of info.usage) if (!seen.has(`${u.ts}|${u.keyId}|${u.out}`)) this.usage.push({ ...u, t: Date.parse(u.ts) });
    this.usage.sort((a, b) => a.t - b.t);
  }

  get size() {
    return this.usage.length;
  }

  private range(t: number, ms: number) {
    let lo = 0;
    let hi = this.usage.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.usage[mid].t < t - ms) lo = mid + 1;
      else hi = mid;
    }
    const out: Array<UsageRow & { t: number }> = [];
    for (let i = lo; i < this.usage.length && this.usage[i].t <= t + ms; i++) out.push(this.usage[i]);
    return out;
  }

  /** The key of the usage row 9router wrote for this very request (same time, same output and cache counts). */
  match(ts: string, out: number, cacheRead: number): string | null {
    const t = Date.parse(ts);
    const c = this.range(t, MATCH_MS).filter((u) => u.out === out);
    if (!c.length) return null;
    const exact = c.filter((u) => u.cached === cacheRead);
    const pool = exact.length ? exact : c;
    if (new Set(pool.map((u) => u.keyId)).size === 1) return pool[0].keyId;
    pool.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));
    return pool[0].keyId;
  }

  /** The only key in use around `ts`, if there is exactly one. */
  around(ts: string, ms = 30 * 60_000): string | null {
    const ids = new Set(this.range(Date.parse(ts), ms).map((u) => u.keyId));
    return ids.size === 1 ? [...ids][0] : null;
  }

  /** Last resort for a source: its only active key, else its most used key. */
  fallback(): string | null {
    const active = [...this.keys.values()].filter((k) => k.active);
    if (active.length === 1) return active[0].id;
    const count = new Map<string, number>();
    for (const u of this.usage) count.set(u.keyId, (count.get(u.keyId) ?? 0) + 1);
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) return top[0];
    return this.keys.size === 1 ? [...this.keys.keys()][0] : null;
  }
}
