import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  answerSubmitted,
  backClicked,
  stepCompleted,
  stepViewed,
  type SessionInfo,
  type SessionResponse,
  type SessionState,
} from '@funnel/contracts';
import {
  getNextStepId,
  getPrevStepId,
  getProgress,
  hasInput,
  isStepReachable,
  resolveCurrentStepId,
  validateAnswer,
  type Answers,
  type Step,
} from '@funnel/engine';
import { requestResult } from '../api/sessions';
import type { Tracker } from '../tracking/tracker';
import { pushStep, readHistoryDepth, replaceStep } from './history';
import { getStrings } from './i18n';
import { initialStepId } from './initialStep';
import { createStateSync, type StateSync } from './stateSync';
import { InfoStep } from './steps/InfoStep';
import { MultiSelectStep } from './steps/MultiSelectStep';
import { NumberStep } from './steps/NumberStep';
import { ResultStep } from './steps/ResultStep';
import { SingleSelectStep } from './steps/SingleSelectStep';
import { Toast } from './ui/Toast';
import { TopBar } from './ui/TopBar';
import { readStepParam } from './url';

type Direction = 'forward' | 'back' | 'none';

interface View {
  stepId: string;
  /** Increments on every navigation: one `step_viewed` and one fresh step component per view. */
  seq: number;
  direction: Direction;
}

export interface FunnelRuntimeProps {
  boot: SessionResponse;
  /** `?step=` of the landing URL. Honoured only to take a resumed session back to a reachable step (`initialStepId`). */
  requestedStep: string | null;
  tracker: Tracker;
  notice: string | null;
  onExpired: (session: SessionInfo) => void;
}

/**
 * Runs one session: navigation, browser history, events and background persistence.
 * All funnel logic (paths, visibility, progress, validation) comes from @funnel/engine.
 */
