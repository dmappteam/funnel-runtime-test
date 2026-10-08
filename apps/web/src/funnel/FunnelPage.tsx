import { useMemo, useState } from 'react';
import { getTracker } from '../tracking/tracker';
import { FunnelRuntime } from './FunnelRuntime';
import { getStrings } from './i18n';
import { FunnelSkeleton, LoadError } from './ui/StatusScreens';
import { readLaunchParams } from './url';
import { useSessionBootstrap } from './useSessionBootstrap';
import './funnel.css';

/** Funnel runtime at `/`: resumes or starts a session, then hands it to the runtime. */
export function FunnelPage() {
  const [launch] = useState(() => readLaunchParams());
  const [tracker] = useState(getTracker);
  const { state, retry, restart } = useSessionBootstrap(launch);
  const locale = state.status === 'ready' ? state.data.funnel.locale : navigator.language;
  const strings = useMemo(() => getStrings(locale), [locale]);

  if (state.status === 'loading') return <FunnelSkeleton strings={strings} />;
  if (state.status === 'error') return <LoadError strings={strings} onRetry={retry} />;

  const { data } = state;
  return (
    <FunnelRuntime
      key={data.session.sessionId}
      boot={data}
      requestedStep={state.requestedStep}
      tracker={tracker}
      notice={state.expiredBefore ? strings.sessionExpired : null}
      onExpired={restart}
    />
  );
}
