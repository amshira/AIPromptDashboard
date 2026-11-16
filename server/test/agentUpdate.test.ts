import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmpVersion, readAgentExe } from '../src/ingest/agentUpdate.js';

describe('agent version', () => {
  it('orders dotted versions', () => {
    expect(cmpVersion('1.5.0', '1.4.0')).toBeGreaterThan(0);
    expect(cmpVersion('1.4.0', '1.5.0')).toBeLessThan(0);
    expect(cmpVersion('1.4.0', '1.4.0')).toBe(0);
    expect(cmpVersion('1.10.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('reads the version marker out of the exe bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pd-ver-'));
    // bytes around the marker, as in a real exe
    writeFileSync(join(dir, 'pd-agent.exe'), Buffer.concat([Buffer.from('MZ....'), Buffer.from('PDAGENT_VERSION=1.5.0'), Buffer.from('....more')]));
    const exe = readAgentExe(dir);
    expect(exe?.version).toBe('1.5.0');
    expect(exe?.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is null when there is no exe', () => {
    expect(readAgentExe(join(tmpdir(), 'pd-no-such-dir-xyz'))).toBeNull();
  });
});
