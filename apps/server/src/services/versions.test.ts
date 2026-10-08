import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, readRawConfig } from '@funnel/engine/testing';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { VersionService, canonicalJson, configChecksum, releaseStack, seedFromFile } from './versions';

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: [3, { y: 1, x: null }], a: 'z' })).toBe('{"a":"z","b":[3,{"x":null,"y":1}]}');
    expect(configChecksum({ a: 1, b: { c: 2, d: 3 } })).toBe(configChecksum({ b: { d: 3, c: 2 }, a: 1 }));
    expect(configChecksum([1, 2])).not.toBe(configChecksum([2, 1]));
  });
});

describe('releaseStack', () => {
  it('pushes on publish and pops on rollback', () => {
    expect(
      releaseStack([
        { action: 'publish', version: 1 },
        { action: 'publish', version: 2 },
        { action: 'publish', version: 3 },
        { action: 'rollback', version: 2 },
        { action: 'publish', version: 4 },
      ]),
    ).toEqual([1, 2, 4]);
  });
});

describe('seedFromFile', () => {
  it('stores and publishes the seed once, then leaves the funnel alone', () => {
    const db = openDb(':memory:');
    expect(seedFromFile(db, configPath('funnel-v1.json'))).toEqual({ funnelId: 'workstyle-planner', version: 1, seeded: true });
    expect(seedFromFile(db, configPath('funnel-v2.json'))).toEqual({ funnelId: 'workstyle-planner', version: 2, seeded: false });
    const versions = new VersionService(db, () => new Date());
    expect(versions.getActiveVersion('workstyle-planner')).toBe(1);
    expect(versions.overview('workstyle-planner').versions).toHaveLength(1);
    db.close();
  });

  it('refuses an invalid seed config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'funnel-seed-'));
    const path = join(dir, 'broken.json');
    writeFileSync(path, JSON.stringify({ ...readRawConfig(1), defaultResultId: 'nope' }));
    const db = openDb(':memory:');
    expect(() => seedFromFile(db, path)).toThrow(/defaultResultId: Unknown result "nope"/);
    db.close();
  });
});
