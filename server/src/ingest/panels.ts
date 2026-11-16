import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { sourceNameOf } from './sync.js';

type Q = Pick<pg.Pool, 'query'>;

export interface ComposeInfo {
  container: string | null;
  panelPort: number | null;
  quotaPort: number | null;
}

/**
 * What a 9router's compose file says about how it is reached: the 9router container (not its "-quota"
 * sidecar), the host port mapped to 9router's 20128 and the one mapped to the quota portal's 8088.
 */
export function parseCompose(text: string): ComposeInfo {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, ''));
  const containers = lines.map((l) => /^\s*container_name:\s*["']?([^"'\s]+)/.exec(l)?.[1]).filter((c): c is string => !!c);
  const port = (inner: number) => {
    for (const l of lines) {
      const m = new RegExp(`^\\s*-\\s*["']?(?:[\\d.]+:)?(\\d+):${inner}(?:/tcp)?["']?\\s*$`).exec(l);
      if (m) return Number(m[1]);
    }
    return null;
  };
  return { container: containers.find((c) => !/-quota$/.test(c)) ?? containers[0] ?? null, panelPort: port(20128), quotaPort: port(8088) };
}

/** The folder holding the compose file of a source mounted at `path` (its data/db folder or the whole instance). */
export const instanceDir = (sourcesDir: string, path: string) => join(sourcesDir, path.replace(/(^|\/)data\/db$/, '') || '.');

function readCompose(dir: string): ComposeInfo | null {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    try {
      return parseCompose(readFileSync(join(dir, f), 'utf8'));
    } catch {
      /* next name */
    }
  }
  return null;
}

/**
 * Keeps one panel card per local 9router: container and ports are refreshed from its compose file,
 * everything typed by hand (domains, password, notes) is left alone.
 */
export async function detectPanels(db: Q, sourcesDir: string): Promise<void> {
  const sources = (await db.query(`SELECT id, name, path FROM sources WHERE server_id IS NULL AND missing_since IS NULL`)).rows as Array<{
    id: number;
    name: string;
    path: string | null;
  }>;
  for (const s of sources) {
    const path = s.path ?? s.name;
    const c = readCompose(instanceDir(sourcesDir, path));
    const short = sourceNameOf(path);
    const [org, name] = short.includes('/') ? short.split('/', 2) : ['', short];
    await db.query(
      `INSERT INTO panels(source_id, name, org, container, panel_port, quota_port) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (source_id) DO UPDATE SET
         container = COALESCE(EXCLUDED.container, panels.container),
         panel_port = COALESCE(EXCLUDED.panel_port, panels.panel_port),
         quota_port = COALESCE(EXCLUDED.quota_port, panels.quota_port)`,
      [s.id, name, org, c?.container ?? null, c?.panelPort ?? null, c?.quotaPort ?? null],
    );
  }
}

// ---------- passwords at rest ----------

const keyOf = (secret: string) => createHash('sha256').update(`panel-passwords:${secret}`).digest();

export function sealPassword(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

export function openPassword(secret: string, sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('unknown password format');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** Days a deleted panel stays on the page (and can be restored) before it is purged. */
export const PANEL_KEEP_DAYS = 5;

/** Purges deleted panels older than PANEL_KEEP_DAYS, or the given one right away. Returns how many were purged. */
export async function purgePanels(db: Q, onlyId?: number): Promise<number> {
  const due = onlyId ? 'id=$1 AND deleted_at IS NOT NULL' : `deleted_at < now() - interval '${PANEL_KEEP_DAYS} days'`;
  const args = onlyId ? [onlyId] : [];
  const gone = await db.query(`DELETE FROM panels WHERE source_id IS NULL AND ${due}`, args);
  const kept = await db.query(
    `UPDATE panels SET purged_at=now(), panel_domain=NULL, quota_domain=NULL, password_enc=NULL, password_from=NULL, password_at=NULL, notes=''
     WHERE source_id IS NOT NULL AND purged_at IS NULL AND ${due}`,
    args,
  );
  return (gone.rowCount ?? 0) + (kept.rowCount ?? 0);
}
