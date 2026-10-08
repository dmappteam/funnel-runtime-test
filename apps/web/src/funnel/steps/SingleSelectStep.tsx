import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { SingleSelectStep as SingleSelectStepDef } from '@funnel/engine';
import { StepHeader } from '../ui/StepHeader';
import type { QuestionProps } from './types';

/** Long enough to see the selection land, short enough to feel instant. */
export const AUTO_ADVANCE_MS = 200;

const ARROW_DELTA: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/**
 * Radio cards. A tap or Enter/Space commits and advances; arrow keys only move the selection,
 * so keyboard users can review the options without being carried to the next question.
 */
export function SingleSelectStep({ step, value, fallbackTitle, onSubmit }: QuestionProps<SingleSelectStepDef>) {
  const titleId = useId();
  const helperId = useId();
  const errorId = useId();
  const { options } = step.input;
  const [selected, setSelected] = useState<string | null>(typeof value === 'string' ? value : null);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const commit = (optionValue: string) => {
    if (committing) return;
    setSelected(optionValue);
    setCommitting(true);
    setError(null);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const message = onSubmit(optionValue);
      if (message) {
        setError(message);
        setCommitting(false);
      }
    }, AUTO_ADVANCE_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    const delta = ARROW_DELTA[event.key];
    if (delta !== undefined) next = (index + delta + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next === null || committing) return;
    event.preventDefault();
    setSelected(options[next]!.value);
    optionRefs.current[next]?.focus();
  };

  const tabStop = Math.max(
    0,
    options.findIndex((o) => o.value === selected),
  );

  return (
    <div className="fn-step-body">
      <StepHeader
        title={step.content.title ?? fallbackTitle}
        titleId={titleId}
        eyebrow={step.content.eyebrow}
        helper={step.content.helperText}
        helperId={helperId}
      />
      <div
        role="radiogroup"
        className="fn-options"
        aria-labelledby={titleId}
        aria-describedby={[step.content.helperText ? helperId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined}
        data-committing={committing || undefined}
      >
        {options.map((option, i) => (
          <button
            key={option.value}
            ref={(el) => {
              optionRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected === option.value}
            tabIndex={i === tabStop ? 0 : -1}
            className="fn-option"
            style={{ '--i': i } as CSSProperties}
            onClick={() => commit(option.value)}
            onKeyDown={(event) => onKeyDown(event, i)}
          >
            <span className="fn-option-label">{option.label}</span>
            <span className="fn-radio" aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="fn-error" id={errorId} aria-live="polite">
        {error}
      </p>
    </div>
  );
}