export function FunnelRuntime({ boot, requestedStep, tracker, notice: initialNotice, onExpired }: FunnelRuntimeProps) {
  const { funnel, session } = boot;
  const strings = useMemo(() => getStrings(funnel.locale), [funnel.locale]);
  const [answers, setAnswers] = useState<Answers>(boot.state.answers);
  const [view, setView] = useState<View>(() => ({
    stepId: initialStepId(boot, requestedStep),
    seq: 0,
    direction: 'none',
  }));
  const [notice, setNotice] = useState(initialNotice);

  /** Latest state for handlers that fire before React re-renders: double taps, timers, popstate. */
  const live = useRef({ answers, view });
  const seq = useRef(0);
  const depth = useRef(0);
  const baseDepth = useRef(0);
  /** Destination of an in-app Back that is waiting for its popstate. */
  const pendingBack = useRef<string | null>(null);
  const viewedSeq = useRef(-1);
  const stepRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef<StateSync | null>(null);
  const syncHandlers = useRef({ onConflict: (_state: SessionState) => {}, onExpired: () => {} });

  const sync = () => {
    syncRef.current ??= createStateSync({
      sessionId: session.sessionId,
      rev: boot.state.rev,
      onConflict: (state) => syncHandlers.current.onConflict(state),
      onExpired: () => syncHandlers.current.onExpired(),
    });
    return syncRef.current;
  };

  const show = (stepId: string, direction: Direction, nextAnswers: Answers = live.current.answers, persist = true) => {
    const next: View = { stepId, seq: ++seq.current, direction };
    live.current = { answers: nextAnswers, view: next };
    setAnswers(nextAnswers);
    setView(next);
    if (persist) sync().save({ answers: nextAnswers, currentStepId: stepId });
  };

  const forward = (fromStepId: string, nextAnswers: Answers, fromQuestion: boolean) => {
    const next = getNextStepId(funnel, nextAnswers, fromStepId);
    if (!next) return;
    if (fromQuestion) {
      tracker.track(answerSubmitted(funnel, fromStepId));
      tracker.track(stepCompleted(fromStepId, next));
    }
    depth.current += 1;
    pushStep(next, depth.current);
    show(next, 'forward', nextAnswers);
  };

  const submitAnswer = (stepId: string, raw: unknown): string | null => {
    const step = funnel.steps[stepId];
    // A late call from a step the user has already left (double tap, auto-advance timer).
    if (stepId !== live.current.view.stepId || !step || !hasInput(step)) return null;
    const check = validateAnswer(step, raw);
    if (!check.ok) return check.message;
    // Answers of steps this change hides are kept: the engine ignores them, and they return if the branch does.
    forward(stepId, { ...live.current.answers, [step.input.name]: check.value }, true);
    return null;
  };

  const continueFrom = (stepId: string) => {
    if (stepId === live.current.view.stepId) forward(stepId, live.current.answers, false);
  };

  const goBack = () => {
    const { answers: current, view: currentView } = live.current;
    const prev = getPrevStepId(funnel, current, currentView.stepId);
    if (!prev || pendingBack.current !== null) return;
    tracker.track(backClicked(currentView.stepId, prev));
    if (depth.current > baseDepth.current) {
      // The entry behind this one was pushed by this page: going back through history keeps
      // the browser's Back and Forward buttons in line with the funnel. popstate shows `prev`.
      pendingBack.current = prev;
      window.history.back();
      return;
    }
    replaceStep(prev, depth.current);
    show(prev, 'back');
  };

  const jumpTo = (stepId: string) => {
    replaceStep(stepId, depth.current);
    show(stepId, 'back');
  };

  // The result request also bumps the rev: it goes through the sync queue so it never races a state save.
  const loadResult = () => sync().exclusive(() => requestResult(session.sessionId, live.current.answers));

  const dismissNotice = useCallback(() => setNotice(null), []);

  useLayoutEffect(() => {
    syncHandlers.current = {
      onConflict: (state) => {
        // Another tab saved different answers: continue from there instead of overwriting them.
        const target = resolveCurrentStepId(funnel, state.answers, state.currentStepId);
        replaceStep(target, depth.current);
        show(target, 'none', state.answers, false);
        setNotice(strings.progressSynced);
      },
      onExpired: () => onExpired(session),
    };
  });

  // A pending retry must not outlive the runtime: after a restart it would report the old session as expired again.
  // The ref is cleared, not kept stopped, so StrictMode's remount creates a new sync on first use.
  useEffect(
    () => () => {
      syncRef.current?.stop();
      syncRef.current = null;
    },
    [],
  );

  // Layout effect: the context must be set before the first step_viewed, which is sent from a passive effect.
  useLayoutEffect(() => {
    tracker.setContext({ sessionId: session.sessionId, funnel, utm: session.utm });
  }, [tracker, session, funnel]);

  useEffect(() => {
    document.documentElement.lang = funnel.locale;
    document.title = funnel.title;
  }, [funnel]);

  // The URL keeps only the step: utm, variant and reset are stored on the session.
  useEffect(() => {
    depth.current = readHistoryDepth(window.history.state);
    baseDepth.current = depth.current;
    const { answers: current, view: initial } = live.current;
    replaceStep(initial.stepId, depth.current);
    if (initial.stepId !== boot.state.currentStepId) sync().save({ answers: current, currentStepId: initial.stepId });
  }, []);

  // Registered once: the handler reads the live refs, not render-time state.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const { answers: current, view: currentView } = live.current;
      const expected = pendingBack.current;
      pendingBack.current = null;
      depth.current = readHistoryDepth(event.state);
      const landed = readStepParam();
      const target =
        expected ??
        (landed && isStepReachable(funnel, current, landed) ? landed : resolveCurrentStepId(funnel, current, landed));
      if (target !== landed) replaceStep(target, depth.current);
      if (target === currentView.stepId) return;
      const back = funnel.sequence.indexOf(target) < funnel.sequence.indexOf(currentView.stepId);
      if (back && expected === null) tracker.track(backClicked(currentView.stepId, target));
      show(target, back ? 'back' : 'forward');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [funnel, tracker]);

  // Guarded by seq: StrictMode runs effects twice, but every view is reported exactly once.
  useEffect(() => {
    if (viewedSeq.current === view.seq) return;
    viewedSeq.current = view.seq;
    tracker.track(stepViewed(funnel, answers, view.stepId));
    if (view.seq === 0) return;
    window.scrollTo({ top: 0 });
    stepRef.current?.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true });
  }, [view, answers, funnel, tracker]);

  const step = funnel.steps[view.stepId];
  const progress = getProgress(funnel, answers, view.stepId);
  const canGoBack = getPrevStepId(funnel, answers, view.stepId) !== null;

  const renderStep = (current: Step) => {
    const question = { strings, fallbackTitle: funnel.title, onSubmit: (raw: unknown) => submitAnswer(current.id, raw) };
    switch (current.type) {
      case 'info':
        return (
          <InfoStep step={current} strings={strings} fallbackTitle={funnel.title} onContinue={() => continueFrom(current.id)} />
        );
      case 'single-select':
        return <SingleSelectStep step={current} value={answers[current.input.name]} {...question} />;
      case 'multi-select':
        return <MultiSelectStep step={current} value={answers[current.input.name]} {...question} />;
      case 'number':
        return <NumberStep step={current} value={answers[current.input.name]} {...question} />;
      case 'result':
        return (
          <ResultStep
            step={current}
            funnel={funnel}
            strings={strings}
            tracker={tracker}
            load={loadResult}
            onIncomplete={(missing) =>
              jumpTo(missing.find((id) => funnel.steps[id]) ?? resolveCurrentStepId(funnel, live.current.answers))
            }
            onExpired={() => onExpired(session)}
          />
        );
    }
  };

  return (
    <div className="fn-app">
      <TopBar strings={strings} progress={progress} canGoBack={canGoBack} onBack={goBack} />
      <main className="fn-main">
        <Toast message={notice} dismissLabel={strings.dismiss} onDismiss={dismissNotice} />
        <div className="fn-step" key={view.seq} ref={stepRef} data-direction={view.direction} data-type={step?.type}>
          {step ? renderStep(step) : null}
        </div>
      </main>
    </div>
  );
}
