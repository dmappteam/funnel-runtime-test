import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { ValidateConfigResponse } from '@funnel/contracts';
import { FunnelConfigSchema, operatorsUsed } from '@funnel/engine';
import { createVersion, publishVersion, validateConfigText } from '../api/admin';
import { Callout, IssueList, type Notice } from './Callout';
import type { ConfirmOptions } from './ConfirmDialog';
import { DiffView } from './DiffView';
import { useI18n } from '../internal/i18n';
import type { Messages } from '../internal/en';
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

function parseJson(text: string, fallback = 'Invalid JSON'): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : fallback };
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
  const { t } = useI18n();
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
    const parsed = parseJson(text, t.publish.invalidJson);
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
      setNotice({ tone: 'danger', ...describeError(err, t) });
    } finally {
      setBusy(null);
    }
  };

  const save = async (publish: boolean) => {
    if (!canSave || result.version === null) return;
    const version = result.version;
    if (publish) {
      const confirmed = await confirm({
        title: t.publish.confirmTitle(version),
        body: <p>{t.admin.publishBody(version)}</p>,
        confirmLabel: t.admin.publishLabel(version),
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
          title: published.previousVersion === published.activeVersion ? t.publish.alreadyActive(saved.version) : t.admin.nowActive(saved.version),
          detail: saved.created ? t.publish.storedAndPublished : t.publish.identicalPublished,
        });
      } else {
        setNotice({
          tone: 'success',
          title: saved.created ? t.publish.savedDraft(saved.version) : t.publish.alreadyStored(saved.version),
          detail: t.publish.publishLater,
        });
      }
      // The version status has changed (new → identical): validate again before the next save.
      setChecked(null);
    } catch (err) {
      setNotice({ tone: 'danger', ...describeError(err, t) });
    } finally {
      setBusy(null);
      await onChanged();
    }
  };

  return (
    <section className="card adm-card" aria-labelledby="adm-publish-title">
      <div className="adm-card-head">
        <h2 id="adm-publish-title">{t.publish.title}</h2>
        <div className="adm-toolbar">
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={onFileChosen} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInput.current?.click()}>
            {t.publish.chooseFile}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={activeText === null}
            onClick={() => activeText !== null && replaceText(activeText, null)}
          >
            {activeVersion === null ? t.publish.startFromActive : t.publish.startFrom(activeVersion)}
          </button>
        </div>
      </div>
      <p className="adm-hint" id="adm-config-hint">
        {t.publish.hint}
      </p>

      <label className="adm-label" htmlFor="adm-config">
        {t.publish.configLabel}{fileName ? <span className="adm-muted"> · {fileName}</span> : null}
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
          {t.publish.invalidJsonError(syntaxError)}
        </p>
      ) : null}

      <div className="adm-toolbar adm-publish-actions">
        <button type="button" className="btn btn-sm" disabled={!text.trim() || busy !== null} onClick={validate}>
          {busy === 'validate' ? t.publish.validating : t.publish.validate}
        </button>
        <span className="adm-spacer" />
        <button type="button" className="btn btn-secondary btn-sm" disabled={!canSave} onClick={() => save(false)}>
          {busy === 'save' ? t.publish.saving : t.publish.saveDraft}
        </button>
        <button type="button" className="btn btn-sm" disabled={!canSave} onClick={() => save(true)}>
          {busy === 'publish' ? t.publish.publishing : t.publish.saveAndPublish}
        </button>
      </div>
      {outdated ? <p className="adm-hint">{t.publish.outdated}</p> : null}

      {result ? <ValidationReport result={result} operatorsRemoved={operatorsRemoved} t={t} /> : null}
      {notice ? <Callout notice={notice} onDismiss={() => setNotice(null)} /> : null}
    </section>
  );
}

function ValidationReport({ result, operatorsRemoved, t }: { result: ValidateConfigResponse; operatorsRemoved: string[]; t: Messages }) {
  const { errors, warnings, version, versionStatus, diff } = result;
  return (
    <div className="adm-report" aria-live="polite">
      <div className="adm-report-summary">
        {result.ok ? (
          <span className="badge badge-success">{t.publish.valid}</span>
        ) : (
          <span className="badge badge-danger">{t.publish.errorCount(errors.length)}</span>
        )}
        {warnings.length > 0 ? (
          <span className="badge badge-warning">{t.publish.warningCount(warnings.length)}</span>
        ) : null}
        {version !== null && versionStatus === 'new' ? <span className="adm-muted">{t.publish.newVersion(version)}</span> : null}
        {version !== null && versionStatus === 'identical' ? (
          <span className="adm-muted">{t.publish.identical(version)}</span>
        ) : null}
      </div>
      {version !== null && versionStatus === 'conflict' ? (
        <p className="adm-error-text">{t.publish.conflict(version)}</p>
      ) : null}
      {errors.length > 0 ? <IssueList issues={errors} tone="error" /> : null}
      {warnings.length > 0 ? <IssueList issues={warnings} tone="warning" /> : null}
      {diff ? (
        <DiffView diff={diff} operatorsRemoved={operatorsRemoved} />
      ) : result.ok ? (
        <p className="adm-muted">{t.publish.nothingToCompare}</p>
      ) : null}
    </div>
  );
}
