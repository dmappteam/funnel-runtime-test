import type { AnswerValue } from '@funnel/engine';
import type { Strings } from '../i18n';

export interface QuestionProps<S> {
  step: S;
  /** Stored answer, also for a question the user comes back to. */
  value: AnswerValue | undefined;
  strings: Strings;
  /** Heading for a step whose config has no title. */
  fallbackTitle: string;
  /** Validates the raw input and moves on. Returns the message to show when the answer is invalid. */
  onSubmit: (raw: unknown) => string | null;
}
