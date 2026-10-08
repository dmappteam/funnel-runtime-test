import type { ReactNode } from 'react';

interface OrbitProps {
  /** `busy` spins faster while the result is computed. */
  mode?: 'idle' | 'busy' | 'done';
  children?: ReactNode;
}

/** Decorative mark shared by the intro and the result, so the beginning and the end of the funnel feel connected. */
export function Orbit({ mode = 'idle', children }: OrbitProps) {
  return (
    <div className="fn-orbit" data-mode={mode} aria-hidden="true">
      <span className="fn-orbit-ring fn-orbit-ring--outer">
        <i />
      </span>
      <span className="fn-orbit-ring fn-orbit-ring--middle">
        <i />
      </span>
      <span className="fn-orbit-ring fn-orbit-ring--inner">
        <i />
      </span>
      <span className="fn-orbit-core">{children}</span>
    </div>
  );
}
