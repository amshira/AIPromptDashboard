import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateV4, readPairing } from '../src/api/install.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeSourceDir, startTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof startTestDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let noExe: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
const bin = mkdtempSync(join(tmpdir(), 'pd-bin-'));
const EXE = Buffer.from('MZ fake agent for tests');
const ORIGIN = 'https://pd.example.org';

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie, ...headers } });

const code = (o: object) => 'pda1.' + Buffer.from(JSON.stringify(o)).toString('base64url');
const pairing = { v: 1, host: 'DESKTOP-01', port: 47123, prefix: 'abcdefghijklmnopqrstuvwx', secret: 'ab'.repeat(32), cert: 'cd'.repeat(32) };

beforeAll(async () => {
  writeFileSync(join(bin, 'pd-agent.exe'), EXE);
  t = await startTestDb(54340);
  const cfg = { ...loadConfig({}), adminPassword: 'correct-horse', sourcesDir: makeSourceDir().root, webDir: '/nonexistent', agentBinDir: bin, pcAgentAllow: '127.0.0.1' };
  app = await buildApp(t.pool, cfg, { logger: false });
  noExe = await buildApp(t.pool, { ...cfg, agentBinDir: join(bin, 'missing') }, { logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'correct-horse' } });
  const c = login.cookies.find((x) => x.name === 'pd_session')!;
  cookie = `${c.name}=${c.value}`;
});
afterAll(async () => {
  await app.close();
  await noExe.close();
  await t.stop();
});

