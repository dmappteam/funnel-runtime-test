import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ctaClicked, recommendationExpanded, resultStepId, resultViewed, type ResultResponse } from '@funnel/contracts';
import type { ResolvedFunnel, ResultDef, ResultStep as ResultStepDef } from '@funnel/engine';
import { HttpError } from '../../api/http';
import { isSessionGone } from '../../api/sessions';
import type { Tracker } from '../../tracking/tracker';
import type { Strings } from '../i18n';
import { ActionBar } from '../ui/ActionBar';
import { AlertIcon, ArrowRightIcon, CheckIcon, RefreshIcon } from '../ui/icons';
import { Orbit } from '../ui/Orbit';

export const EXPAND_ACTION = 'expand_recommendation';

type ResultState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; resultId: string; result: ResultDef };

interface ResultStepProps {
  step: ResultStepDef;
  funnel: ResolvedFunnel;
  strings: Strings;
  tracker: Tracker;
  /** POSTs the current answers. The result already includes the variant's overrides. */
  load: () => Promise<ResultResponse>;
  /** The server is missing answers: the runtime takes the user to the first missing question. */
  onIncomplete: (missingStepIds: string[]) => void;
  /** The session expired or no longer exists: retrying cannot help, the runtime starts a new one. */
  onExpired: () => void;
}

function missingSteps(err: unknown): string[] {
  if (!(err instanceof HttpError) || err.status !== 409 || err.body?.error !== 'incomplete') return [];
  const ids = (err.body.details as { missingStepIds?: unknown } | undefined)?.missingStepIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function ResultStep({ step, funnel, strings, tracker, load, onIncomplete, onExpired }: ResultStepProps) {
  const [state, setState] = useState<ResultState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const request = useRef<{ attempt: number; promise: Promise<ResultResponse> } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const shownStatus = useRef(state.status);
  const tracked = useRef({ viewed: false, expanded: false });
  const eventStepId = resultStepId(funnel);
  const ready = state.status === 'ready' ? state : null;
  const expandable = ready !== null && ready.result.cta.action === EXPAND_ACTION && ready.result.recommendations.length > 0;

  // One request per attempt, also when StrictMode runs the effect twice. Only `attempt` restarts it:
  // the callbacks change identity on every render but must not trigger a new request.
  useEffect(() => {
    let alive = true;
    if (request.current?.attempt !== attempt) request.current = { attempt, promise: load() };
    request.current.promise.then(
      (res) => {
        if (alive) setState({ status: 'ready', resultId: res.resultId, result: res.result });
      },
      (err: unknown) => {
        if (!alive) return;
        if (isSessionGone(err)) return onExpired();
        const missing = missingSteps(err);
        if (missing.length > 0) return onIncomplete(missing);
        setState({ status: 'error' });
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  // The heading is replaced when the status changes: move focus to the new one so it is announced.
  useEffect(() => {
    if (shownStatus.current === state.status) return;
    shownStatus.current = state.status;
    rootRef.current?.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true });
  }, [state.status]);

  useEffect(() => {
    if (!ready || tracked.current.viewed) return;
    tracked.current.viewed = true;
    tracker.track(resultViewed(eventStepId, ready.resultId));
  }, [ready, eventStepId, tracker]);

  useEffect(() => {
    if (!expanded || !ready || tracked.current.expanded) return;
    tracked.current.expanded = true;
    // The tracker drops it for versions that do not allow this event (v1, v2).
    tracker.track(recommendationExpanded(eventStepId, ready.resultId, ready.result.cta.action));
    listRef.current?.focus({ preventScroll: true });
    listRef.current?.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [expanded, ready, eventStepId, tracker]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  const onCta = () => {
    if (!ready) return;
    tracker.track(ctaClicked(eventStepId, ready.resultId, ready.result.cta.action));
    if (expandable) setExpanded(true);
  };

  const { loadingTitle, errorTitle, retryLabel } = step.content;

  if (state.status === 'loading') {
    return (
      <div className="fn-step-body fn-result" ref={rootRef} data-status="loading">
        <Orbit mode="busy" />
        <div role="status" aria-live="polite">
          <h1 className="fn-title" tabIndex={-1} data-step-heading="">
            {loadingTitle ?? strings.resultLoading}
          </h1>
        </div>
        <div className="fn-result-lines" aria-hidden="true">
          <span className="fn-skel fn-skel--line" />
          <span className="fn-skel fn-skel--line" />
          <span className="fn-skel fn-skel--line fn-skel--short" />
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <>
        <div className="fn-step-body fn-result" ref={rootRef} data-status="error" role="alert">
          <div className="fn-status-icon">
            <AlertIcon />
          </div>
          <h1 className="fn-title" tabIndex={-1} data-step-heading="">
            {errorTitle ?? strings.resultError}
          </h1>
          <p className="fn-helper">{strings.resultErrorHint}</p>
        </div>
        <ActionBar>
          <button type="button" className="btn fn-cta" onClick={retry}>
            <RefreshIcon />
            {retryLabel ?? strings.retry}
          </button>
        </ActionBar>
      </>
    );
  }

  const { result } = state;
  return (
    <>
      <div className="fn-step-body fn-result" ref={rootRef} data-status="ready">
        <Orbit mode="done">
          <CheckIcon />
        </Orbit>
        <h1 className="fn-title" tabIndex={-1} data-step-heading="">
          {result.title}
        </h1>
        {result.summary ? <p className="fn-result-summary">{result.summary}</p> : null}
        {expanded ? (
          <ol className="fn-recos" ref={listRef} tabIndex={-1}>
            {result.recommendations.map((text, i) => (
              <li key={i} style={{ '--i': i } as CSSProperties}>
                <span className="fn-reco-index" aria-hidden="true">
                  {i + 1}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {expanded ? null : (
        <ActionBar>
          <button type="button" className="btn fn-cta" onClick={onCta}>
            {result.cta.label}
            <ArrowRightIcon />
          </button>
        </ActionBar>
      )}
    </>
  );
}
