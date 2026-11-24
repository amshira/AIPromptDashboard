// Local dev harness: in-memory Postgres (pglite over a socket) + generated 9router-shaped sqlite fixtures + the real server.
//   npm -w server run dev:fixture      (admin password: dev-password-1)
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { makeSourceDir } from '../test/helpers.js';

const PG_PORT = 54399;
const mem = await PGlite.create();
await new PGLiteSocketServer({ db: mem, port: PG_PORT, host: '127.0.0.1' }).start();

const src = makeSourceDir();
const day = 86400_000;
const now = Date.now();

const text = (t: string) => ({ type: 'text', text: t });
const u = (t: string) => ({ role: 'user', content: [text(t)] });
const a = (...c: unknown[]) => ({ role: 'assistant', content: c });
const tool = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const result = (id: string, t: string, isError = false) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: t, is_error: isError }] });

interface Person {
  account: string;
  home: string;
}
const people: Record<string, Person[]> = {
  north: [{ account: 'aa11', home: 'C:\\Users\\M.Lee' }],
  south: [{ account: 'bb22', home: 'C:\\Users\\S.Park' }],
  east: [{ account: 'cc33', home: 'C:\\Users\\P.Ng' }],
  west: [{ account: 'dd44', home: 'C:\\Users\\A.Cole' }],
};

const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
let n = 0;

const hex = (n: number, len: number) => n.toString(16).padStart(len, '0').slice(-len);
const hexSess = (p: Person, ts: number) => `${hex(Math.floor((ts - 6 * 3600_000) / day), 8)}-0000-4000-8000-${p.account.padEnd(12, '0')}`;

function record(db: ReturnType<typeof src.open>, p: Person, ts: number, messages: unknown[], model: string, inTok: number, outTok: number, resp = '') {
  const meta = { user_id: `user_${p.account}_account_${p.account}0000-0000-0000-0000-000000000000_session_${hexSess(p, ts)}` };
  src.insert(db, {
    id: `r${++n}`,
    timestamp: new Date(ts).toISOString(),
    model,
    data: {
      tokens: { prompt_tokens: inTok, completion_tokens: outTok, cache_read_input_tokens: Math.round(inTok * 6), cache_creation_input_tokens: Math.round(inTok * 0.3) },
      latency: { ttft: 400 + (n % 7) * 90, total: 2000 + (n % 11) * 700 },
      request: { system: [text(`You are Claude Code. cwd: ${p.home}\\repos\\app`)], tools: [{ name: 'Bash' }], metadata: meta, messages },
      response: { content: resp || 'باشه، انجام می‌دم.' },
    },
  });
}

for (const [name, ps] of Object.entries(people)) {
  const db = src.open(name);
  for (const p of ps) {
    for (let d = 9; d >= 0; d--) {
      if ((d + p.account.charCodeAt(0)) % 4 === 0) continue;
      const base = now - d * day - 3 * 3600_000 * ((p.account.charCodeAt(1) % 3) + 1);
      const model = models[(d + p.account.charCodeAt(0)) % 3];
      const first = u(d % 2 ? '<system-reminder>claudeMd</system-reminder>\nسلام، این PR رو ریویو کن و ایرادهای Catalog رو بگو' : 'Fix the failing unit test in `InventoryService.spec.ts` and explain what was wrong.');
      let hist: unknown[] = [first];
      record(db, p, base, hist, model, 4200, 120, 'برای شروع باید فایل‌ها رو بخونم.');
      hist = [...hist, a(text('برای شروع باید فایل‌ها رو بخونم.'), tool(`t${n}a`, 'Bash', { command: 'git diff main...HEAD --stat', description: 'diff' })), result(`t${n}a`, ' src/Item.cs | 42 +++\n src/Catalog.cs | 7 -\n 2 files changed')];
      record(db, p, base + 40_000, hist, model, 5200, 340);
      hist = [
        ...hist,
        a(text('## نتیجه‌ی بررسی\n\n- در `Item.cs` یک **null reference** وجود دارد.\n- تست `InventoryService.spec.ts` باید mock را `await` کند.\n\n```ts\nawait service.save(dto);\n```')),
        u('ممنون! لطفاً fix رو هم بزن'),
      ];
      record(db, p, base + 120_000, hist, model, 6100, 780);
      hist = [...hist, a(tool(`t${n}b`, 'Bash', { command: 'dotnet test' })), result(`t${n}b`, 'error CS0103: The name x does not exist\nBuild FAILED.', true), a(text('Build failed، دوباره امتحان می‌کنم.')), u('[Request interrupted by user]')];
      record(db, p, base + 300_000, hist, model, 7300, 410);
      src.insert(db, {
        id: `c${++n}`,
        timestamp: new Date(base + 301_000).toISOString(),
        model: 'claude-haiku-5-5',
        data: { tokens: { prompt_tokens: 900, completion_tokens: 8 }, request: { metadata: { user_id: `user_${p.account}_account_${p.account}0000-0000-0000-0000-000000000000_session_00000000-0000-4000-8000-000000000000` }, messages: [u('<transcript>x</transcript> Err on the side of blocking. <block>')] }, response: { content: '<block>no' } },
      });
    }
  }
  db.close();
}

