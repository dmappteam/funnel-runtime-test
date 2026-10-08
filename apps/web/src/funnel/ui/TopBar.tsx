import type { Progress } from '@funnel/engine';
import type { Strings } from '../i18n';
import { ChevronLeftIcon } from './icons';

interface TopBarProps {
  strings: Strings;
  progress: Progress;
  /** `false` on the first step: there is nothing to go back to. */
  canGoBack: boolean;
  onBack: () => void;
}

export function TopBar({ strings, progress, canGoBack, onBack }: TopBarProps) {
  const { index, total } = progress;
  const counted = index !== null && total > 0;
  // The bar stays mounted while hidden, so it animates from its last value when it reappears.
  const ratio = counted ? Math.min(1, index / total) : 0;

  return (
    <header className="fn-topbar">
      <div className="fn-topbar-inner">
        <button type="button" className="fn-back" onClick={onBack} hidden={!canGoBack}>
          <ChevronLeftIcon />
          <span>{strings.back}</span>
        </button>
        {counted ? (
          <p className="fn-count" aria-hidden="true">
            {strings.stepOf(index, total)}
          </p>
        ) : null}
      </div>
      <div className="fn-progress" data-visible={counted}>
        <div
          className="fn-progress-track"
          {...(counted
            ? {
                role: 'progressbar',
                'aria-label': strings.progress,
                'aria-valuemin': 0,
                'aria-valuemax': total,
                'aria-valuenow': index,
                'aria-valuetext': strings.stepOf(index, total),
              }
            : { 'aria-hidden': true })}
        >
          <div className="fn-progress-fill" style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>
    </header>
  );
}
