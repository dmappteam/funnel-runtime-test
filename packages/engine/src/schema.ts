import { z } from 'zod';

export const STEP_TYPES = ['info', 'single-select', 'multi-select', 'number', 'result'] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** Operators the runtime understands. Publishing a config with any other operator is rejected. */
export const OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
] as const;
export type Operator = (typeof OPERATORS)[number];

/** Events the runtime itself emits. Every published config must allow them. */
export const CORE_EVENTS = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
] as const;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** `operator` stays a plain string here so that an unknown operator yields a readable validation error. */
export interface LeafCondition {
  answer: string;
  operator: string;
  value?: unknown;
}
export type Condition = LeafCondition | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema).min(1) }),
    z.object({ any: z.array(ConditionSchema).min(1) }),
    z.object({ not: ConditionSchema }),
    z.object({ answer: z.string().min(1), operator: z.string().min(1), value: z.unknown().optional() }),
  ]),
);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const ContentSchema = z.object({
  eyebrow: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  helperText: z.string().optional(),
  primaryActionLabel: z.string().optional(),
  loadingTitle: z.string().optional(),
  errorTitle: z.string().optional(),
  retryLabel: z.string().optional(),
});

/** Limits match the wire schemas in @funnel/contracts: a config that passes validation must fit the API. */
const ID_MAX = 64;
const idSchema = z.string().min(1).max(ID_MAX);

const OptionSchema = z.object({ value: z.string().min(1).max(200), label: z.string().min(1) });
const MessagesSchema = z.record(z.string(), z.string());

const baseStep = {
  id: idSchema,
  content: ContentSchema.default({}),
  visibleWhen: ConditionSchema.optional(),
};

export const InfoStepSchema = z.object({ ...baseStep, type: z.literal('info') });

export const SingleSelectStepSchema = z.object({
  ...baseStep,
  type: z.literal('single-select'),
  input: z.object({ name: idSchema, options: z.array(OptionSchema).min(1) }),
  validation: z
    .object({ required: z.boolean().default(true), messages: MessagesSchema.default({}) })
    .default({ required: true, messages: {} }),
});

export const MultiSelectStepSchema = z.object({
  ...baseStep,
  type: z.literal('multi-select'),
  input: z.object({ name: idSchema, options: z.array(OptionSchema).min(1) }),
  validation: z
    .object({
      required: z.boolean().default(true),
      minSelections: z.number().int().min(0).optional(),
      maxSelections: z.number().int().min(1).optional(),
      messages: MessagesSchema.default({}),
    })
    .default({ required: true, messages: {} }),
});

export const NumberStepSchema = z.object({
  ...baseStep,
  type: z.literal('number'),
  input: z.object({
    name: idSchema,
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    unit: z.string().optional(),
  }),
  validation: z
    .object({ required: z.boolean().default(true), messages: MessagesSchema.default({}) })
    .default({ required: true, messages: {} }),
});

export const ResultStepSchema = z.object({
  ...baseStep,
  type: z.literal('result'),
  resultSource: z.string().default('resultRules'),
});

export const StepSchema = z.discriminatedUnion('type', [
  InfoStepSchema,
  SingleSelectStepSchema,
  MultiSelectStepSchema,
  NumberStepSchema,
  ResultStepSchema,
]);

export type Step = z.infer<typeof StepSchema>;
export type InfoStep = z.infer<typeof InfoStepSchema>;
export type SingleSelectStep = z.infer<typeof SingleSelectStepSchema>;
export type MultiSelectStep = z.infer<typeof MultiSelectStepSchema>;
export type NumberStep = z.infer<typeof NumberStepSchema>;
export type ResultStep = z.infer<typeof ResultStepSchema>;
/** Steps that collect an answer. */
export type InputStep = SingleSelectStep | MultiSelectStep | NumberStep;

export function hasInput(step: Step): step is InputStep {
  return step.type === 'single-select' || step.type === 'multi-select' || step.type === 'number';
}

// ---------------------------------------------------------------------------
// Results, experiment, events
// ---------------------------------------------------------------------------

