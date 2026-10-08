import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { ValidateConfigResponse } from '@funnel/contracts';
import { FunnelConfigSchema, operatorsUsed } from '@funnel/engine';
import { createVersion, publishVersion, validateConfigText } from '../api/admin';
import { Callout, IssueList, type Notice } from './Callout';
import type { ConfirmOptions } from './ConfirmDialog';
import { DiffView } from './DiffView';
import { describeError } from './format';
import type { ConfigEntry } from './useAdminData';

interface PublishPanelProps {
  funnelId: string;
  activeVersion: number | null;
  configs: Record<number, ConfigEntry>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  onChanged: () => Promise<unknown>;
}

type Busy = 'validate' | 'save' | 'publish' | null;

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

/** The server diff lists added operators only; removed ones are derived here from both configs. */
function removedOperators(previous: unknown, nextText: string): string[] {
  const parsed = parseJson(nextText);
  if (!parsed.ok) return [];
  const before = FunnelConfigSchema.safeParse(previous);
  const after = FunnelConfigSchema.safeParse(parsed.value);
  if (!before.success || !after.success) return [];
  const used = new Set(operatorsUsed(after.data));
  return operatorsUsed(before.data).filter((op) => !used.has(op));
}

/** Upload or paste a config → validate (errors, warnings, diff) → save as draft or save and publish. */
export function PublishPanel({ funnelId, activeVersion, configs, confirm, onChanged }: PublishPanelProps) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ text: string; result: ValidateConfigResponse } | null>(null);
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // A result applies only to the exact text it was computed for.
  const result = checked?.text === text ? checked.result : null;
  const outdated = checked !== null && checked.text !== text;
  const canSave = result !== null && result.ok && result.versionStatus !== 'conflict' && busy === null;
  const active = activeVersion === null ? undefined : configs[activeVersion];
  const activeText = active?.status === 'ready' ? active.text : null;

  const operatorsRemoved = useMemo(() => {
    const from = result?.diff ? configs[result.diff.fromVersion] : undefined;
    return from?.status === 'ready' ? removedOperators(from.config, text) : [];
  }, [result, configs, text]);

  const replaceText = (next: string, name: string | null) => {
    setText(next);
    setFileName(name);
    setSyntaxError(null);
    setNotice(null);
  };

  const readFile = async (file: File | undefined) => {
    if (file) replaceText(await file.text(), file.name);
  };

  const onFileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    void readFile(event.target.files?.[0]);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const file = event.dataTransfer.files[0];
    setDragging(false);
    if (!file) return;
    event.preventDefault();
    void readFile(file);
  };

  const validate = async () => {
    setNotice(null);
    const parsed = parseJson(text);
    if (!parsed.ok) {
      setSyntaxError(parsed.message);
      setChecked(null);
      return;
    }
    setSyntaxError(null);
    setBusy('validate');
    try {
      setChecked({ text, result: await validateConfigText(funnelId, text) });
    } catch (err) {
      setChecked(null);
      setNotice({ tone: 'danger', ...describeError(err) });
    } finally {
      setBusy(null);
    }
  };

  const save = async (publish: boolean) => {
    if (!canSave || result.version === null) return;
    const version = result.version;
    if (publish) {
      const confirmed = await confirm({
        title: `Save and publish v${version}?`,
        body: (
          <p>
            New sessions will start on v{version}. Sessions already in progress stay on the version they started with.
          </p>
        ),
        confirmLabel: `Publish v${version}`,
      });
      if (!confirmed) return;
    }
    setBusy(publish ? 'publish' : 'save');
    setNotice(null);
    try {
      const saved = await createVersion(funnelId, text);
      if (publish) {
        const published = await publishVersion(funnelId, saved.version);
        setNotice({
          tone: 'success',
          title: published.previousVersion === published.activeVersion ? `v${saved.version} was already active.` : `v${saved.version} is now active.`,
          detail: saved.created ? 'Stored as a new version and published.' : 'This exact config was already stored, so it was published as is.',
        });
      } else {
        setNotice({
          tone: 'success',
          title: saved.created ? `v${saved.version} saved as a draft.` : `v${saved.version} is already stored with this exact config.`,
          detail: 'Publish it from the versions table when it is ready.',
        });
      }
      // The version status has changed (new → identical): validate again before the next save.
      setChecked(null);
    } catch (err) {
      setNotice({ tone: 'danger', ...describeError(err) });
    } finally {
      setBusy(null);
      await onChanged();
    }
  };

  return (
    <section className="card adm-card" aria-labelledby="adm-publish-title">
      <div className="adm-card-head">
        <h2 id="adm-publish-title">Publish a new version</h2>
        <div className="adm-toolbar">
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={onFileChosen} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInput.current?.click()}>
            Choose file…
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={activeText === null}
            onClick={() => activeText !== null && replaceText(activeText, null)}
          >
            {activeVersion === null ? 'Start from active' : `Start from v${activeVersion}`}
          </button>
        </div>
      </div>
      <p className="adm-hint" id="adm-config-hint">
        Choose a .json file, drop it on the editor or paste a config. Validation stores nothing.
      </p>

      <label className="adm-label" htmlFor="adm-config">
        Config JSON{fileName ? <span className="adm-muted"> · {fileName}</span> : null}
      </label>
      <textarea
        id="adm-config"
        className="adm-editor"
        data-drag={dragging || undefined}
        aria-describedby="adm-config-hint"
        aria-invalid={syntaxError !== null || undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={'{\n  "schemaVersion": "1.0",\n  "funnelId": "' + funnelId + '",\n  "version": 4,\n  …\n}'}
        value={text}
        onChange={(event) => replaceText(event.target.value, fileName)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      />
      {syntaxError ? (
        <p className="adm-error-text" role="alert">
          Invalid JSON: {syntaxError}
        </p>
      ) : null}

      <div className="adm-toolbar adm-publish-actions">
        <button type="button" className="btn btn-sm" disabled={!text.trim() || busy !== null} onClick={validate}>
          {busy === 'validate' ? 'Validating…' : 'Validate'}
        </button>
        <span className="adm-spacer" />
        <button type="button" className="btn btn-secondary btn-sm" disabled={!canSave} onClick={() => save(false)}>
          {busy === 'save' ? 'Saving…' : 'Save as draft'}
        </button>
        <button type="button" className="btn btn-sm" disabled={!canSave} onClick={() => save(true)}>
          {busy === 'publish' ? 'Publishing…' : 'Save and publish'}
        </button>
      </div>
      {outdated ? <p className="adm-hint">The config changed after validation. Validate again to save it.</p> : null}

      {result ? <ValidationReport result={result} operatorsRemoved={operatorsRemoved} /> : null}
      {notice ? <Callout notice={notice} onDismiss={() => setNotice(null)} /> : null}
    </section>
  );
}

