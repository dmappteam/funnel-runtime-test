import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  CreateVersionResponse,
  FunnelAdminResponse,
  PublishResponse,
  ReleaseAction,
  RollbackResponse,
  ValidateConfigResponse,
  VersionConfigResponse,
} from '@funnel/contracts';
import {
  FunnelConfigSchema,
  diffConfigs,
  resolveVariant,
  validateConfig,
  type ConfigIssue,
  type FunnelConfig,
  type ResolvedFunnel,
} from '@funnel/engine';
import type { Db } from '../db';
import { ApiHttpError, notFound } from '../errors';

/** JSON with object keys sorted recursively, so the checksum does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function configChecksum(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw)).digest('hex');
}

/** Replays the release log: `publish` pushes its version, `rollback` pops. The top is the active version. */
export function releaseStack(releases: readonly { version: number; action: ReleaseAction }[]): number[] {
  const stack: number[] = [];
  for (const release of releases) {
    if (release.action === 'publish') stack.push(release.version);
    else stack.pop();
  }
  return stack;
}

interface VersionRow {
  version: number;
  config_json: string;
  checksum: string;
}

interface ReleaseRow {
  id: number;
  version: number;
  action: ReleaseAction;
  from_version: number | null;
  created_at: string;
}

interface VersionSummaryRow {
  version: number;
  experiment_id: string;
  release_note: string | null;
  checksum: string;
  created_at: string;
  sessions: number;
}

