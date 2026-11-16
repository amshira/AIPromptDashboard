import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverSources, findDatabases, sourceNameOf, syncSource } from '../src/ingest/sync.js';
import { makeSourceDir, req, startTestDb } from './helpers.js';

const u = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });

let t: Awaited<ReturnType<typeof startTestDb>>;
const src = makeSourceDir();

beforeAll(async () => {
  t = await startTestDb(54337);
  src.open('devops').close();
  const db =   src.open('users/acmeusers/example-user/data/db');
  src.insert(db, { id: 'r1', timestamp: new Date().toISOString(), data: req([u('سلام')], { prompt_tokens: 10, completion_tokens: 2 }) });
  db.close();
  src.open('users/acmeusers/example-user/data/db/backups/old').close();
  src.open('users/_template/data/db').close();
});
afterAll(async () => {
  await t.stop();
});

const local = async () =>
  (await t.pool.query('SELECT id, name, path, missing_since FROM sources WHERE server_id IS NULL ORDER BY name')).rows as Array<{
    id: number;
    name: string;
    path: string;
    missing_since: Date | null;
  }>;

describe('source discovery', () => {
  it('names per-user instances by org and user', () => {
    expect(sourceNameOf('devops')).toBe('devops');
    expect(sourceNameOf('users/acmeusers/example-user/data/db')).toBe('acme/example-user');
    expect(sourceNameOf('exampleorgusers/pat/data/db')).toBe('exampleorg/pat');
  });

  it('finds nested databases, skipping backups and template folders', () => {
    expect(findDatabases(src.root)).toEqual(['devops', 'users/acmeusers/example-user/data/db']);
  });

  it('registers them and syncs from the nested folder', async () => {
    expect(await discoverSources(t.pool, src.root)).toHaveLength(2);
    const rows = await local();
    expect(rows.map((r) => [r.name, r.path])).toEqual([
      ['devops', 'devops'],
      ['acme/example-user', 'users/acmeusers/example-user/data/db'],
    ]);
    const out = await syncSource(t.pool, src.root, rows[1].id, 'test');
    expect(out.error).toBeUndefined();
    expect(out.rowsNew).toBe(1);
    // a second scan adds nothing
    expect(await discoverSources(t.pool, src.root)).toEqual([]);
  });

  it('marks a removed 9router as missing, keeps its data, and brings it back', async () => {
    const moved = `${src.root}-devops-off`; // outside the scanned folder
    renameSync(join(src.root, 'devops'), moved);
    await discoverSources(t.pool, src.root);
    const devops = (await local()).find((r) => r.name === 'devops')!;
    expect(devops.missing_since).not.toBeNull();
    renameSync(moved, join(src.root, 'devops'));
    expect(await discoverSources(t.pool, src.root)).toEqual([devops.id]);
    expect((await local()).find((r) => r.name === 'devops')!.missing_since).toBeNull();
  });

  it('keeps a 9router when its whole folder is mounted instead of data/db', async () => {
    const before = (await local()).find((r) => r.name === 'devops')!;
    const tmp = `${src.root}-devops-db`;
    renameSync(join(src.root, 'devops'), tmp);
    mkdirSync(join(src.root, 'devops/data'), { recursive: true });
    renameSync(tmp, join(src.root, 'devops/data/db'));
    await discoverSources(t.pool, src.root);
    const rows = await local();
    expect(rows.filter((r) => r.name === 'devops')).toEqual([{ ...before, path: 'devops/data/db' }]);
    expect(rows).toHaveLength(2);
  });
});
