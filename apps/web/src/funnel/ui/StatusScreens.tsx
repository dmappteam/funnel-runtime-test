import type { Strings } from '../i18n';
import { CloudOffIcon, RefreshIcon } from './icons';

/** Shaped like a question step, so the real content replaces it without a layout jump. */
export function FunnelSkeleton({ strings }: { strings: Strings }) {
  return (
    <div className="fn-app" aria-busy="true">
      <div className="fn-topbar">
        <div className="fn-topbar-inner">
          <span className="fn-skel fn-skel--pill" />
        </div>
        <div className="fn-progress">
          <div className="fn-progress-track" />
        </div>
      </div>
      <main className="fn-main">
        <div className="fn-step fn-skeleton">
          <span className="fn-skel fn-skel--eyebrow" />
          <span className="fn-skel fn-skel--title" />
          <span className="fn-skel fn-skel--title fn-skel--short" />
          <span className="fn-skel fn-skel--line" />
          <div className="fn-options">
            {[0, 1, 2].map((i) => (
              <span key={i} className="fn-skel fn-skel--option" />
            ))}
          </div>
        </div>
        <p className="fn-visually-hidden" role="status">
          {strings.loading}
        </p>
      </main>
    </div>
  );
}

export function LoadError({ strings, onRetry }: { strings: Strings; onRetry: () => void }) {
  return (
    <div className="fn-app">
      <main className="fn-main fn-center">
        <section className="fn-status-card" role="alert" aria-labelledby="fn-load-error-title">
          <div className="fn-status-icon">
            <CloudOffIcon />
          </div>
          <h1 className="fn-title fn-title--sm" id="fn-load-error-title">
            {strings.loadErrorTitle}
          </h1>
          <p className="fn-helper">{strings.loadErrorHint}</p>
          <button type="button" className="btn fn-cta fn-cta--inline" onClick={onRetry}>
            <RefreshIcon />
            {strings.retry}
          </button>
        </section>
      </main>
    </div>
  );
}