describe('install links', () => {
  it('shows nothing without a valid link: every /install/ URL is an empty 404', async () => {
    for (const url of ['/install/windows.ps1', '/install/windows.ps1?t=' + 'a'.repeat(64), '/install/pd-agent.exe?t=x', '/install/pd-agent.zip?t=x', '/install/other']) {
      const r = await app.inject({ url });
      expect(r.statusCode).toBe(404);
      if (url !== '/install/other') expect(r.body).toBe('');
    }
    const e = await app.inject({ method: 'POST', url: '/install/enroll', payload: { code: code(pairing) }, headers: { 'x-install-token': 'a'.repeat(64) } });
    expect(e.statusCode).toBe(404);
  });

  it('needs the login to make a link, and the agent file to be there', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/pcs/install-links', payload: { origin: ORIGIN } })).statusCode).toBe(401);
    const r = await noExe.inject({ method: 'POST', url: '/api/pcs/install-links', payload: { origin: ORIGIN }, headers: { cookie } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('no_agent_exe');
    expect((await call('POST', '/api/pcs/install-links', { origin: 'javascript:alert(1)' })).statusCode).toBe(400);
  });

  it('serves a script for the link that checks the exact agent file, then revokes', async () => {
    const r = await call('POST', '/api/pcs/install-links', { origin: ORIGIN + '/', hours: 2 });
    expect(r.statusCode).toBe(200);
    const { url, command, id } = r.json();
    const token = new URL(url).searchParams.get('t')!;
    const sha = createHash('sha256').update(EXE).digest('hex');
    expect(url).toBe(`${ORIGIN}/install/pd-agent.zip?t=${token}`);
    expect(command).not.toMatch(/iex|ExecutionPolicy|windows\.ps1|install --allow/);
    expect(command).toContain(`curl.exe -L --fail --progress-bar -o $Zip '${url}'`);
    expect(command).toContain(`-ne '${sha}'`);
    expect(command).toContain('sc create PDAgent');
    expect(command).toContain('Expand-Archive');
    expect(command).not.toMatch(/& \$exe/);
    // only the hash of the token is stored
    const stored = (await t.pool.query('SELECT token_hash FROM install_links WHERE id=$1', [id])).rows[0].token_hash;
    expect(stored).toBe(createHash('sha256').update(token).digest('hex'));

    const s = await app.inject({ url: `/install/windows.ps1?t=${token}` });
    expect(s.statusCode).toBe(200);
    expect(s.body).toBe(command);
    expect(s.body).not.toMatch(/iex|ExecutionPolicy/);
    const exe = await app.inject({ url: `/install/pd-agent.exe?t=${token}` });
    expect(exe.rawPayload.equals(EXE)).toBe(true);
    const zip = await app.inject({ url: `/install/pd-agent.zip?t=${token}` });
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(zip.body).toContain('pairing.json');
    expect(zip.body).toContain('config.json');
    expect(zip.body).toContain('"port": 14538');

    const list = (await call('GET', '/api/pcs/install-links')).json();
    expect(list.ready).toBe(true);
    expect(list.links.map((l: { id: number }) => l.id)).toContain(id);
    expect(JSON.stringify(list)).not.toContain(token);

    // enroll: a broken code, then only public addresses (nothing the dashboard may try)
    const h = { 'x-install-token': token };
    expect((await app.inject({ method: 'POST', url: '/install/enroll', payload: { code: 'pda1.nope' }, headers: h })).statusCode).toBe(400);
    const pub = await app.inject({ method: 'POST', url: '/install/enroll', payload: { code: code(pairing), addresses: ['8.8.8.8'] }, headers: h });
    expect(pub.statusCode).toBe(422);
    expect(pub.json().error).toBe('no_private_address');

    await call('DELETE', `/api/pcs/install-links/${id}`);
    expect((await app.inject({ url: `/install/windows.ps1?t=${token}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/install/pd-agent.exe?t=${token}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/install/pd-agent.zip?t=${token}` })).statusCode).toBe(404);
  });

  it('expires', async () => {
    const { url, id } = (await call('POST', '/api/pcs/install-links', { origin: ORIGIN, hours: 1 })).json();
    await t.pool.query(`UPDATE install_links SET expires_at = now() - interval '1 minute' WHERE id=$1`, [id]);
    expect((await app.inject({ url: url.replace(ORIGIN, '') })).statusCode).toBe(404);
  });

  it('updates a PC only from the button, and only when its agent can take the file', async () => {
    const marked = Buffer.concat([EXE, Buffer.from('\0PDAGENT_VERSION=1.6.0\0')]);
    writeFileSync(join(bin, 'pd-agent.exe'), marked);
    const insert = (name: string, version: string | null) =>
      t.pool.query(
        `INSERT INTO servers(name,label,url,token,cert_sha256,info) VALUES($1,$1,'https://10.1.2.3:14538/abcdefghijklmnopqrstuvwx',$2,$3,$4) RETURNING id`,
        [name, 'ab'.repeat(32), 'cd'.repeat(32), version ? JSON.stringify({ agent: { version } }) : null],
      );
    const old = await insert('pc-old', '1.3.0');
    const current = await insert('pc-current', '1.6.0');
    const unknown = await insert('pc-unknown', null);
    try {
      const list = await call('GET', '/api/pcs');
      expect(list.json().agent).toEqual({ version: '1.6.0', min: '1.6.0', minStop: '1.7.4' });
      expect((await call('POST', `/api/pcs/${current.rows[0].id}/stop-agent`)).json().error).toBe('agent_cannot_stop');
      expect((await call('POST', `/api/pcs/${old.rows[0].id}/update-agent`)).json().error).toBe('agent_too_old');
      expect((await call('POST', `/api/pcs/${unknown.rows[0].id}/update-agent`)).json().error).toBe('agent_version_unknown');
      expect((await call('POST', `/api/pcs/${current.rows[0].id}/update-agent`)).json()).toMatchObject({ ok: true, already: true, version: '1.6.0' });
    } finally {
      writeFileSync(join(bin, 'pd-agent.exe'), EXE);
      await t.pool.query('DELETE FROM servers WHERE id = ANY($1)', [[old.rows[0].id, current.rows[0].id, unknown.rows[0].id]]);
    }
  });

  it('reads pairing codes and private addresses strictly', () => {
    expect(readPairing(code(pairing))).toMatchObject({ port: 47123, cert: 'cd'.repeat(32) });
    expect(readPairing(code({ ...pairing, prefix: '../x' }))).toBeNull();
    expect(readPairing(code({ ...pairing, port: 0 }))).toBeNull();
    expect(readPairing('pda2.' + code(pairing).slice(5))).toBeNull();
    for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '172.17.36.40']) expect(privateV4(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '127.0.0.1', '169.254.1.1', '10.0.0.256', 'localhost', '::1']) expect(privateV4(a)).toBe(false);
  });
});
