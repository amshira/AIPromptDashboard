import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { compactStorage, createPool, migrate } from './db/index.js';
import { discoverAllRemotes, discoverSources, syncSource } from './ingest/sync.js';
import { detectPanels } from './ingest/panels.js';
import { upgradeData } from './ingest/upgrade.js';
import { ensureDefaultSchedule, startScheduler } from './scheduler.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, Number(process.env.PG_POOL_MAX) || 8);

// Postgres may still be starting when the container comes up.
for (let i = 1; ; i++) {
  try {
    await migrate(db);
    break;
  } catch (e) {
    if (i >= 30) throw e;
    console.warn(`waiting for database (${i}/30): ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const found = await discoverSources(db, cfg.sourcesDir);
await detectPanels(db, cfg.sourcesDir);
// before the scheduler: stored data must match what the ingest writes from now on
await upgradeData(db, cfg.sourcesDir, { info: (m) => console.log(m), error: (e, m) => console.error(m, e) });
await compactStorage(db, (m) => console.log(m));
void discoverAllRemotes(db);
await ensureDefaultSchedule(db);

const app = await buildApp(db, cfg);
const stop = startScheduler(db, cfg.sourcesDir, app.log);
// 9routers seen for the first time (or back again) are synced now, not at the next schedule
for (const id of found) void syncSource(db, cfg.sourcesDir, id, 'discover').catch(() => undefined);
await app.listen({ port: cfg.port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stop();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
