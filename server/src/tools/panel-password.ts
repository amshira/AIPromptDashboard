// Stores a panel's login password without it ever being typed into a terminal or shown:
//   grep '^INITIAL_PASSWORD=' /opt/9router-users/example-user/.env | cut -d= -f2- \
//     | docker exec -i prompt-dashboard-app node server/dist/tools/panel-password.js example-org/example-user ".env (INITIAL_PASSWORD)"
// The first argument is the source name shown in Settings; the second says where the password came from.
import { ensureSecret } from '../auth.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/index.js';
import { sealPassword } from '../ingest/panels.js';

const [source, from = 'دستی'] = process.argv.slice(2);
if (!source) {
  console.error('usage: panel-password.js <source-name> [from] < password');
  process.exit(2);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, '').replace(/^["']|["']$/g, '');
if (!password) {
  console.error('empty password on stdin');
  process.exit(2);
}
const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
try {
  const secret = await ensureSecret(db, cfg);
  const r = await db.query(
    `UPDATE panels p SET password_enc=$2, password_from=$3, password_at=now(), updated_at=now() FROM sources s WHERE s.id=p.source_id AND s.name=$1`,
    [source, sealPassword(secret, password), from],
  );
  console.log(r.rowCount ? `saved for ${source}` : `no panel for source ${source}`);
  process.exitCode = r.rowCount ? 0 : 1;
} finally {
  await db.end();
}
