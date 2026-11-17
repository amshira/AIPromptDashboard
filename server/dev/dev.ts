// Local dev harness: in-memory Postgres (pglite over a socket) + generated 9router-shaped sqlite fixtures + the real server.
//   npm -w server run dev:fixture      (admin password: dev-password-1)
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
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
  flytoday: [
    { account: 'aa11', home: 'C:\\Users\\M.Karimi' },
    { account: 'bb22', home: 'C:\\Users\\S.Rezaei' },
  ],
  hotelcontract: [{ account: 'cc33', home: 'C:\\Users\\P.Sahebi.ABNOOSGASHT' }],
  parto: [{ account: 'dd44', home: 'C:\\Users\\A.Moradi' }],
  devops: [{ account: 'ee55', home: 'C:\\Users\\N.Hosseini' }],
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
      const first = u(d % 2 ? '<system-reminder>claudeMd</system-reminder>\nسلام، این PR رو ریویو کن و ایرادهای HotelContract رو بگو' : 'Fix the failing unit test in `BookingService.spec.ts` and explain what was wrong.');
      let hist: unknown[] = [first];
      record(db, p, base, hist, model, 4200, 120, 'برای شروع باید فایل‌ها رو بخونم.');
      hist = [...hist, a(text('برای شروع باید فایل‌ها رو بخونم.'), tool(`t${n}a`, 'Bash', { command: 'git diff main...HEAD --stat', description: 'diff' })), result(`t${n}a`, ' src/Hotel.cs | 42 +++\n src/Contract.cs | 7 -\n 2 files changed')];
      record(db, p, base + 40_000, hist, model, 5200, 340);
      hist = [
        ...hist,
        a(text('## نتیجه‌ی بررسی\n\n- در `Hotel.cs` یک **null reference** وجود دارد.\n- تست `BookingService.spec.ts` باید mock را `await` کند.\n\n```ts\nawait service.book(dto);\n```')),
        u('ممنون! لطفاً fix رو هم بزن'),
      ];
      record(db, p, base + 120_000, hist, model, 6100, 780);
      hist = [...hist, a(tool(`t${n}b`, 'Bash', { command: 'dotnet test' })), result(`t${n}b`, 'error CS0103: The name x does not exist\nBuild FAILED.', true), a(text('Build failed، دوباره امتحان می‌کنم.')), u('[Request interrupted by user]')];
      record(db, p, base + 300_000, hist, model, 7300, 410);
      // classifier + title (aux)
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
  PG_POOL_MAX: '1', // pglite serves one connection at a time
  // install links serve the locally built agent (go build -o agent-windows/dist/pd-agent.exe)
  AGENT_BIN_DIR: process.env.AGENT_BIN_DIR ?? resolve('../agent-windows/dist'),
  PC_AGENT_ALLOW: process.env.PC_AGENT_ALLOW ?? '127.0.0.1',
});
// a per-user style compose next to one database, so the panels page shows detected ports
writeFileSync(
  join(src.root, 'parto', 'docker-compose.yml'),
  ['services:', '  9router:', '    container_name: 9r-parto-a.moradi', '    ports:', '      - "9101:20128"', '  quota:', '    container_name: 9r-parto-a.moradi-quota', '    ports:', '      - "8101:8088"', ''].join('\n'),
);
console.log('fixtures in', src.root);
await import('../src/main.js');
