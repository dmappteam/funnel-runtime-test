// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsResponse, GroupReport, KpiSet, Rate, StepMetrics } from '@funnel/contracts';
import type { StepType } from '@funnel/engine';
import { DashboardPage } from './DashboardPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rate = (numerator: number, denominator: number): Rate => {
  const value = denominator > 0 ? numerator / denominator : null;
  return {
    numerator,
    denominator,
    value,
    ciLow: value === null ? null : Math.max(0, value - 0.05),
    ciHigh: value === null ? null : Math.min(1, value + 0.05),
  };
};

const kpi = (started: number, reachedResult: number, ctaClicked: number): KpiSet => ({
  started,
  reachedResult,
  ctaClicked,
  resultRate: rate(reachedResult, started),
  ctr: rate(ctaClicked, reachedResult),
  ctaConversion: rate(ctaClicked, started),
  backRate: rate(0, started),
});

const step = (
  stepId: string,
  position: number,
  type: StepType,
  [reached, advanced, dropoff]: [number, number, number],
  started: number,
  conditional = false,
): StepMetrics => ({
  stepId,
  position,
  type,
  conditional,
  reached,
  advanced,
  conversion: advanced / reached,
  dropoff,
  dropoffRate: dropoff / reached,
  reachedFromStart: reached / started,
});

// 200 sessions per variant; work_mode loses the most sessions in both.
const group = (variant: string, result: number, cta: number, workMode: [number, number, number]): GroupReport => ({
  version: 3,
  experimentId: 'question-order-and-result-framing-v3',
  variant,
  kpi: kpi(200, result, cta),
  steps: [
    step('intro', 0, 'info', [200, workMode[0], 200 - workMode[0]], 200),
    step('work_mode', 1, 'single-select', workMode, 200),
    step('security_constraints', 2, 'single-select', [40, 36, 4], 200, true),
    step('result', 3, 'result', [result, 0, 0], 200),
  ],
  results: [
    { resultId: 'balanced', sessions: result - 40 },
    { resultId: 'regulated_scale', sessions: 40 },
  ],
  events: [
    { name: 'session_started', sessions: 200, events: 200 },
    { name: 'step_viewed', sessions: 200, events: 900 },
    { name: 'result_viewed', sessions: result, events: result },
    { name: 'cta_clicked', sessions: cta, events: cta },
    { name: 'recommendation_expanded', sessions: cta, events: cta },
  ],
});

const REPORT: AnalyticsResponse = {
  generatedAt: '2026-10-08T12:00:00.000Z',
  filters: { funnelId: 'workstyle-planner', version: null, campaign: null, includeOverrides: false },
  available: { versions: [2, 3], campaigns: ['spring', '(none)'] },
  totals: { events: 5000, sessions: 550, overrideSessions: 7 },
  versions: [2, 3].map((version) => ({
    version,
    experimentId: `question-order-and-result-framing-v${version}`,
    variants: ['A', 'B'],
    kpi: kpi(version === 2 ? 150 : 400, 200, 90),
    firstSeen: '2026-10-01T09:00:00.000Z',
    lastSeen: '2026-10-08T11:00:00.000Z',
  })),
  groups: [group('A', 100, 30, [180, 104, 76]), group('B', 130, 60, [190, 134, 56])],
  ab: [
    {
      version: 3,
      experimentId: 'question-order-and-result-framing-v3',
      control: 'A',
      treatment: 'B',
      primary: {
        metric: 'ctaConversion',
        control: rate(30, 200),
        treatment: rate(60, 200),
        absDiff: 0.15,
        diffCiLow: 0.07,
        diffCiHigh: 0.23,
        relativeLift: 1,
        pValue: 0.0003,
        significant: true,
      },
      secondary: [
        { metric: 'resultRate', control: rate(100, 200), treatment: rate(130, 200), absDiff: 0.15, diffCiLow: 0.05, diffCiHigh: 0.25, relativeLift: 0.3, pValue: 0.002, significant: true },
        { metric: 'ctr', control: rate(30, 100), treatment: rate(60, 130), absDiff: 0.16, diffCiLow: 0.04, diffCiHigh: 0.28, relativeLift: 0.54, pValue: 0.01, significant: true },
      ],
      requiredSessionsPerVariant: 121,
    },
  ],
  ingestion: { rejected: 3, rejectedByReason: { unknown_step: 2, invalid_payload: 1 } },
};

