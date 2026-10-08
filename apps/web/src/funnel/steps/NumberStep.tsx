import { useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { NumberStep as NumberStepDef } from '@funnel/engine';
import { ActionBar } from '../ui/ActionBar';
import { ArrowRightIcon, MinusIcon, PlusIcon } from '../ui/icons';
import { StepHeader } from '../ui/StepHeader';
import type { QuestionProps } from './types';

const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;

/** Same grammar as the engine: digits with an optional `.` or `,` fraction. */
export function parseNumber(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : null;
}

/** Value after a −/+ press: one increment away, clamped to the allowed range. An empty field starts at the minimum. */
export function nudge(current: number | null, direction: 1 | -1, input: NumberStepDef['input']): number {
  const increment = input.step ?? 1;
  const raw = current === null ? (input.min ?? 0) : current + direction * increment;
  const rounded = Number(raw.toFixed(Math.max(decimals(increment), current === null ? 0 : decimals(current))));
  return Math.min(input.max ?? Infinity, Math.max(input.min ?? -Infinity, rounded));
}

export function NumberStep({ step, value, strings, fallbackTitle, onSubmit }: QuestionProps<NumberStepDef>) {
  const titleId = useId();
  const helperId = useId();
  const rangeId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const { min, max, unit } = step.input;
  const [text, setText] = useState(typeof value === 'number' ? String(value) : '');
  const [error, setError] = useState<string | null>(null);
  const current = parseNumber(text);
  const fractional = !Number.isInteger(step.input.step ?? 1) || (min !== undefined && !Number.isInteger(min));
  const placeholder = String(min ?? 0);
  const range = min !== undefined && max !== undefined ? `${strings.range(min, max)}${unit ? ` ${unit}` : ''}` : null;

  const change = (next: string) => {
    setText(next);
    setError(null);
  };
  const onChange = (event: ChangeEvent<HTMLInputElement>) => change(event.target.value.replace(/[^\d.,-]/g, '').slice(0, 12));
  const bump = (direction: 1 | -1) => change(String(nudge(current, direction, step.input)));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    bump(event.key === 'ArrowUp' ? 1 : -1);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(onSubmit(text));
  };

  const describedBy = [step.content.helperText ? helperId : null, range ? rangeId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <form className="fn-form" onSubmit={submit} noValidate>
      <div className="fn-step-body">
        <StepHeader
          title={step.content.title ?? fallbackTitle}
          titleId={titleId}
          eyebrow={step.content.eyebrow}
          helper={step.content.helperText}
          helperId={helperId}
        />
        <div className="fn-number">
          <button
            type="button"
            className="fn-stepper"
            aria-label={strings.decrease}
            disabled={current !== null && min !== undefined && current <= min}
            onClick={() => bump(-1)}
          >
            <MinusIcon />
          </button>
          <div className="fn-number-field" data-invalid={error !== null} onClick={() => inputRef.current?.focus()}>
            <input
              ref={inputRef}
              className="fn-number-input"
              type="text"
              inputMode={fractional ? 'decimal' : 'numeric'}
              autoComplete="off"
              enterKeyHint="next"
              placeholder={placeholder}
              value={text}
              onChange={onChange}
              onKeyDown={onKeyDown}
              aria-labelledby={titleId}
              aria-describedby={describedBy || undefined}
              aria-invalid={error !== null || undefined}
              // Sized to its content so the value and the unit stay centred together.
              style={{ width: `${Math.max(1, (text || placeholder).length) + 0.5}ch` }}
            />
            {unit ? <span className="fn-unit">{unit}</span> : null}
          </div>
          <button
            type="button"
            className="fn-stepper"
            aria-label={strings.increase}
            disabled={current !== null && max !== undefined && current >= max}
            onClick={() => bump(1)}
          >
            <PlusIcon />
          </button>
        </div>
        {range ? (
          <p className="fn-range" id={rangeId}>
            {range}
          </p>
        ) : null}
        <p className="fn-error" id={errorId} aria-live="polite">
          {error}
        </p>
      </div>
      <ActionBar>
        <button type="submit" className="btn fn-cta">
          {strings.continue}
          <ArrowRightIcon />
        </button>
      </ActionBar>
    </form>
  );
}
