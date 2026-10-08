// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FunnelAdminResponse, ReleaseEntry, VersionSummary } from '@funnel/contracts';
import { FunnelConfigSchema, diffConfigs, validateConfig } from '@funnel/engine';
import v1 from '../../../../configs/funnel-v1.json';
import v3 from '../../../../configs/funnel-v3.json';
import { AdminPage } from './AdminPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Admin API with the server's semantics for the calls the page makes. */
function fakeAdminApi() {
  const stored = new Map<number, unknown>([[1, v1]]);
  const releases: ReleaseEntry[] = [{ id: 1, version: 1, action: 'publish', fromVersion: null, createdAt: '2026-10-08T10:00:00.000Z' }];
  const active = () => releases.reduce<number[]>((stack, r) => (r.action === 'publish' ? [...stack, r.version] : stack.slice(0, -1)), []);

  const overview = (): FunnelAdminResponse => {
    const stack = active();
    const versions: VersionSummary[] = [...stored.keys()]
      .sort((a, b) => b - a)
      .map((version) => ({
        version,
        experimentId: `experiment-v${version}`,
        releaseNote: (stored.get(version) as { releaseNote?: string }).releaseNote ?? null,
        checksum: String(version),
        createdAt: '2026-10-08T10:00:00.000Z',
        isActive: version === stack.at(-1),
        sessions: version * 10,
      }));
    return { funnelId: 'workstyle-planner', activeVersion: stack.at(-1) ?? null, rollbackTarget: stack.at(-2) ?? null, versions, releases: releases.toReversed() };
  };

  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace('/api/admin/funnels/workstyle-planner', '');
    const raw: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method === 'GET' && path === '') return reply(200, overview());
    const version = /^\/versions\/(\d+)$/.exec(path);
    if (method === 'GET' && version) return reply(200, { funnelId: 'workstyle-planner', version: Number(version[1]), config: stored.get(Number(version[1])) });
    if (path === '/validate') {
      const result = validateConfig(raw);
      const activeConfig = FunnelConfigSchema.parse(stored.get(active().at(-1)!));
      return reply(200, {
        ok: result.ok,
        version: result.config?.version ?? null,
        errors: result.errors,
        warnings: result.warnings,
        diff: result.config ? diffConfigs(activeConfig, result.config) : null,
        versionStatus: result.config ? (stored.has(result.config.version) ? 'identical' : 'new') : null,
      });
    }
    if (path === '/versions') {
      const n = (raw as { version: number }).version;
      const created = !stored.has(n);
      stored.set(n, raw);
      return reply(created ? 201 : 200, { version: n, created, warnings: [] });
    }
    if (path === '/publish') {
      const n = (raw as { version: number }).version;
      const previousVersion = active().at(-1) ?? null;
      releases.push({ id: releases.length + 1, version: n, action: 'publish', fromVersion: previousVersion, createdAt: '2026-10-08T11:00:00.000Z' });
      return reply(200, { activeVersion: n, previousVersion });
    }
    if (path === '/rollback') {
      const stack = active();
      releases.push({ id: releases.length + 1, version: stack.at(-2)!, action: 'rollback', fromVersion: stack.at(-1)!, createdAt: '2026-10-08T12:00:00.000Z' });
      return reply(200, { activeVersion: stack.at(-2), rolledBackFrom: stack.at(-1) });
    }
    return reply(404, { error: 'not_found', message: path });
  });
  return { fetch };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (ms = 0) => act(async () => sleep(ms));
const text = () => document.body.textContent ?? '';
const validated = () => document.querySelector('.adm-report .badge-success')?.textContent === 'Valid';

async function waitFor(check: () => boolean, what: string) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 3000) throw new Error(`Timed out waiting for ${what}`);
    await settle(10);
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

const click = (el: Element) => act(async () => (el as HTMLElement).click());

async function paste(value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>('#adm-config')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

let root: Root | null = null;

beforeEach(async () => {
  // jsdom has no modal dialogs: enough of the API for the confirmation.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  vi.stubGlobal('fetch', fakeAdminApi().fetch);
  window.history.replaceState(null, '', '/admin');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<AdminPage />));
  await waitFor(() => text().includes('Active v1'), 'the overview');
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('admin page', () => {
  it('shows the active version, its config and preview links per variant', async () => {
    expect(button('Roll back').disabled).toBe(true);
    const previews = [...document.querySelectorAll<HTMLAnchorElement>('.adm-preview a')].map((a) => a.getAttribute('href'));
    expect(previews).toEqual(['/?variant=A&reset=1', '/?variant=B&reset=1']);

    await click(button('View JSON'));
    await waitFor(() => document.querySelector('.adm-json pre') !== null, 'the config');
    expect(document.querySelector('.adm-json pre')!.textContent).toContain('"funnelId": "workstyle-planner"');
  });

  it('validates a pasted config, shows the diff, then saves and publishes it after confirmation', async () => {
    await paste('{ "version": ');
    await click(button('Validate'));
    expect(text()).toContain('Invalid JSON');

    await paste(JSON.stringify({ ...v3, defaultResultId: 'missing' }));
    await click(button('Validate'));
    await waitFor(() => text().includes('1 error'), 'the error report');
    expect(document.querySelector('.adm-issues--error')!.textContent).toContain('Unknown result "missing"');
    expect(button('Save and publish').disabled).toBe(true);

    await paste(JSON.stringify(v3, null, 2));
    await click(button('Validate'));
    await waitFor(validated, 'the validation');
    const chips = [...document.querySelectorAll('.adm-chip--add')].map((c) => c.textContent);
    expect(chips).toEqual(expect.arrayContaining(['+ security_constraints', '+ recommendation_expanded', '+ contains', '+ gte']));

    await click(button('Save and publish'));
    expect(document.querySelector('dialog[open]')!.textContent).toContain('Save and publish v3?');
    await click(button('Publish v3'));
    await waitFor(() => text().includes('v3 is now active.'), 'the success message');
    await waitFor(() => text().includes('Active v3'), 'the refreshed overview');
    expect(button('Roll back to v1').disabled).toBe(false);
    expect(document.querySelector('.adm-log li')!.textContent).toContain('v1 → v3');
  });

  it('rolls back after confirmation and can be cancelled', async () => {
    await paste(JSON.stringify(v3));
    await click(button('Validate'));
    await waitFor(validated, 'the validation');
    await click(button('Save and publish'));
    await click(button('Publish v3'));
    await waitFor(() => text().includes('Active v3'), 'v3 active');

    await click(button('Roll back to v1'));
    await click(button('Cancel'));
    expect(text()).toContain('Active v3');

    await click(button('Roll back to v1'));
    await click(document.querySelector('dialog .btn-danger')!);
    await waitFor(() => text().includes('Rolled back from v3 to v1.'), 'the rollback message');
    await waitFor(() => text().includes('Active v1'), 'v1 active again');
  });
});
