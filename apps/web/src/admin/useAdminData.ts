import { useCallback, useEffect, useRef, useState } from 'react';
import type { FunnelAdminResponse } from '@funnel/contracts';
import { getFunnelAdmin, getVersionConfig } from '../api/admin';

// Failures are kept as they came, so they are described in the language shown at render time.

export type OverviewState = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: FunnelAdminResponse };

/** Funnel overview. A failed refresh keeps the data on screen. */
export function useFunnelOverview(funnelId: string) {
  const [state, setState] = useState<OverviewState>({ status: 'loading' });
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    try {
      const data = await getFunnelAdmin(funnelId);
      if (request === latest.current) setState({ status: 'ready', data });
    } catch (error) {
      if (request === latest.current) setState((current) => (current.status === 'ready' ? current : { status: 'error', error }));
    }
  }, [funnelId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, reload };
}

export type ConfigEntry =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; config: unknown; text: string };

/** Stored configs by version. Versions are immutable, so a loaded config is never refetched. */
export function useVersionConfigs(funnelId: string) {
  const [configs, setConfigs] = useState<Record<number, ConfigEntry>>({});
  const requested = useRef(new Set<number>());

  const load = useCallback(
    (version: number) => {
      if (requested.current.has(version)) return;
      requested.current.add(version);
      setConfigs((current) => ({ ...current, [version]: { status: 'loading' } }));
      getVersionConfig(funnelId, version).then(
        (res) =>
          setConfigs((current) => ({
            ...current,
            [version]: { status: 'ready', config: res.config, text: JSON.stringify(res.config, null, 2) },
          })),
        (error: unknown) => {
          requested.current.delete(version);
          setConfigs((current) => ({ ...current, [version]: { status: 'error', error } }));
        },
      );
    },
    [funnelId],
  );

  return { configs, load };
}
