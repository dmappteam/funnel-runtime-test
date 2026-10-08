import {
  computePath,
  hasInput,
  validateAnswer,
  type AnswerValue,
  type Answers,
  type InputStep,
  type ResolvedFunnel,
  type StepType,
} from '@funnel/engine';
import type { UtmInput } from '@funnel/contracts';
import type { Rng } from './random';

export interface UtmProfile {
  name: string;
  weight: number;
  utm: UtmInput;
  /** Multiplies every leave probability: brand searchers are more motivated than cold social traffic. */
  leaveFactor: number;
}

export const UTM_PROFILES: readonly UtmProfile[] = [
  {
    name: 'google_brand',
    weight: 30,
    leaveFactor: 0.8,
    utm: { source: 'google', medium: 'cpc', campaign: 'brand_search', term: 'team operating model' },
  },
  {
    name: 'linkedin_hr',
    weight: 22,
    leaveFactor: 1,
    utm: { source: 'linkedin', medium: 'paid_social', campaign: 'hr_leaders', content: 'carousel' },
  },
  { name: 'facebook_remote', weight: 18, leaveFactor: 1.3, utm: { source: 'facebook', medium: 'paid_social', campaign: 'remote_teams' } },
  { name: 'newsletter', weight: 12, leaveFactor: 0.7, utm: { source: 'newsletter', medium: 'email', campaign: 'october_digest' } },
  { name: 'direct', weight: 18, leaveFactor: 1.1, utm: {} },
];

export const BEHAVIOUR = {
  /** QA traffic that forces a variant (`?variant=`). Excluded from the A/B comparison. */
  overrideShare: 0.05,
  /** Planned above the target (about 12%): users who leave before the planned moment never go back. */
  backShare: 0.165,
  /** Of the sessions that go back: return to work_mode right after answering it and switch the mode. */
  branchBackShare: 0.4,
  /** Planned above the target (about 10%) for the same reason. */
  refreshShare: 0.12,
  /** Chance to PUT the session state after a forward move, like a browser saving now and then. */
  saveStateChance: 0.5,
  /** Chance of a rejected input before the valid answer. Validation errors emit no events. */
  invalidFirst: { number: 0.08, 'multi-select': 0.05, 'single-select': 0.02 } as Record<string, number>,
  leave: { info: 0.07, 'single-select': 0.035, 'multi-select': 0.05, number: 0.06, result: 0 } as Record<StepType, number>,
  /** Variant A opens with a number question (team size); more users give up there than on B's first number question. */
  firstNumberExtraLeave: { A: 0.08 } as Record<string, number>,
  /** B frames the result CTA more concretely. */
  ctaClick: { A: 0.45, B: 0.53 } as Record<string, number>,
  ctaClickDefault: 0.48,
} as const;

export const WORK_MODES = ['remote', 'hybrid', 'office'] as const;
const BASE_PRIORITIES = ['speed', 'focus', 'culture', 'cost', 'onboarding'] as const;

/** What one simulated user would answer. Drawn up front, independent of version and variant. */
export interface Persona {
  workMode: string;
  timezoneSpan: string;
  asyncMaturity: string;
  teamSize: number;
  meetingHours: number;
  /** Uniform draw in [0, 1), turned into office days by the work mode given at answer time. */
  officeDaysDraw: number;
  /** One to three priorities, compliance excluded. */
  priorities: string[];
  /** Picks compliance whenever the version offers it. */
  wantsCompliance: boolean;
  securityConstraints: string;
  toolCount: number;
}

export function drawPersona(rng: Rng): Persona {
  const teamBucket = rng.weighted([['small', 35], ['mid', 45], ['large', 20]] as const);
  return {
    workMode: rng.weighted([['remote', 4], ['hybrid', 4], ['office', 2]] as const),
    timezoneSpan: rng.weighted([['same', 45], ['wide', 35], ['global', 20]] as const),
    asyncMaturity: rng.weighted([['low', 35], ['medium', 40], ['high', 25]] as const),
    teamSize: teamBucket === 'small' ? rng.int(2, 9) : teamBucket === 'mid' ? rng.int(10, 49) : rng.int(50, 200),
    meetingHours: rng.chance(0.3) ? rng.int(15, 32) : rng.int(1, 14),
    officeDaysDraw: rng.next(),
    priorities: rng.shuffle(BASE_PRIORITIES).slice(0, rng.weighted([[1, 35], [2, 40], [3, 25]] as const)),
    wantsCompliance: rng.chance(0.25),
    securityConstraints: rng.weighted([['standard', 30], ['strict', 35], ['regulated', 35]] as const),
    toolCount: rng.chance(0.15) ? rng.int(16, 28) : rng.int(3, 15),
  };
}

/** The persona's answer to a question, adapted to the options of this version. Unknown questions get a generic valid answer. */
export function answerFor(step: InputStep, persona: Persona, answers: Answers): AnswerValue {
  const value = personaValue(step, persona, answers);
  return value !== undefined && validateAnswer(step, value).ok ? value : genericAnswer(step);
}

