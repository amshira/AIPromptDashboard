import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { agentPost, AgentConn } from './reader.js';

const EXE = 'pd-agent.exe';
// the first agent build that applies a pushed update the Kaspersky-safe way (Scheduled-Task swap, no self-exec);
// older agents must be reinstalled once by hand before they can be updated from the server
export const MIN_SELF_UPDATE = '1.6.0';

export interface AgentExe {
  file: string;
  size: number;
  sha: string;
  /** read from the "PDAGENT_VERSION=x.y.z" marker the agent embeds, or null if not found */
  version: string | null;
}

// the exe rarely changes; re-read it only when its size or mtime does
let cache: { key: string; info: AgentExe } | null = null;

export function readAgentExe(dir: string): AgentExe | null {
  const file = join(dir, EXE);
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const key = `${st.size}:${st.mtimeMs}`;
  if (cache?.key !== key) {
    const buf = readFileSync(file);
    const sha = createHash('sha256').update(buf).digest('hex');
    const m = /PDAGENT_VERSION=(\d+\.\d+\.\d+)/.exec(buf.toString('latin1'));
    cache = { key, info: { file, size: st.size, sha, version: m?.[1] ?? null } };
  }
  return cache.info;
}

/** Compares dotted versions: positive when a is newer than b. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export interface UpdatableServer {
  id: number;
  url: string;
  token: string;
  cert: string | null;
}

/**
 * Pushes the server's agent exe to a paired Windows agent. The agent stores the file and a Windows Scheduled
 * Task copies it into place and restarts the service. Called from the PC card's update button. A 10-minute
 * cooldown applies only when force is false. Returns true when a push was sent.
 */
export async function maybeUpdateAgent(
  db: pg.Pool,
  server: UpdatableServer,
  dir: string,
  agentVersion: string | null | undefined,
  force = false,
): Promise<boolean> {
  if (!server.cert) return false; // only paired Windows agents can be pushed to
  const exe = readAgentExe(dir);
  if (!exe || !exe.version) return false;
  if (!force) {
    if (!agentVersion) return false; // version unknown: never guess
    if (cmpVersion(exe.version, agentVersion) <= 0) return false; // already current
    // agents older than the first self-update-capable build cannot be pushed to; they need a one-time reinstall
    if (cmpVersion(agentVersion, MIN_SELF_UPDATE) < 0) return false;
    const row = (await db.query('SELECT agent_update_at FROM servers WHERE id=$1', [server.id])).rows[0] as { agent_update_at: Date | null } | undefined;
    if (row?.agent_update_at && Date.now() - new Date(row.agent_update_at).getTime() < 10 * 60_000) return false;
  }
  await db.query('UPDATE servers SET agent_update_at=now() WHERE id=$1', [server.id]);
  const conn: AgentConn = { url: server.url, token: server.token, cert: server.cert };
  try {
    const buf = readFileSync(exe.file);
    await agentPost<{ ok: boolean; version?: string }>(conn, 'update', buf, { h: exe.sha });
    await db.query('UPDATE servers SET agent_update_error=NULL WHERE id=$1', [server.id]);
    return true;
  } catch (e) {
    await db.query('UPDATE servers SET agent_update_error=$2 WHERE id=$1', [server.id, (e as Error).message]);
    throw e;
  }
}
