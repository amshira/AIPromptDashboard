import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { discoverSources, syncSource } from '../src/ingest/sync.js';
import { Schedule, inWindow, isDue, nextRuns, runRetention, tick } from '../src/scheduler.js';
import { makeSourceDir, req, startTestDb } from './helpers.js';

const u = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const a = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

let t: Awaited<ReturnType<typeof startTestDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;
const src = makeSourceDir();
let cookie = '';
// keep the "today" fixtures (up to 10 min old) on one Tehran day even when tests run just after midnight
const tehranMinOfDay = (Date.now() / 60_000 + 210) % 1440;
const now = Date.now() + (tehranMinOfDay < 15 ? (15 - tehranMinOfDay) * 60_000 : 0);
const iso = (daysAgo: number, min = 0) => new Date(now - daysAgo * 86_400_000 + min * 60_000).toISOString();

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  t = await startTestDb(54330);
  const cfg = { ...loadConfig({}), adminPassword: 'correct-horse', superPassword: 'super-horse-99', sourcesDir: src.root, webDir: '/nonexistent' };
  app = await buildApp(t.pool, cfg, { logger: false });
  const db = src.open('acme');
  const h1 = [u('سلام')];
  src.insert(db, { id: 'a1', timestamp: iso(0, -10), model: 'claude-opus-5-5', data: req(h1, { prompt_tokens: 100, completion_tokens: 20 }) });
  src.insert(db, { id: 'a2', timestamp: iso(0, -5), model: 'claude-sonnet-5-5', data: req([...h1, a('هی'), u('بگو')], { prompt_tokens: 200, completion_tokens: 40 }) });
  src.insert(db, { id: 'old', timestamp: iso(20), data: req([u('very old chat')], { prompt_tokens: 5, completion_tokens: 5 }, {}, { session: 'old-session' }) });
  db.close();
  await discoverSources(t.pool, src.root);
  const id = (await t.pool.query('SELECT id FROM sources')).rows[0].id;
  await syncSource(t.pool, src.root, id, 'manual');
});
afterAll(async () => {
  await app.close();
  await t.stop();
});

describe('auth', () => {
  it('protects the API', async () => {
    expect((await call('GET', '/api/overview')).statusCode).toBe(401);
    expect((await call('GET', '/healthz')).statusCode).toBe(200);
  });
  it('rejects a wrong password and accepts the right one', async () => {
    expect((await call('POST', '/api/auth/login', { password: 'nope' })).statusCode).toBe(401);
    const ok = await call('POST', '/api/auth/login', { password: 'correct-horse' });
    expect(ok.statusCode).toBe(200);
    const c = ok.cookies.find((x) => x.name === 'pd_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Strict');
    cookie = `pd_session=${c.value}`;
    expect((await call('GET', '/api/auth/me')).json()).toEqual({ authenticated: true, super: false });
  });
  it('rejects a tampered cookie', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: 'pd_session=9999999999999.AAAA' } });
    expect(r.statusCode).toBe(401);
  });
  it('locks out after five failures', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'x' }, remoteAddress: '10.9.9.9' })).statusCode;
    expect(last).toBe(429);
  });
  it('ignores X-Forwarded-For unless told it is behind a proxy', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++)
      last = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'x' }, remoteAddress: '10.9.9.8', headers: { 'x-forwarded-for': `1.2.3.${i}` } })).statusCode;
    expect(last).toBe(429);
  });
  it('sends security headers', async () => {
    const h = (await call('GET', '/healthz')).headers;
    expect(h['content-security-policy']).toContain("script-src 'self'");
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['strict-transport-security']).toBeUndefined(); // plain http here
  });
  it('changing the password invalidates other sessions', async () => {
    const old = cookie;
    const r = await call('POST', '/api/auth/password', { current: 'correct-horse', next: 'another-long-one' });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: old } })).statusCode).toBe(401);
    cookie = `pd_session=${r.cookies.find((x) => x.name === 'pd_session')!.value}`;
    expect((await call('GET', '/api/overview')).statusCode).toBe(200);
  });
  it('lets only the super password hide a conversation in the 5-day archive', async () => {
    const list = (await call('GET', '/api/sessions?from=2000-01-01&to=2100-01-01')).json();
    const id = list.sessions[0].id as number;
    expect((await call('DELETE', `/api/sessions/${id}`)).statusCode).toBe(403);
    const sup = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'super-horse-99' } });
    expect(sup.statusCode).toBe(200);
    expect(sup.json()).toMatchObject({ ok: true, super: true });
    const sc = `pd_session=${sup.cookies.find((x) => x.name === 'pd_session')!.value}`;
    const del = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: { cookie: sc } });
    expect(del.statusCode).toBe(200);
    expect(del.json().keep_days).toBe(5);
    expect((await call('GET', `/api/sessions/${id}`)).statusCode).toBe(404);
    expect((await call('GET', '/api/sessions?archived=1&from=2000-01-01&to=2100-01-01')).statusCode).toBe(403);
    const arch = await app.inject({ method: 'GET', url: '/api/sessions?archived=1&from=2000-01-01&to=2100-01-01', headers: { cookie: sc } });
    expect(arch.json().sessions.some((s: { id: number }) => s.id === id)).toBe(true);
    await app.inject({ method: 'POST', url: `/api/sessions/${id}/restore`, headers: { cookie: sc } });
    expect((await call('GET', `/api/sessions/${id}`)).statusCode).toBe(200);
  });
});

