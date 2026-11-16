import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAgent } from '../src/agent.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { isRunning, syncSource } from '../src/ingest/sync.js';
import { makeSourceDir, req, startTestDb } from './helpers.js';

const u = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const a = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const TOKEN = 'agent-token-0123456789';

let t: Awaited<ReturnType<typeof startTestDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let agent: Awaited<ReturnType<typeof buildAgent>>;
let agentUrl = '';
let cookie = '';
const remote = makeSourceDir();
const local = makeSourceDir();

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie } });

beforeAll(async () => {
  const db = remote.open('sales');
  const base = Date.now() - 3_600_000;
  // more rows than one agent batch so paging over HTTP is exercised
  for (let i = 0; i < 45; i++) {
    const h = [u('شروع')];
    for (let j = 0; j < i; j++) h.push(a(`جواب ${j}`), u(`سوال ${j}`));
    remote.insert(db, { id: `r${String(i).padStart(3, '0')}`, timestamp: new Date(base + i * 1000).toISOString(), data: req(h) });
  }
  db.close();
  agent = await buildAgent({ sourcesDir: remote.root, token: TOKEN, logger: false });
  await agent.listen({ port: 0, host: '127.0.0.1' });
  const addr = agent.server.address() as { port: number };
  agentUrl = `http://127.0.0.1:${addr.port}`;

  t = await startTestDb(54331);
  app = await buildApp(t.pool, { ...loadConfig({}), adminPassword: 'correct-horse', sourcesDir: local.root, webDir: '/nonexistent' }, { logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'correct-horse' } });
  const c = login.cookies.find((x) => x.name === 'pd_session')!;
  cookie = `${c.name}=${c.value}`;
});
afterAll(async () => {
  await app.close();
  await agent.close();
  await t.stop();
});