function personaValue(step: InputStep, persona: Persona, answers: Answers): AnswerValue | undefined {
  switch (step.input.name) {
    case 'work_mode':
      return persona.workMode;
    case 'timezone_span':
      return persona.timezoneSpan;
    case 'async_maturity':
      return persona.asyncMaturity;
    case 'security_constraints':
      return persona.securityConstraints;
    case 'team_size':
      return persona.teamSize;
    case 'meeting_hours':
      return persona.meetingHours;
    case 'tool_count':
      return persona.toolCount;
    case 'office_days':
      return officeDays(answers.work_mode, persona.officeDaysDraw);
    case 'priorities':
      return step.type === 'multi-select' ? priorities(persona, step.input.options.map((o) => o.value)) : undefined;
    default:
      return undefined;
  }
}

function officeDays(workMode: AnswerValue | undefined, draw: number): number {
  if (workMode === 'hybrid') return 1 + Math.floor(draw * 3);
  if (workMode === 'office') return 3 + Math.floor(draw * 3);
  return Math.floor(draw * 2);
}

function priorities(persona: Persona, options: string[]): string[] {
  const picked = persona.priorities.filter((p) => options.includes(p));
  if (persona.wantsCompliance && options.includes('compliance')) {
    if (picked.length >= 3) picked.pop();
    picked.push('compliance');
  }
  return picked;
}

function genericAnswer(step: InputStep): AnswerValue {
  if (step.type === 'number') return step.input.min ?? 0;
  const first = step.input.options[0]!.value;
  return step.type === 'single-select' ? first : [first];
}

/** Every answer the persona would give on this funnel, following its branches. Answers of hidden steps are ignored by the engine. */
export function personaAnswers(funnel: ResolvedFunnel, persona: Persona): Answers {
  const answers: Answers = {};
  for (const id of funnel.sequence) {
    const step = funnel.steps[id];
    if (step && hasInput(step)) answers[step.input.name] = answerFor(step, persona, answers);
  }
  return answers;
}

/** A question in the middle of the persona's path (never the first one), for a planned pause. */
export function midFunnelStep(funnel: ResolvedFunnel, persona: Persona, rng: Rng): string | null {
  const questions = computePath(funnel, personaAnswers(funnel, persona)).entries
    .map((e) => e.stepId)
    .filter((id) => {
      const step = funnel.steps[id];
      return step !== undefined && hasInput(step);
    });
  return questions.length > 1 ? rng.pick(questions.slice(1)) : null;
}

/** A value the user enters before correcting it, e.g. 0 or 500 people. `undefined` if the step has no such value. */
export function invalidAttempt(step: InputStep, rng: Rng): unknown {
  let candidates: unknown[];
  if (step.type === 'number') {
    const { min, max } = step.input;
    candidates = [min === undefined ? undefined : min - 1, max === undefined ? undefined : Math.round(max * 2.5)];
  } else if (step.type === 'multi-select') {
    const all = step.input.options.map((o) => o.value);
    candidates = [[], all];
  } else {
    candidates = [''];
  }
  const invalid = candidates.filter((v) => v !== undefined && !validateAnswer(step, v).ok);
  return invalid.length > 0 ? rng.pick(invalid) : undefined;
}

/** Probability of leaving on a step that was just shown. */
export function leaveChance(funnel: ResolvedFunnel, stepId: string, factor: number): number {
  const step = funnel.steps[stepId];
  if (!step) return 0;
  const firstNumber = funnel.sequence.find((id) => funnel.steps[id]?.type === 'number');
  const extra = stepId === firstNumber ? (BEHAVIOUR.firstNumberExtraLeave[funnel.variant] ?? 0) : 0;
  return Math.min(0.9, (BEHAVIOUR.leave[step.type] + extra) * factor);
}

export function ctaChance(variant: string): number {
  return BEHAVIOUR.ctaClick[variant] ?? BEHAVIOUR.ctaClickDefault;
}

export type BackPlan =
  /** Right after answering work_mode, go back to it and switch the mode, so office_days appears or disappears. */
  | { kind: 'branch' }
  /** After `atMove` forward moves, go back 1–2 steps to review, then continue with the same answers. */
  | { kind: 'review'; atMove: number; steps: 1 | 2 };

export interface SessionPlan {
  profile: UtmProfile;
  variantOverride: string | null;
  persona: Persona;
  back: BackPlan | null;
  /** Forward move after which the page is reloaded. */
  refreshAtMove: number | null;
  /** Scripted exit: the step to leave on, `null` to never leave early. Random when undefined. */
  leaveAt?: string | null;
  /** Scripted CTA decision. Random when undefined. */
  cta?: boolean;
}

export function drawPlan(rng: Rng): SessionPlan {
  const profile = rng.weighted(UTM_PROFILES.map((p) => [p, p.weight] as const));
  const variantOverride = rng.chance(BEHAVIOUR.overrideShare) ? rng.pick(['A', 'B']) : null;
  const persona = drawPersona(rng);
  let back: BackPlan | null = null;
  if (rng.chance(BEHAVIOUR.backShare)) {
    back = rng.chance(BEHAVIOUR.branchBackShare)
      ? { kind: 'branch' }
      : { kind: 'review', atMove: rng.int(2, 5), steps: rng.chance(0.5) ? 1 : 2 };
  }
  const refreshAtMove = rng.chance(BEHAVIOUR.refreshShare) ? rng.int(0, 6) : null;
  return { profile, variantOverride, persona, back, refreshAtMove };
}