Object.assign(process.env, {
  DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`,
  SOURCES_DIR: src.root,
  ADMIN_PASSWORD: 'dev-password-1',
  SUPER_PASSWORD: 'dev-super-2',
  SESSION_SECRET: 'dev-secret-dev-secret-dev-secret-0123',
  PORT: process.env.PORT ?? '9010',
  PG_POOL_MAX: '1',
  AGENT_BIN_DIR: process.env.AGENT_BIN_DIR ?? resolve('../agent-windows/dist'),
  PC_AGENT_ALLOW: process.env.PC_AGENT_ALLOW ?? '127.0.0.1',
});
writeFileSync(
  join(src.root, 'west', 'docker-compose.yml'),
  ['services:', '  9router:', '    container_name: 9r-west-a.cole', '    ports:', '      - "9101:20128"', '  quota:', '    container_name: 9r-west-a.cole-quota', '    ports:', '      - "8101:8088"', ''].join('\n'),
);
console.log('fixtures in', src.root);
await import('../src/main.js');

const tok = 'ab'.repeat(32);
const cert = 'cd'.repeat(32);
const seed = async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15_000 });
  const q = async (sql: string, params: unknown[] = []) => {
    for (let i = 0; i < 8; i++) {
      try {
        return await pool.query(sql, params);
      } catch (e) {
        if (i === 7) throw e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw new Error('seed query failed');
  };
  const setPanel = async (name: string, org: string, panel: string, quota: string) => {
    await q(`UPDATE panels SET org=$2, panel_domain=$3, quota_domain=$4, password_enc='fixture', password_from='fixture' WHERE name=$1 AND deleted_at IS NULL`, [name, org, panel, quota]);
  };
  await setPanel('north', 'north', 'api.lee.example.org', 'lee.example.org');
  await setPanel('south', 'south', 'api.park.example.org', 'park.example.org');
  await setPanel('east', 'east', 'api.east.example.org', 'east.example.org');
  await setPanel('west', 'west', 'api.cole.example.org', 'cole.example.org');
  const pc1 = await q(
    `INSERT INTO servers(name,label,url,token,cert_sha256,info,last_seen_at,last_error)
     VALUES('pc-01','pc-01','https://10.1.2.10:14538/abcdefghijklmnopqrstuvwx',$1,$2,$3,now(),NULL)
     ON CONFLICT (name) DO UPDATE SET info=$3, last_seen_at=now(), last_error=NULL RETURNING id`,
    [
      tok,
      cert,
      JSON.stringify({
        agent: { host: 'DESKTOP-ALPHA', version: '1.7.4' },
        sources: [
          { name: 'cursor-m.lee', profile: 'M.Lee', kind: 'cursor', account: 'CORP\\M.Lee', email: 'm.lee@example.org', plan: 'Pro', chats: 18 },
          { name: 'cursor-s.park', profile: 'S.Park', kind: 'cursor', account: 'CORP\\S.Park', email: 's.park@example.org', plan: 'Pro', chats: 11 },
        ],
      }),
    ],
  );
  const pc2 = await q(
    `INSERT INTO servers(name,label,url,token,cert_sha256,info,last_seen_at,last_error)
     VALUES('pc-02','pc-02','https://10.1.2.11:14538/abcdefghijklmnopqrstuvwx',$1,$2,$3,now(),NULL)
     ON CONFLICT (name) DO UPDATE SET info=$3, last_seen_at=now(), last_error=NULL RETURNING id`,
    [
      tok,
      cert,
      JSON.stringify({
        agent: { host: 'LAPTOP-BETA', version: '1.7.4' },
        sources: [
          { name: 'cursor-a.cole', profile: 'A.Cole', kind: 'cursor', account: 'CORP\\A.Cole', email: 'a.cole@example.org', plan: 'Pro', chats: 9 },
          { name: 'codex-a.cole', profile: 'A.Cole', kind: 'codex', account: 'CORP\\A.Cole', chats: 4 },
        ],
      }),
    ],
  );
  const id1 = pc1.rows[0].id as number;
  const id2 = pc2.rows[0].id as number;
  await q(
    `INSERT INTO sources(name,label,server_id,remote_name) VALUES
      ('pc-01/cursor-m.lee','DESKTOP-ALPHA / cursor-m.lee',$1,'cursor-m.lee'),
      ('pc-01/cursor-s.park','DESKTOP-ALPHA / cursor-s.park',$1,'cursor-s.park'),
      ('pc-02/cursor-a.cole','LAPTOP-BETA / cursor-a.cole',$2,'cursor-a.cole'),
      ('pc-02/codex-a.cole','LAPTOP-BETA / codex-a.cole',$2,'codex-a.cole')
     ON CONFLICT (name) DO UPDATE SET server_id=EXCLUDED.server_id, remote_name=EXCLUDED.remote_name`,
    [id1, id2],
  );
  await pool.end();
  console.log('seeded sample panels and Windows PCs');
};
setTimeout(() => void seed().catch((e) => console.error('seed failed', e)), 5000);
