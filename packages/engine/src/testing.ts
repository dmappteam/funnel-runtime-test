import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FunnelConfigSchema, type FunnelConfig } from './schema';

/** Absolute path of a file in the repository's `configs/` directory. Test-only helper. */
export function configPath(file: string): string {
  return fileURLToPath(new URL(`../../../configs/${file}`, import.meta.url));
}

export function readRawConfig(version: 1 | 2 | 3): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(`funnel-v${version}.json`), 'utf8')) as Record<string, unknown>;
}

export function loadConfig(version: 1 | 2 | 3): FunnelConfig {
  return FunnelConfigSchema.parse(readRawConfig(version));
}
