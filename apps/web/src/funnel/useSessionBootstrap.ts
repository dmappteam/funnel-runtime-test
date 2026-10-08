import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionInfo, SessionResponse } from '@funnel/contracts';
import { bootstrapSession, launchRequest, restartRequest, type BootstrapRequest, type PendingSession } from './bootstrap';
import type { LaunchParams } from './url';

export type BootState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: SessionResponse; requestedStep: string | null; expiredBefore: boolean };

interface Attempt {
  id: number;
  request: BootstrapRequest;
  requestedStep: string | null;
  expiredBefore: boolean;
}

export function useSessionBootstrap(launch: LaunchParams) {
  const [attempt, setAttempt] = useState<Attempt>(() => ({
    id: 0,
    request: launchRequest(launch),
    requestedStep: launch.step,
    expiredBefore: false,
  }));
  const [state, setState] = useState<BootState>({ status: 'loading' });
  const pending = useRef<PendingSession | null>(null);
  /** Shared by StrictMode's double effect run, so one attempt sends one set of requests. */
  const inflight = useRef<{ id: number; promise: Promise<SessionResponse> } | null>(null);

  useEffect(() => {
    let alive = true;
    if (inflight.current?.id !== attempt.id) {
      inflight.current = { id: attempt.id, promise: bootstrapSession(attempt.request, pending) };
    }
    inflight.current.promise.then(
      (data) => {
        if (alive) setState({ status: 'ready', data, requestedStep: attempt.requestedStep, expiredBefore: attempt.expiredBefore });
      },
      () => {
        if (alive) setState({ status: 'error' });
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((current) => ({ ...current, id: current.id + 1 }));
  }, []);

  /** The session expired mid-funnel: start a replacement with the same attribution. */
  const restart = useCallback((expired: SessionInfo) => {
    setState({ status: 'loading' });
    setAttempt((current) => ({
      id: current.id + 1,
      request: restartRequest(expired),
      requestedStep: null,
      expiredBefore: true,
    }));
  }, []);

  return { state, retry, restart };
}
