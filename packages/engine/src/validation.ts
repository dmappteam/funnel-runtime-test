import type { AnswerValue, InputStep, MultiSelectStep, NumberStep, SingleSelectStep } from './schema';

export type ValidationCode =
  | 'required'
  | 'invalid'
  | 'invalid_option'
  | 'min'
  | 'max'
  | 'step'
  | 'minSelections'
  | 'maxSelections';

/** On success `value` is the normalized answer (numbers parsed, multi-select in option order, `null` for a skipped optional question). */
export type AnswerCheck = { ok: true; value: AnswerValue } | { ok: false; code: ValidationCode; message: string };

/** Kind of answer for analytics. Raw answers never leave the session state. */
export type AnswerKind = 'single_select' | 'multi_select' | 'number';

export function answerKind(step: InputStep): AnswerKind {
  return step.type === 'single-select' ? 'single_select' : step.type === 'multi-select' ? 'multi_select' : 'number';
}

export function validateAnswer(step: InputStep, raw: unknown): AnswerCheck {
  switch (step.type) {
    case 'single-select':
      return validateSingle(step, raw);
    case 'multi-select':
      return validateMulti(step, raw);
    case 'number':
      return validateNumber(step, raw);
  }
}

/** Config message for `code`, then for the fallback codes, then the built-in default. */
function fail(step: InputStep, code: ValidationCode, fallbackMessage: string, fallbackCodes: ValidationCode[] = []): AnswerCheck {
  const messages = step.validation.messages;
  for (const candidate of [code, ...fallbackCodes]) {
    const message = messages[candidate];
    if (message) return { ok: false, code, message };
  }
  return { ok: false, code, message: fallbackMessage };
}

function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}

function validateSingle(step: SingleSelectStep, raw: unknown): AnswerCheck {
  if (isBlank(raw)) {
    return step.validation.required ? fail(step, 'required', 'Choose an option.') : { ok: true, value: null };
  }
  if (typeof raw !== 'string' || !step.input.options.some((o) => o.value === raw)) {
    return fail(step, 'invalid_option', 'Choose one of the listed options.', ['required']);
  }
  return { ok: true, value: raw };
}

function validateMulti(step: MultiSelectStep, raw: unknown): AnswerCheck {
  const { required, minSelections, maxSelections } = step.validation;
  const empty = isBlank(raw) || (Array.isArray(raw) && raw.length === 0);
  if (empty && !required && !minSelections) return { ok: true, value: null };
  if (empty) return fail(step, 'required', 'Choose at least one option.', ['minSelections']);
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    return fail(step, 'invalid', 'Choose from the listed options.');
  }
  const known = new Set(step.input.options.map((o) => o.value));
  if (raw.some((v) => !known.has(v))) return fail(step, 'invalid_option', 'Choose from the listed options.');

  const selected = new Set(raw as string[]);
  const min = minSelections ?? (required ? 1 : 0);
  if (selected.size < min) return fail(step, 'minSelections', `Choose at least ${min}.`, ['required']);
  if (maxSelections !== undefined && selected.size > maxSelections) {
    return fail(step, 'maxSelections', `Choose no more than ${maxSelections}.`);
  }
  return { ok: true, value: step.input.options.filter((o) => selected.has(o.value)).map((o) => o.value) };
}

function parseNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return Number.NaN;
  const normalized = raw.trim().replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

function validateNumber(step: NumberStep, raw: unknown): AnswerCheck {
  if (isBlank(raw)) {
    return step.validation.required ? fail(step, 'required', 'Enter a number.') : { ok: true, value: null };
  }
  const n = parseNumber(raw);
  if (!Number.isFinite(n)) return fail(step, 'invalid', 'Enter a number.');

  const { min, max, step: increment } = step.input;
  if (min !== undefined && n < min) return fail(step, 'min', `Enter a value of at least ${min}.`);
  if (max !== undefined && n > max) return fail(step, 'max', `Enter a value up to ${max}.`);
  if (increment !== undefined) {
    const k = (n - (min ?? 0)) / increment;
    if (Math.abs(k - Math.round(k)) > 1e-9) {
      return fail(step, 'step', increment === 1 ? 'Enter a whole number.' : `Use steps of ${increment}.`);
    }
  }
  return { ok: true, value: n };
}
