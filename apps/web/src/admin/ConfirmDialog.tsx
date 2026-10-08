import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'default' | 'danger';
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

/** `confirm()` resolves with the user's choice; render `dialog` once in the page. */
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const close = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
  };
  const dialog = pending ? <ConfirmDialog {...pending} onClose={close} /> : null;
  return { confirm, dialog };
}

/** Native modal dialog: focus trap, Escape and the backdrop come from the browser. */
function ConfirmDialog({ title, body, confirmLabel, tone = 'default', onClose }: ConfirmOptions & { onClose: (confirmed: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // close() before unmounting lets the browser return focus to the button that opened the dialog.
  const finish = (confirmed: boolean) => {
    ref.current?.close();
    onClose(confirmed);
  };

  return (
    <dialog
      ref={ref}
      className="adm-dialog"
      aria-labelledby="adm-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        finish(false);
      }}
    >
      <h2 id="adm-dialog-title">{title}</h2>
      <div className="adm-dialog-body">{body}</div>
      <div className="adm-dialog-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => finish(false)}>
          Cancel
        </button>
        <button type="button" className={`btn btn-sm${tone === 'danger' ? ' btn-danger' : ''}`} onClick={() => finish(true)}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
