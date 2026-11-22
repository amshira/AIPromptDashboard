import Database from 'better-sqlite3';
import { createHmac, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { connect, TLSSocket } from 'node:tls';
import { RawRow } from '../normalize/record.js';
import { KeyInfo, readKeyInfo } from './keys.js';

/** Where requestDetails rows come from: a local sqlite file, or an agent running next to a remote 9router. */
export interface RowReader {
  batchSize: number;
  oldest(): Promise<string | null>;
  /** Rows strictly after (ts, id) in (timestamp, id) order. */
  batch(ts: string, id: string, limit: number): Promise<RawRow[]>;
  /** api keys and the usage rows of [from, to], used to tell which key sent each request */
  keyInfo(from: string, to: string): Promise<KeyInfo>;
  close(): void;
}

const COLS = 'id, timestamp, provider, model, connectionId, status, data';

export function sqliteReader(file: string): RowReader {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const oldest = db.prepare('SELECT MIN(timestamp) AS t FROM requestDetails');
  const batch = db.prepare(`SELECT ${COLS} FROM requestDetails WHERE (timestamp > @ts) OR (timestamp = @ts AND id > @id) ORDER BY timestamp ASC, id ASC LIMIT @limit`);
  return {
    batchSize: 40,
    async oldest() {
      return (oldest.get() as { t: string | null }).t;
    },
    async batch(ts, id, limit) {
      return batch.all({ ts, id, limit }) as RawRow[];
    },
    async keyInfo(from, to) {
      return readKeyInfo(db, from, to);
    },
    close: () => db.close(),
  };
}

export class AgentError extends Error {}

/**
 * How to reach an agent. A 9router server agent (agent.ts) takes a bearer token over http(s). A Windows agent
 * (agent-windows/) is paired: `cert` is the SHA-256 of its self-signed certificate, `token` the hex HMAC key,
 * and the url path is its secret prefix.
 */
export interface AgentConn {
  url: string;
  token: string;
  cert?: string | null;
}

export const normCert = (s: string) => s.replace(/[^0-9a-f]/gi, '').toLowerCase();

// rows carry whole chats: generous, but bounded so a broken agent cannot exhaust the dashboard
const MAX_BODY = 256 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export async function agentFetch<T>(conn: AgentConn, path: string, params: Record<string, string | number> = {}): Promise<T> {
  if (conn.cert) return pinnedFetch<T>(conn, path, params);
  const baseUrl = conn.url;
  const u = new URL(`/agent/v1/${path}`, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(u, { headers: { authorization: `Bearer ${conn.token}` }, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new AgentError(`cannot reach ${u.origin}: ${(e as Error).message}`);
  }
  if (res.status === 401) throw new AgentError('agent rejected the token');
  if (!res.ok) throw new AgentError(`agent answered ${res.status}`);
  return (await res.json()) as T;
}

/** A push to a paired Windows agent: the body is authenticated by the SHA-256 the signed query names. */
export async function agentPost<T>(conn: AgentConn, path: string, body: Buffer, params: Record<string, string | number> = {}): Promise<T> {
  if (!conn.cert) throw new AgentError('this agent cannot be pushed to (no pinned certificate)');
  return pinnedFetch<T>(conn, path, params, body);
}

/**
 * A paired Windows agent: TLS 1.3 to a certificate whose hash must match before anything is sent, then a request
 * signed with HMAC-SHA256 over method, path, query, time and a one-time nonce. The key itself never travels.
 * With a body (an update push) the method is POST and the body is covered by the SHA-256 in the signed query.
 * The agent answers 404 to anything it does not accept, a bad signature included.
 */
async function pinnedFetch<T>(conn: AgentConn, path: string, params: Record<string, string | number>, body?: Buffer): Promise<T> {
  const method = body ? 'POST' : 'GET';
  const base = new URL(conn.url);
  const u = new URL(`${base.pathname.replace(/\/+$/, '')}/v1/${path}`, base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const port = Number(u.port) || 443;
  const where = `${u.hostname}:${port}`;

  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const sock = connect({
      host: u.hostname,
      port,
      servername: isIP(u.hostname) ? undefined : u.hostname,
      minVersion: 'TLSv1.3',
      // self-signed: trust comes from the pinned hash below, not from a CA
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => sock.destroy(new Error('timed out')), 15_000);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const fp = sock.getPeerCertificate()?.fingerprint256 ?? '';
      if (normCert(fp) !== normCert(conn.cert!)) {
        sock.destroy();
        return reject(new AgentError(`certificate mismatch at ${where}: this is not the paired agent`));
      }
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(new AgentError(`cannot reach ${where}: ${e.message}`));
    });
  });

  const t = String(Math.floor(Date.now() / 1000));
  const n = randomBytes(16).toString('hex');
  const query = u.search.replace(/^\?/, '');
  const sig = createHmac('sha256', Buffer.from(conn.token, 'hex')).update(`${method}\n${u.pathname}\n${query}\n${t}\n${n}`).digest('hex');

  return new Promise<T>((resolve, reject) => {
    // createConnection reuses an already-open TLS socket, so request() timeout is not always armed;
    // an overall deadline is what stops a hung Cursor sqlite read from freezing ingest.
    let settled = false;
    let deadline: ReturnType<typeof setTimeout>;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    deadline = setTimeout(() => {
      socket.destroy();
      finish(() => reject(new AgentError(`cannot reach ${where}: timed out`)));
    }, TIMEOUT_MS);
    const req = request(
      {
        createConnection: () => socket,
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        method,
        headers: {
          authorization: `Signature t=${t},n=${n},s=${sig}`,
          host: where,
          connection: 'close',
          ...(body ? { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } : {}),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return finish(() =>
            reject(
              new AgentError(res.statusCode === 404 ? 'agent answered 404 (wrong pairing code, clock difference or unknown source)' : `agent answered ${res.statusCode}`),
            ),
          );
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy();
            return finish(() => reject(new AgentError('agent answer too large')));
          }
          chunks.push(c);
        });
        res.on('end', () => {
          finish(() => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
            } catch {
              reject(new AgentError('agent answer is not JSON'));
            }
          });
        });
        res.on('error', (e) => finish(() => reject(new AgentError(`${where}: ${e.message}`))));
      },
    );
    req.on('timeout', () => {
      socket.destroy();
      finish(() => reject(new AgentError(`cannot reach ${where}: timed out`)));
    });
    req.on('error', (e) => finish(() => reject(e instanceof AgentError ? e : new AgentError(`cannot reach ${where}: ${e.message}`))));
    if (body) req.write(body);
    req.end();
  });
}

export function agentReader(conn: AgentConn, source: string): RowReader {
  return {
    // a Windows agent's rows are whole chats: fewer per page
    batchSize: conn.cert ? 5 : 20,
    async oldest() {
      return (await agentFetch<{ oldest: string | null }>(conn, 'oldest', { source })).oldest;
    },
    async batch(ts, id, limit) {
      return (await agentFetch<{ rows: RawRow[] }>(conn, 'rows', { source, ts, id, limit })).rows;
    },
    async keyInfo(from, to) {
      // agents older than this endpoint answer 404: requests then fall back to the source's key
      try {
        return await agentFetch<KeyInfo>(conn, 'keys', { source, from, to });
      } catch (e) {
        if (e instanceof AgentError && /answered 404/.test(e.message)) return { keys: [], usage: [] };
        throw e;
      }
    },
    close() {},
  };
}