function ValidationReport({ result, operatorsRemoved }: { result: ValidateConfigResponse; operatorsRemoved: string[] }) {
  const { errors, warnings, version, versionStatus, diff } = result;
  return (
    <div className="adm-report" aria-live="polite">
      <div className="adm-report-summary">
        {result.ok ? (
          <span className="badge badge-success">Valid</span>
        ) : (
          <span className="badge badge-danger">
            {errors.length} {errors.length === 1 ? 'error' : 'errors'}
          </span>
        )}
        {warnings.length > 0 ? (
          <span className="badge badge-warning">
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
          </span>
        ) : null}
        {version !== null && versionStatus === 'new' ? <span className="adm-muted">New version v{version}</span> : null}
        {version !== null && versionStatus === 'identical' ? (
          <span className="adm-muted">v{version} is already stored with identical content</span>
        ) : null}
      </div>
      {version !== null && versionStatus === 'conflict' ? (
        <p className="adm-error-text">
          v{version} already exists with different content. Increase &quot;version&quot; to store this config.
        </p>
      ) : null}
      {errors.length > 0 ? <IssueList issues={errors} tone="error" /> : null}
      {warnings.length > 0 ? <IssueList issues={warnings} tone="warning" /> : null}
      {diff ? (
        <DiffView diff={diff} operatorsRemoved={operatorsRemoved} />
      ) : result.ok ? (
        <p className="adm-muted">No active version to compare with.</p>
      ) : null}
    </div>
  );
}
