import type {
  CreateVersionResponse,
  FunnelAdminResponse,
  PublishResponse,
  RollbackResponse,
  ValidateConfigResponse,
  VersionConfigResponse,
} from '@funnel/contracts';
import { http } from './http';

export const DEFAULT_FUNNEL_ID = 'workstyle-planner';

/** `?funnel=` overrides the default funnel. */
export function funnelIdFromUrl(search: string = window.location.search): string {
  return new URLSearchParams(search).get('funnel')?.trim() || DEFAULT_FUNNEL_ID;
}

const funnelUrl = (funnelId: string) => `/api/admin/funnels/${encodeURIComponent(funnelId)}`;

/** Sends the config text unchanged, so the stored version is byte-for-byte what was uploaded. */
const rawJson = (text: string): RequestInit => ({ body: text, headers: { 'content-type': 'application/json' } });

export function getFunnelAdmin(funnelId: string): Promise<FunnelAdminResponse> {
  return http<FunnelAdminResponse>('GET', funnelUrl(funnelId));
}

export function getVersionConfig(funnelId: string, version: number): Promise<VersionConfigResponse> {
  return http<VersionConfigResponse>('GET', `${funnelUrl(funnelId)}/versions/${version}`);
}

export function validateConfigText(funnelId: string, text: string): Promise<ValidateConfigResponse> {
  return http<ValidateConfigResponse>('POST', `${funnelUrl(funnelId)}/validate`, undefined, rawJson(text));
}

/** 201 created, 200 identical config already stored; 409 `version_conflict` and 422 `config_invalid` throw. */
export function createVersion(funnelId: string, text: string): Promise<CreateVersionResponse> {
  return http<CreateVersionResponse>('POST', `${funnelUrl(funnelId)}/versions`, undefined, rawJson(text));
}

export function publishVersion(funnelId: string, version: number): Promise<PublishResponse> {
  return http<PublishResponse>('POST', `${funnelUrl(funnelId)}/publish`, { version });
}

export function rollbackVersion(funnelId: string): Promise<RollbackResponse> {
  return http<RollbackResponse>('POST', `${funnelUrl(funnelId)}/rollback`);
}