describe('reports', () => {
  it('overview totals tokens', async () => {
    const o = (await call('GET', '/api/overview?from=2000-01-01&to=2100-01-01')).json();
    expect(o.kpi.input_tokens).toBe(305);
    expect(o.kpi.output_tokens).toBe(65);
    expect(o.kpi.sessions).toBe(2);
    expect(o.sources[0].total_requests).toBe(3);
  });
  it('daily report groups per user with models and shamsi date', async () => {
    const r = (await call('GET', '/api/reports/daily?by=user&from=2000-01-01&to=2100-01-01')).json();
    const today = r.rows[0];
    expect(today.requests).toBe(2);
    expect(today.models.sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(today.day_shamsi).toMatch(/^14\d\d\/\d\d\/\d\d$/);
    expect(today.human_messages).toBe(2);
  });
  it('csv export has a BOM and header', async () => {
    const r = await call('GET', '/api/reports/daily?format=csv&by=user,model&from=2000-01-01&to=2100-01-01');
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.body.charCodeAt(0)).toBe(0xfeff);
  });
  it('session detail returns messages and its requests', async () => {
    const list = (await call('GET', '/api/sessions?from=2000-01-01&to=2100-01-01')).json();
    expect(list.total).toBe(2);
    const s = list.sessions.find((x: any) => x.title === 'سلام');
    const d = (await call('GET', `/api/sessions/${s.id}`)).json();
    expect(d.messages.map((m: any) => m.kind)).toEqual(['human', 'assistant_text', 'human']);
    expect(d.requests).toHaveLength(2);
    expect(d.threads).toHaveLength(1);
    expect(s.user_name).toBe('کلید اصلی منبع'); // no api keys in this fixture: one source user, never "unknown"
  });
  it('searches message text with persian folding', async () => {
    const hit = (await call('GET', '/api/sessions?from=2000-01-01&to=2100-01-01&q=' + encodeURIComponent('بگو'))).json();
    expect(hit.total).toBe(1);
    const miss = (await call('GET', '/api/sessions?from=2000-01-01&to=2100-01-01&q=zzz')).json();
    expect(miss.total).toBe(0);
  });
});

describe('schedules', () => {
  const base: Schedule = { id: 1, name: 's', source_ids: [], mode: 'interval', every_min: 10, cron: null, days: null, from_hour: null, to_hour: null, enabled: true, last_run_at: null };
  it('respects the interval', () => {
    expect(isDue({ ...base, last_run_at: new Date(Date.now() - 9 * 60_000).toISOString() }, new Date())).toBe(false);
    expect(isDue({ ...base, last_run_at: new Date(Date.now() - 11 * 60_000).toISOString() }, new Date())).toBe(true);
  });
  it('handles the tehran hour window, including wrap past midnight', () => {
    // 2026-10-26T06:00Z = 09:30 Tehran (UTC+3:30)
    const d = new Date('2026-10-26T06:00:00Z');
    expect(inWindow({ days: null, from_hour: 8, to_hour: 20 }, d)).toBe(true);
    expect(inWindow({ days: null, from_hour: 10, to_hour: 20 }, d)).toBe(false);
    expect(inWindow({ days: null, from_hour: 22, to_hour: 10 }, d)).toBe(true);
  });
  it('filters by weekday (0=Sunday)', () => {
    const mon = new Date('2026-10-26T06:00:00Z');
    expect(inWindow({ days: [1], from_hour: null, to_hour: null }, mon)).toBe(true);
    expect(inWindow({ days: [2, 3], from_hour: null, to_hour: null }, mon)).toBe(false);
  });
  it('previews cron runs', () => {
    const runs = nextRuns({ ...base, mode: 'cron', cron: '*/15 * * * *', every_min: null }, new Date('2026-10-26T06:00:00Z'), 3);
    expect(runs).toHaveLength(3);
    expect(runs[1].getTime() - runs[0].getTime()).toBe(15 * 60_000);
  });
  it('validates via the API', async () => {
    expect((await call('POST', '/api/schedules', { name: 'x', mode: 'cron', cron: 'not a cron' })).statusCode).toBe(400);
    const ok = await call('POST', '/api/schedules', { name: 'work hours', mode: 'interval', every_min: 10, days: [0, 1, 2, 3, 4], from_hour: 8, to_hour: 20 });
    expect(ok.statusCode).toBe(200);
    const list = (await call('GET', '/api/schedules')).json();
    expect(list.schedules.some((s: any) => s.name === 'work hours')).toBe(true);
  });
  it('tick runs due schedules and records the run', async () => {
    await t.pool.query('DELETE FROM schedules');
    await t.pool.query(`INSERT INTO schedules(name, mode, every_min) VALUES('all','interval',5)`);
    expect(await tick(t.pool, src.root)).toBe(1);
    expect((await t.pool.query(`SELECT count(*)::int n FROM sync_runs WHERE trigger='schedule'`)).rows[0].n).toBeGreaterThan(0);
    expect(await tick(t.pool, src.root)).toBe(0); // not due again straight away
  });
});

describe('retention', () => {
  it('removes data older than N days and keeps the rest', async () => {
    const r = await runRetention(t.pool, new Date(), false);
    expect(r.requests).toBe(0); // no retention configured => nothing deleted
    await call('PUT', '/api/settings/retention', { days: 10 });
    const r2 = await runRetention(t.pool, new Date(), false);
    expect(r2.requests).toBe(1);
    expect(r2.sessions).toBe(1);
    expect((await t.pool.query('SELECT count(*)::int n FROM requests')).rows[0].n).toBe(2);
    // the text of the removed chat is gone too
    expect((await t.pool.query(`SELECT count(*)::int n FROM texts WHERE body='very old chat'`)).rows[0].n).toBe(0);
    expect(r2.texts).toBeGreaterThan(0);
  });
  it('per-source override wins over the global setting', async () => {
    await call('PATCH', '/api/sources/1', { retention_days: 365 });
    expect((await call('GET', '/api/sources')).json().sources[0].retention_days).toBe(365);
  });
});
