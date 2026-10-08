import { useEffect } from 'react';
import { CloseIcon, InfoIcon } from './icons';

const VISIBLE_MS = 6000;

interface ToastProps {
  message: string | null;
  dismissLabel: string;
  onDismiss: () => void;
}

/** The live region is always mounted so that screen readers announce a message inserted into it. */
export function Toast({ message, dismissLabel, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDismiss, VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div className="fn-toast-region" role="status" aria-live="polite">
      {message ? (
        <div className="fn-toast">
          <InfoIcon className="fn-toast-icon" />
          <span>{message}</span>
          <button type="button" className="fn-toast-close" onClick={onDismiss} aria-label={dismissLabel}>
            <CloseIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
}