describe('agent', () => {
  it('requires the token', async () => {
    expect((await agent.inject({ url: '/agent/v1/sources' })).statusCode).toBe(401);
    expect((await agent.inject({ url: '/agent/v1/sources', headers: { authorization: 'Bearer wrong-token-0123456789' } })).statusCode).toBe(401);
    const ok = await agent.inject({ url: '/agent/v1/sources', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.json()).toEqual({ sources: [{ name: 'sales' }] });
  });
  it('rejects path tricks in the source name', async () => {
    for (const name of ['..%2Fsales', '..', '.']) {
      const r = await agent.inject({ url: `/agent/v1/rows?source=${name}`, headers: { authorization: `Bearer ${TOKEN}` } });
      expect(r.statusCode).toBe(404);
    }
  });
  it('refuses to start with a short token', async () => {
    await expect(buildAgent({ sourcesDir: remote.root, token: 'short', logger: false })).rejects.toThrow();
  });
});

describe('remote servers', () => {
  it('probes before saving and rejects a bad token', async () => {
    const bad = await call('POST', '/api/servers', { name: 'office', url: agentUrl, token: 'wrong-token-0123456789' });
    expect(bad.statusCode).toBe(422);
    const probe = await call('POST', '/api/servers/probe', { url: agentUrl, token: TOKEN });
    expect(probe.json()).toEqual({ ok: true, sources: ['sales'] });
  });

  it('adds a server, registers its 9routers and syncs them', async () => {
    const r = await call('POST', '/api/servers', { name: 'office', label: 'دفتر', url: `${agentUrl}/`, token: TOKEN });
    expect(r.statusCode).toBe(200);
    expect(r.json().sources).toBe(1);
    const src = (await t.pool.query(`SELECT id, label FROM sources WHERE name='office/sales'`)).rows[0];
    expect(src.label).toBe('دفتر / sales');
    while (isRunning(src.id)) await new Promise((r) => setTimeout(r, 20)); // the API kicked off a sync in the background
    const out = await syncSource(t.pool, local.root, src.id, 'manual');
    expect(out.error).toBeUndefined();
    const n = (await t.pool.query('SELECT count(*)::int AS n FROM requests WHERE source_id=$1', [src.id])).rows[0].n;
    expect(n).toBe(45);
    const list = (await call('GET', '/api/servers')).json().servers;
    expect(list[0]).toMatchObject({ name: 'office', source_count: 1 });
    expect(list[0].token).toBeUndefined();
  });

  it('reports an unreachable agent on the source instead of throwing', async () => {
    const id = (await t.pool.query(`SELECT id FROM servers WHERE name='office'`)).rows[0].id;
    await call('PATCH', `/api/servers/${id}`, { url: 'http://127.0.0.1:1' });
    const src = (await t.pool.query(`SELECT id FROM sources WHERE name='office/sales'`)).rows[0];
    const out = await syncSource(t.pool, local.root, src.id, 'manual');
    expect(out.error).toMatch(/cannot reach/);
  });

  it('accepts a Windows agent only with https, a 64-hex key and a certificate hash', async () => {
    const cert = 'AB:'.repeat(31) + 'AB';
    const bad = [
      { url: 'http://10.0.0.5:47000/abcdefghijklmnop', token: 'ab'.repeat(32), cert },
      { url: 'https://10.0.0.5:47000/abcdefghijklmnop', token: 'not-hex-not-hex-not-hex', cert },
      { url: 'https://10.0.0.5:47000/abcdefghijklmnop', token: 'ab'.repeat(32), cert: 'abc' },
    ];
    for (const b of bad) expect((await call('POST', '/api/servers/probe', b)).statusCode).toBe(400);
    // well-formed: tried for real (nothing listens there)
    const ok = await call('POST', '/api/servers/probe', { url: 'https://127.0.0.1:1/abcdefghijklmnop', token: 'ab'.repeat(32), cert });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: false, error: expect.stringMatching(/cannot reach/) });
  });

  it('keeps what an agent said about itself, and lists paired PCs with who is on them', async () => {
    const added = await call('GET', '/api/servers');
    const srv = added.json().servers[0];
    // discovery stores the agent's answer (a 9router agent has no "agent" part)
    expect((await t.pool.query('SELECT info FROM servers WHERE id=$1', [srv.id])).rows[0].info).toEqual({ agent: null, sources: [{ name: 'sales' }] });

    const info = { agent: { host: 'IT-28', version: '1.1.0' }, sources: [{ name: 'cursor-a.nazari', profile: 'a.nazari', account: 'CORP\\a.nazari', email: 'a@x.org', chats: 8 }] };
    const pc = await t.pool.query(
      `INSERT INTO servers(name,label,url,token,cert_sha256,info,last_seen_at) VALUES('it-28','IT-28','https://172.17.36.40:47123/abcdefghijklmnopqrstuvwx',$1,$2,$3,now()) RETURNING id`,
      ['ab'.repeat(32), 'cd'.repeat(32), JSON.stringify(info)],
    );
    await t.pool.query(`INSERT INTO sources(name,label,server_id,remote_name) VALUES('it-28/cursor-a.nazari','IT-28 / cursor-a.nazari',$1,'cursor-a.nazari')`, [pc.rows[0].id]);

    const r = await call('GET', '/api/pcs');
    expect(r.statusCode).toBe(200);
    const pcs = r.json().pcs;
    expect(pcs).toHaveLength(1); // the 9router server is not a PC
    expect(pcs[0]).toMatchObject({ name: 'it-28', info, sources: [{ remote_name: 'cursor-a.nazari', requests: 0 }] });
    // the HMAC key never leaves the server
    expect(JSON.stringify(pcs)).not.toContain('ab'.repeat(32));
    await t.pool.query('DELETE FROM servers WHERE id=$1', [pc.rows[0].id]);
  });

  it('deletes a server with its data', async () => {
    const id = (await t.pool.query(`SELECT id FROM servers WHERE name='office'`)).rows[0].id;
    expect((await call('DELETE', `/api/servers/${id}`)).statusCode).toBe(200);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM requests')).rows[0].n).toBe(0);
  });
});
