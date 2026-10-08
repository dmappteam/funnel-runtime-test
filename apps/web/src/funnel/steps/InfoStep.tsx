import type { InfoStep as InfoStepDef } from '@funnel/engine';
import type { Strings } from '../i18n';
import { ActionBar } from '../ui/ActionBar';
import { ArrowRightIcon } from '../ui/icons';
import { Orbit } from '../ui/Orbit';
import { StepHeader } from '../ui/StepHeader';

interface InfoStepProps {
  step: InfoStepDef;
  fallbackTitle: string;
  strings: Strings;
  onContinue: () => void;
}

export function InfoStep({ step, fallbackTitle, strings, onContinue }: InfoStepProps) {
  const { eyebrow, title, body, helperText, primaryActionLabel } = step.content;
  return (
    <>
      <div className="fn-step-body fn-info">
        <Orbit />
        <StepHeader eyebrow={eyebrow} title={title ?? fallbackTitle} helper={body} />
        {helperText ? <p className="fn-note">{helperText}</p> : null}
      </div>
      <ActionBar>
        <button type="button" className="btn fn-cta" onClick={onContinue}>
          {primaryActionLabel ?? strings.continue}
          <ArrowRightIcon />
        </button>
      </ActionBar>
    </>
  );
}
