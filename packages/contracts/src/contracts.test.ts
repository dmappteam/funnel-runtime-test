import { describe, expect, it } from 'vitest';
import { resolveVariant } from '@funnel/engine';
import { loadConfig } from '@funnel/engine/testing';
import {
  AnalyticsQuerySchema,
  ClientEventSchema,
  CreateSessionRequestSchema,
  answerSubmitted,
  finalizeEvent,
  recommendationExpanded,
  resultStepId,
  stepViewed,
} from './index';

const ctx = (version: 1 | 3) => ({
  sessionId: '0b7f6c1e-8a4d-4c52-9a8e-3f1d2c4b5a69',
  funnel: resolveVariant(loadConfig(version), 'B'),
  utm: { source: 'google', medium: 'cpc', campaign: 'brand' },
});

describe('request schemas', () => {
  it('never blocks session creation because of a malformed UTM link', () => {
    const parsed = CreateSessionRequestSchema.parse({ utm: { source: '', medium: '  cpc ', campaign: 'x'.repeat(500) } });
    expect(parsed.utm).toEqual({ medium: 'cpc', campaign: 'x'.repeat(200) });
    expect(CreateSessionRequestSchema.parse({}).utm).toEqual({});
  });

  it('treats empty analytics query parameters as not set', () => {
    expect(AnalyticsQuerySchema.parse({ version: '', campaign: '', includeOverrides: 'true' })).toEqual({
      includeOverrides: true,
    });
    expect(AnalyticsQuerySchema.parse({ version: '2' })).toEqual({ version: 2, includeOverrides: false });
    expect(AnalyticsQuerySchema.parse({ includeOverrides: '' })).toEqual({ includeOverrides: false });
  });
});

describe('event builders', () => {
  it('drops an event the pinned version does not allow', () => {
    const v1 = ctx(1);
    const v3 = ctx(3);
    const draft = recommendationExpanded(resultStepId(v3.funnel), 'balanced', 'expand_recommendation');
    expect(finalizeEvent(draft, v1, 'evt-00000001', new Date().toISOString())).toBeNull();
    expect(finalizeEvent(draft, v3, 'evt-00000001', new Date().toISOString())).toMatchObject({
      name: 'recommendation_expanded',
      funnel_version: 3,
      variant: 'B',
      properties: { result_id: 'balanced', action: 'expand_recommendation', source: 'cta' },
    });
  });

  it('keeps only whitelisted properties and never the answer value', () => {
    const c = ctx(3);
    const draft = answerSubmitted(c.funnel, 'work_mode');
    draft.properties.answer = 'remote';
    const event = finalizeEvent(draft, c, 'evt-00000002', new Date().toISOString());
    expect(event?.properties).toEqual({ answer_kind: 'single_select' });
  });

  it('reports progress on step_viewed and produces a valid wire event', () => {
    const c = ctx(3);
    const draft = stepViewed(c.funnel, { work_mode: 'remote' }, 'meeting_hours');
    expect(draft.properties).toEqual({ step_type: 'number', visible_step_index: 2, visible_step_count: 7 });
    const event = finalizeEvent(draft, c, 'a3c1f1f2-1b9e-4f53-8f7c-1d2e3f4a5b6c', '2026-10-08T10:00:00.000Z');
    expect(ClientEventSchema.safeParse(event).success).toBe(true);
  });
});