const EMPTY: AnalyticsResponse = {
  ...REPORT,
  available: { versions: [], campaigns: [] },
  totals: { events: 0, sessions: 0, overrideSessions: 0 },
  versions: [],
  groups: [],
  ab: [],
  ingestion: { rejected: 0, rejectedByReason: {} },
};

const fetchMock = vi.fn();
const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValue({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const requestedUrls = () => fetchMock.mock.calls.map(([url]) => url as string);

let container: HTMLDivElement;
let root: Root;

/** Lets the mocked fetch resolve, then applies the resulting React updates. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(search = '') {
  window.history.replaceState(null, '', `/dashboard${search}`);
  await act(async () => root.render(<DashboardPage />));
  await settle();
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('DashboardPage', () => {
  it('renders every section for the latest version by default', async () => {
    respond(200, REPORT);
    await renderPage();
    const text = container.textContent ?? '';

    expect(requestedUrls()).toEqual(['/api/analytics?funnelId=workstyle-planner']);
    expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe('3');
    expect(text).toContain('A/B test · v3');
    expect(text).toContain('Hypothesis: changing the question order and result framing in B raises CTA conversion over A');
    expect(text).toMatch(/\+15[.,]0 p\.p\./);
    expect(text).toContain('Significant');
    expect(text).toMatch(/≈121 sessions per variant needed/);
    // Worst step per variant, and the conditional step is marked.
    const worst = [...container.querySelectorAll('tr.dash-worst')].map((row) => row.querySelector('.mono')?.textContent);
    expect(worst).toEqual(['work_mode', 'work_mode']);
    expect(text).toContain('conditional');
    expect(text).toContain('regulated_scale');
    expect(text).toContain('recommendation_expanded');
    expect(text).toContain('not a controlled comparison');
    expect(text).toContain("Step not in the session's variant");
    expect(text).toContain('excluded from the numbers');
  });

  it('reads the filters from the page URL and passes them to the API', async () => {
    respond(200, REPORT);
    await renderPage('?version=2&campaign=spring&includeOverrides=true');
    expect(requestedUrls()).toEqual([
      '/api/analytics?funnelId=workstyle-planner&version=2&campaign=spring&includeOverrides=true',
    ]);
  });

  it('writes a changed filter to the URL and refetches', async () => {
    respond(200, REPORT);
    await renderPage();
    const campaign = container.querySelectorAll('select')[1]!;
    await act(async () => {
      campaign.value = '(none)';
      campaign.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(window.location.search).toBe('?campaign=%28none%29');
    expect(requestedUrls()[1]).toBe('/api/analytics?funnelId=workstyle-planner&campaign=%28none%29');
  });

  it('labels the data quality totals as all versions, since the version filter does not apply to them', async () => {
    respond(200, { ...REPORT, filters: { ...REPORT.filters, version: 2 } });
    await renderPage('?version=2');
    const quality = container.querySelector('section[aria-labelledby="dash-quality"]')!;
    expect([...quality.querySelectorAll('.dash-tile-detail')].map((el) => el.textContent)).toEqual([
      'unique event ids, all versions, current campaign',
      'all versions, current campaign',
      'all versions, current campaign, excluded from the numbers',
      'refused at ingestion',
    ]);
  });

  it('asks to sign in on 401', async () => {
    respond(401, { error: 'unauthorized', message: 'Authentication required' });
    await renderPage();
    expect(container.textContent).toContain('Sign in required');
  });

  it('suggests generating traffic when there are no events', async () => {
    respond(200, EMPTY);
    await renderPage();
    expect(container.textContent).toContain('No events yet');
    expect(container.textContent).toContain('npm run generate');
  });
});
