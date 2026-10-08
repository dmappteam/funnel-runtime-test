import type { ReactNode } from 'react';

interface StepHeaderProps {
  title: string;
  titleId?: string;
  eyebrow?: string;
  helper?: ReactNode;
  helperId?: string;
}

/** The heading receives focus on every step change, so screen readers announce the new question first. */
export function StepHeader({ title, titleId, eyebrow, helper, helperId }: StepHeaderProps) {
  return (
    <header className="fn-head">
      {eyebrow ? <p className="fn-eyebrow">{eyebrow}</p> : null}
      <h1 className="fn-title" id={titleId} tabIndex={-1} data-step-heading="">
        {title}
      </h1>
      {helper ? (
        <p className="fn-helper" id={helperId}>
          {helper}
        </p>
      ) : null}
    </header>
  );
}