function prepareStatements(db: Db) {
  return {
    version: db.prepare<[string, number], VersionRow>(
      'SELECT version, config_json, checksum FROM funnel_versions WHERE funnel_id = ? AND version = ?',
    ),
    anyVersion: db.prepare<[string], number>('SELECT 1 FROM funnel_versions WHERE funnel_id = ? LIMIT 1').pluck(),
    insertVersion: db.prepare<[string, number, string, string, string, string | null, string]>(
      `INSERT INTO funnel_versions (funnel_id, version, config_json, checksum, experiment_id, release_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    releases: db.prepare<[string], ReleaseRow>(
      'SELECT id, version, action, from_version, created_at FROM funnel_releases WHERE funnel_id = ? ORDER BY id',
    ),
    insertRelease: db.prepare<[string, number, ReleaseAction, number | null, string]>(
      'INSERT INTO funnel_releases (funnel_id, version, action, from_version, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    summaries: db.prepare<[string], VersionSummaryRow>(
      `SELECT v.version, v.experiment_id, v.release_note, v.checksum, v.created_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.funnel_id = v.funnel_id AND s.funnel_version = v.version) AS sessions
       FROM funnel_versions v WHERE v.funnel_id = ? ORDER BY v.version DESC`,
    ),
  };
}

/** Immutable funnel versions and the publish/rollback log. */
export class VersionService {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly stmt: ReturnType<typeof prepareStatements>;
  // Versions never change once stored, so neither cache needs invalidation.
  private readonly configs = new Map<string, FunnelConfig>();
  private readonly funnels = new Map<string, ResolvedFunnel>();

  constructor(db: Db, now: () => Date) {
    this.db = db;
    this.now = now;
    this.stmt = prepareStatements(db);
  }

  getConfig(funnelId: string, version: number): FunnelConfig | null {
    const key = `${funnelId}@${version}`;
    let config = this.configs.get(key);
    if (!config) {
      const row = this.stmt.version.get(funnelId, version);
      if (!row) return null;
      config = FunnelConfigSchema.parse(JSON.parse(row.config_json));
      this.configs.set(key, config);
    }
    return config;
  }

  /** The stored version resolved for one variant: what a session pinned to them runs. */
  getFunnel(funnelId: string, version: number, variant: string): ResolvedFunnel {
    const key = `${funnelId}@${version}/${variant}`;
    let funnel = this.funnels.get(key);
    if (!funnel) {
      const config = this.getConfig(funnelId, version);
      if (!config) throw new Error(`Version ${version} of funnel "${funnelId}" is not stored`);
      funnel = resolveVariant(config, variant);
      this.funnels.set(key, funnel);
    }
    return funnel;
  }

  getActiveVersion(funnelId: string): number | null {
    return this.stack(funnelId).at(-1) ?? null;
  }

  hasVersions(funnelId: string): boolean {
    return this.stmt.anyVersion.get(funnelId) !== undefined;
  }

  createVersion(funnelId: string, raw: unknown): CreateVersionResponse {
    const { config, errors, warnings } = this.check(funnelId, raw);
    if (!config || errors.length > 0) {
      throw new ApiHttpError(422, 'config_invalid', `The config has ${errors.length} error(s)`, { errors, warnings });
    }
    const checksum = configChecksum(raw);
    return this.db
      .transaction((): CreateVersionResponse => {
        const existing = this.stmt.version.get(funnelId, config.version);
        if (existing) {
          if (existing.checksum !== checksum) {
            throw new ApiHttpError(409, 'version_conflict', `Version ${config.version} already exists with different content`);
          }
          return { version: config.version, created: false, warnings };
        }
        this.stmt.insertVersion.run(
          funnelId,
          config.version,
          JSON.stringify(raw),
          checksum,
          config.experiment.id,
          config.releaseNote ?? null,
          this.now().toISOString(),
        );
        return { version: config.version, created: true, warnings };
      })
      .immediate();
  }

  publish(funnelId: string, version: number): PublishResponse {
    return this.db
      .transaction((): PublishResponse => {
        if (!this.stmt.version.get(funnelId, version)) {
          throw notFound(`Version ${version} of funnel "${funnelId}" does not exist`);
        }
        const active = this.getActiveVersion(funnelId);
        if (active === version) return { activeVersion: version, previousVersion: version };
        this.stmt.insertRelease.run(funnelId, version, 'publish', active, this.now().toISOString());
        return { activeVersion: version, previousVersion: active };
      })
      .immediate();
  }

  rollback(funnelId: string): RollbackResponse {
    return this.db
      .transaction((): RollbackResponse => {
        const stack = this.stack(funnelId);
        const from = stack.at(-1);
        const to = stack.at(-2);
        if (from === undefined || to === undefined) {
          throw new ApiHttpError(409, 'no_previous_version', 'There is no previous version to roll back to');
        }
        this.stmt.insertRelease.run(funnelId, to, 'rollback', from, this.now().toISOString());
        return { activeVersion: to, rolledBackFrom: from };
      })
      .immediate();
  }

  /** Dry run of `createVersion` with a diff against the active version. Stores nothing. */
  validate(funnelId: string, raw: unknown): ValidateConfigResponse {
    const { config, errors, warnings } = this.check(funnelId, raw);
    if (!config) return { ok: false, version: null, errors, warnings, diff: null, versionStatus: null };
    const active = this.getActiveVersion(funnelId);
    const activeConfig = active === null ? null : this.getConfig(funnelId, active);
    const stored = this.stmt.version.get(funnelId, config.version);
    return {
      ok: errors.length === 0,
      version: config.version,
      errors,
      warnings,
      diff: activeConfig ? diffConfigs(activeConfig, config) : null,
      versionStatus: !stored ? 'new' : stored.checksum === configChecksum(raw) ? 'identical' : 'conflict',
    };
  }

  versionConfig(funnelId: string, version: number): VersionConfigResponse {
    const row = this.stmt.version.get(funnelId, version);
    if (!row) throw notFound(`Version ${version} of funnel "${funnelId}" does not exist`);
    return { funnelId, version, config: JSON.parse(row.config_json) as unknown };
  }

  overview(funnelId: string): FunnelAdminResponse {
    const releases = this.stmt.releases.all(funnelId);
    const stack = releaseStack(releases);
    const activeVersion = stack.at(-1) ?? null;
    return {
      funnelId,
      activeVersion,
      rollbackTarget: stack.at(-2) ?? null,
      versions: this.stmt.summaries.all(funnelId).map((row) => ({
        version: row.version,
        experimentId: row.experiment_id,
        releaseNote: row.release_note,
        checksum: row.checksum,
        createdAt: row.created_at,
        isActive: row.version === activeVersion,
        sessions: row.sessions,
        variants: Object.keys(this.getConfig(funnelId, row.version)?.experiment.variants ?? {}),
      })),
      releases: releases.toReversed().map((row) => ({
        id: row.id,
        version: row.version,
        action: row.action,
        fromVersion: row.from_version,
        createdAt: row.created_at,
      })),
    };
  }

  private stack(funnelId: string): number[] {
    return releaseStack(this.stmt.releases.all(funnelId));
  }

  /** `validateConfig` plus the check that the config belongs to the funnel in the URL. */
  private check(funnelId: string, raw: unknown): { config: FunnelConfig | null; errors: ConfigIssue[]; warnings: ConfigIssue[] } {
    const result = validateConfig(raw);
    const errors = [...result.errors];
    if (result.config && result.config.funnelId !== funnelId) {
      errors.push({ path: 'funnelId', message: `The config is for funnel "${result.config.funnelId}", not "${funnelId}"` });
    }
    return { config: result.config, errors, warnings: result.warnings };
  }
}

export interface SeedResult {
  funnelId: string;
  version: number;
  /** false when the funnel already had versions and nothing was changed. */
  seeded: boolean;
}

/** Stores and publishes the config in `path` if its funnel has no versions yet. */
export function seedFromFile(db: Db, path: string, now: () => Date = () => new Date()): SeedResult {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const { config, errors } = validateConfig(raw);
  if (!config || errors.length > 0) {
    throw new Error(`Seed config ${path} is invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }
  const versions = new VersionService(db, now);
  return db
    .transaction((): SeedResult => {
      if (versions.hasVersions(config.funnelId)) return { funnelId: config.funnelId, version: config.version, seeded: false };
      versions.createVersion(config.funnelId, raw);
      versions.publish(config.funnelId, config.version);
      return { funnelId: config.funnelId, version: config.version, seeded: true };
    })
    .immediate();
}