export const ResultSchema = z.object({
  id: idSchema,
  title: z.string(),
  summary: z.string().default(''),
  recommendations: z.array(z.string()).default([]),
  cta: z.object({ label: z.string().min(1), action: idSchema }),
});
export type ResultDef = z.infer<typeof ResultSchema>;

const OverrideMapSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

export const VariantSchema = z.object({
  weight: z.number().min(0),
  stepSequence: z.array(idSchema).min(1),
  stepOverrides: OverrideMapSchema.default({}),
  resultOverrides: OverrideMapSchema.default({}),
});
export type VariantDef = z.infer<typeof VariantSchema>;

export const ExperimentSchema = z.object({
  id: z.string().min(1).max(128),
  assignment: z.string().default('server'),
  sticky: z.boolean().default(true),
  overrideQueryParam: z.string().min(1).default('variant'),
  variants: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,16}$/), VariantSchema),
});

export const EventDefSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  trigger: z.string().default(''),
  properties: z.array(z.string().min(1)).default([]),
});
export type EventDef = z.infer<typeof EventDefSchema>;

export const EventsConfigSchema = z.object({
  baseProperties: z.array(z.string()).default([]),
  allowed: z.array(EventDefSchema).min(1),
  privacy: z
    .object({ storeRawAnswers: z.boolean().default(false), allowAnswerKinds: z.boolean().default(true) })
    .default({ storeRawAnswers: false, allowAnswerKinds: true }),
});

export const ResultRuleSchema = z.object({ resultId: idSchema, when: ConditionSchema });

// ---------------------------------------------------------------------------
// Funnel config
// ---------------------------------------------------------------------------

export const FunnelConfigSchema = z.object({
  schemaVersion: z.string().min(1),
  funnelId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  version: z.number().int().positive(),
  status: z.string().optional(),
  locale: z.string().default('en'),
  title: z.string(),
  description: z.string().optional(),
  releaseNote: z.string().optional(),
  session: z
    .object({
      // Capped at a year: expiry dates must stay valid ISO timestamps.
      ttlHours: z.number().positive().max(24 * 365).default(72),
      persistAnswers: z.boolean().default(true),
      pinVersion: z.boolean().default(true),
      pinExperimentVariant: z.boolean().default(true),
    })
    .default({ ttlHours: 72, persistAnswers: true, pinVersion: true, pinExperimentVariant: true }),
  progress: z
    .object({
      countVisibleOnly: z.boolean().default(true),
      excludeTypes: z.array(z.enum(STEP_TYPES)).default(['info', 'result']),
    })
    .default({ countVisibleOnly: true, excludeTypes: ['info', 'result'] }),
  experiment: ExperimentSchema,
  steps: z.record(z.string(), StepSchema),
  resultRules: z.array(ResultRuleSchema).default([]),
  defaultResultId: idSchema,
  results: z.record(z.string(), ResultSchema),
  events: EventsConfigSchema,
});
export type FunnelConfig = z.infer<typeof FunnelConfigSchema>;

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

/** `null` marks an optional question the user explicitly skipped. */
export type AnswerValue = string | number | string[] | null;
export type Answers = Record<string, AnswerValue>;

export const AnswerValueSchema: z.ZodType<AnswerValue> = z.union([
  z.string().max(200),
  z.number().finite(),
  z.array(z.string().max(200)).max(50),
  z.null(),
]);

/** A funnel version resolved for one experiment variant: what a session actually runs. */
export interface ResolvedFunnel {
  funnelId: string;
  version: number;
  experimentId: string;
  variant: string;
  locale: string;
  title: string;
  /** Step ids in the order of this variant. */
  sequence: string[];
  /** Only the steps of `sequence`, with variant overrides applied. */
  steps: Record<string, Step>;
  progress: FunnelConfig['progress'];
  resultRules: FunnelConfig['resultRules'];
  defaultResultId: string;
  /** All results, with variant overrides applied. */
  results: Record<string, ResultDef>;
  events: FunnelConfig['events'];
  session: FunnelConfig['session'];
}
