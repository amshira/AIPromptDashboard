import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { detectPanels, openPassword, parseCompose, purgePanels, sealPassword } from '../src/ingest/panels.js';
import { discoverSources } from '../src/ingest/sync.js';
import { makeSourceDir, startTestDb } from './helpers.js';

const USER_COMPOSE = `name: 9r-acmeusers-example-user
services:
  9router:
    image: decolua/9router:0.5.112
    container_name: 9r-acme-example-user
    ports:
      - "9101:20128"            # admin panel / API endpoint
  quota:
    container_name: 9r-acme-example-user-quota
    ports:
      - "8101:8088"             # public /quota page
`;

let t: Awaited<ReturnType<typeof startTestDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;
const src = makeSourceDir();
let cookie = '';
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie } });

beforeAll(async () => {
  t = await startTestDb(54338);
  src.open('users/acmeusers/example-user/data/db').close();
  writeFileSync(join(src.root, 'users/acmeusers/example-user/docker-compose.yml'), USER_COMPOSE);
  src.open('devops').close();
  await discoverSources(t.pool, src.root);
  await detectPanels(t.pool, src.root);
  app = await buildApp(t.pool, { ...loadConfig({}), adminPassword: 'panel-test-pass', sessionSecret: 's'.repeat(40), sourcesDir: src.root, webDir: '/nonexistent' }, { logger: false });
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'panel-test-pass' } });
  cookie = `pd_session=${r.cookies.find((c) => c.name === 'pd_session')!.value}`;
});
afterAll(async () => {
  await app.close();
  await t.stop();
});

describe('panels', () => {
  it('reads container and ports from a compose file', () => {
    expect(parseCompose(USER_COMPOSE)).toEqual({ container: '9r-acme-example-user', panelPort: 9101, quotaPort: 8101 });
    expect(parseCompose('services:\n  a:\n    container_name: 9router-devops\n    ports:\n      - 9003:20128\n')).toEqual({ container: '9router-devops', panelPort: 9003, quotaPort: null });
  });

  it('encrypts passwords', () => {
    const sealed = sealPassword('k1', 'p@ss word');
    expect(sealed).not.toContain('p@ss');
    expect(openPassword('k1', sealed)).toBe('p@ss word');
    expect(() => openPassword('k2', sealed)).toThrow();
  });

  it('makes one card per 9router', async () => {
    const r = (await call('GET', '/api/panels')).json();
    const user = r.panels.find((p: { name: string }) => p.name === 'example-user');
    expect(user).toMatchObject({ org: 'acme', container: '9r-acme-example-user', quota_port: 8101, has_password: false, panel_domain: null });
    expect(user).not.toHaveProperty('role');
    expect(r.panels.find((p: { name: string }) => p.name === 'devops')).toMatchObject({ org: '', container: null });
    // detection again keeps what was typed by hand
    await call('PATCH', `/api/panels/${user.id}`, { quota_domain: 'user.example.org', password: 'secret-1' });
    await detectPanels(t.pool, src.root);
    const again = (await call('GET', '/api/panels')).json().panels.find((p: { id: number }) => p.id === user.id);
    expect(again).toMatchObject({ quota_domain: 'https://user.example.org', has_password: true, password_from: 'دستی' });
    expect(JSON.stringify(again)).not.toContain('secret-1');
    const pw = await call('GET', `/api/panels/${user.id}/password`);
    expect(pw.headers['cache-control']).toBe('no-store');
    expect(pw.json()).toEqual({ password: 'secret-1' });
    // stored encrypted
    const raw = (await t.pool.query('SELECT password_enc FROM panels WHERE id=$1', [user.id])).rows[0].password_enc;
    expect(raw).toMatch(/^v1:/);
  });

  it('adds, edits and deletes a hand-made panel', async () => {
    expect((await call('POST', '/api/panels', { name: 'litellm', panel_domain: 'not a domain at all' })).statusCode).toBe(400);
    const { id } = (await call('POST', '/api/panels', { name: 'litellm', panel_domain: 'llm.example.org/', password: 'x' })).json();
    const p = (await call('GET', '/api/panels')).json().panels.find((x: { id: number }) => x.id === id);
    expect(p).toMatchObject({ panel_domain: 'https://llm.example.org', has_password: true, source_id: null });
    expect((await call('PATCH', `/api/panels/${id}`, { password: null })).statusCode).toBe(200);
    expect((await call('GET', `/api/panels/${id}/password`)).json()).toEqual({ password: null });
    expect((await call('DELETE', `/api/panels/${id}`)).statusCode).toBe(200);
    // still listed as deleted, then gone for good
    expect((await call('GET', '/api/panels')).json().panels.find((x: { id: number }) => x.id === id).deleted_at).toBeTruthy();
    expect((await call('DELETE', `/api/panels/${id}?now=1`)).json()).toMatchObject({ purged: true });
    expect((await t.pool.query('SELECT 1 FROM panels WHERE id=$1', [id])).rowCount).toBe(0);
  });

  it('keeps a deleted 9router card for 5 days, restorable, then purges it without it coming back', async () => {
    const list = async () => (await call('GET', '/api/panels')).json();
    const p = (await list()).panels.find((x: { name: string }) => x.name === 'devops');
    await call('PATCH', `/api/panels/${p.id}`, { panel_domain: 'devops.example.org', password: 'pw' });
    expect((await call('DELETE', `/api/panels/${p.id}`)).statusCode).toBe(200);
    const del = (await list()).panels.find((x: { id: number }) => x.id === p.id);
    expect(new Date(del.purge_at).getTime() - new Date(del.deleted_at).getTime()).toBe(5 * 86_400_000);
    expect((await list()).keep_days).toBe(5);
    // not checked while deleted
    expect((await call('GET', '/api/panels/status')).json().status[p.id]).toBeUndefined();
    // restore
    expect((await call('POST', `/api/panels/${p.id}/restore`)).statusCode).toBe(200);
    expect((await list()).panels.find((x: { id: number }) => x.id === p.id).deleted_at).toBeNull();
    // delete again; nothing happens before 5 days
    await call('DELETE', `/api/panels/${p.id}`);
    expect(await purgePanels(t.pool)).toBe(0);
    await t.pool.query(`UPDATE panels SET deleted_at = now() - interval '5 days 1 minute' WHERE id=$1`, [p.id]);
    expect(await purgePanels(t.pool)).toBe(1);
    await detectPanels(t.pool, src.root);
    expect((await list()).panels.find((x: { name: string }) => x.name === 'devops')).toBeUndefined();
    const row = (await t.pool.query('SELECT password_enc, panel_domain FROM panels WHERE id=$1', [p.id])).rows[0];
    expect(row).toEqual({ password_enc: null, panel_domain: null });
    expect((await call('POST', `/api/panels/${p.id}/restore`)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/panels/99999?now=1`)).statusCode).toBe(409);
  });
});
