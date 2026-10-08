import type { ReactNode } from 'react';

/** Primary actions of a step. Sticks to the bottom of the screen on phones, flows after the content on wider screens. */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="fn-actions">
      <div className="fn-actions-inner">{children}</div>
    </div>
  );
}
