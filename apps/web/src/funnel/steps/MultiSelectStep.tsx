import { useId, useState, type CSSProperties, type FormEvent } from 'react';
import { validateAnswer, type MultiSelectStep as MultiSelectStepDef } from '@funnel/engine';
import { ActionBar } from '../ui/ActionBar';
import { ArrowRightIcon, CheckIcon } from '../ui/icons';
import { StepHeader } from '../ui/StepHeader';
import type { QuestionProps } from './types';

/**
 * Checkbox cards. Continue looks disabled until the selection is valid but stays focusable
 * (`aria-disabled`): pressing it explains what is missing with the config's own message.
 */
export function MultiSelectStep({ step, value, strings, fallbackTitle, onSubmit }: QuestionProps<MultiSelectStepDef>) {
  const titleId = useId();
  const helperId = useId();
  const errorId = useId();
  const [selected, setSelected] = useState<string[]>(() => (Array.isArray(value) ? value : []));
  const [error, setError] = useState<string | null>(null);
  const max = step.validation.maxSelections;
  const full = max !== undefined && selected.length >= max;
  const valid = validateAnswer(step, selected).ok;

  const toggle = (optionValue: string) => {
    setError(null);
    setSelected((current) =>
      current.includes(optionValue) ? current.filter((v) => v !== optionValue) : [...current, optionValue],
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(onSubmit(selected));
  };

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
        <p className="fn-select-meta" data-full={full} aria-live="polite">
          {max !== undefined ? strings.selectedOf(selected.length, max) : strings.selected(selected.length)}
        </p>
        <div
          role="group"
          className="fn-options"
          aria-labelledby={titleId}
          aria-describedby={[step.content.helperText ? helperId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined}
        >
          {step.input.options.map((option, i) => {
            const checked = selected.includes(option.value);
            const disabled = full && !checked;
            return (
              <label
                key={option.value}
                className="fn-option"
                data-checked={checked}
                data-disabled={disabled}
                style={{ '--i': i } as CSSProperties}
              >
                <input
                  type="checkbox"
                  className="fn-option-input"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(option.value)}
                />
                <span className="fn-option-label">{option.label}</span>
                <span className="fn-checkbox" aria-hidden="true">
                  <CheckIcon />
                </span>
              </label>
            );
          })}
        </div>
        <p className="fn-error" id={errorId} aria-live="polite">
          {error}
        </p>
      </div>
      <ActionBar>
        <button type="submit" className="btn fn-cta" aria-disabled={!valid}>
          {strings.continue}
          <ArrowRightIcon />
        </button>
      </ActionBar>
    </form>
  );
}
