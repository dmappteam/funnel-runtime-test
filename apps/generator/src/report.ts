import type { GroundTruth } from './groundTruth';
import type { IngestionCheck, IngestionLog, IngestionTotals } from './ingestion';
import type { MetricCheck } from './verify';
import type { SessionRecord, SessionStatus } from './virtualUser';

export interface LogEntry {
  at: string;
  kind: 'step' | 'info' | 'warn' | 'section';
  text: string;
}

/** Prints the run as it happens and keeps every line for the JSON report. */
export class Logger {
  readonly entries: LogEntry[] = [];
  private steps = 0;

  constructor(private readonly write: (line: string) => void) {}

  step(title: string): void {
    this.steps++;
    this.write('');
    this.emit('step', title, `[${this.steps}] ${title}`);
  }

  section(title: string): void {
    this.write('');
    this.emit('section', title, title);
  }

  info(text: string): void {
    this.emit('info', text, `    ${text}`);
  }

  warn(text: string): void {
    this.emit('warn', text, `    WARNING: ${text}`);
  }

  lines(lines: readonly string[]): void {
    for (const line of lines) this.info(line);
  }

  private emit(kind: LogEntry['kind'], text: string, printed: string): void {
    this.entries.push({ at: new Date().toISOString(), kind, text });
    this.write(printed);
  }
}

/** Columns that hold numbers are right-aligned, header included. */
export function table(rows: readonly (readonly (string | number)[])[]): string[] {
  const columns = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)));
  const numeric = Array.from({ length: columns }, (_, i) => rows.slice(1).some((r) => typeof r[i] === 'number'));
  return rows.map((row) =>
    row
      .map((cell, i) => (numeric[i] ? String(cell).padStart(widths[i]!) : String(cell).padEnd(widths[i]!)))
      .join('  ')
      .trimEnd(),
  );
}

export const okText = (ok: boolean) => (ok ? 'OK' : 'MISMATCH');

export function phaseSummary(records: readonly SessionRecord[]): string[] {
  const created = records.filter((r) => r.version !== null);
  const byVersion = new Map<number, SessionRecord[]>();
  for (const r of created) byVersion.set(r.version!, [...(byVersion.get(r.version!) ?? []), r]);
  const groups = [...byVersion.entries()]
    .sort(([a], [b]) => a - b)
    .map(([version, list]) => {
      const count = (filter: (r: SessionRecord) => boolean) => list.filter(filter).length;
      const variants = [...new Set(list.filter((r) => r.assignment !== 'override').map((r) => r.variant!))].sort();
      const parts = variants.map((v) => `${v} ${count((r) => r.variant === v && r.assignment !== 'override')}`);
      const overrides = count((r) => r.assignment === 'override');
      return `v${version}: ${parts.join(', ')}${overrides ? `, override ${overrides} (QA, outside the A/B)` : ''}`;
    });
  const status = (s: SessionStatus) => created.filter((r) => r.status === s).length;
  const count = (filter: (r: SessionRecord) => boolean) => created.filter(filter).length;
  return [
    groups.join(' · ') || 'no session was created',
    `reached the result ${count((r) => r.resultId !== null)}, clicked the CTA ${count((r) => r.ctaClicked)}, ` +
      `left early ${status('left')}, paused ${status('paused')}, failed ${status('failed')}`,
    `went back ${count((r) => r.backClicks > 0)} (switched work_mode ${count((r) => r.branchChanged)}), ` +
      `reloaded ${count((r) => r.refreshes > 0)}, corrected an invalid input ${count((r) => r.validationErrors > 0)}`,
  ];
}

export function groundTruthLines(truth: GroundTruth): string[] {
  const rows: (string | number)[][] = [['group', 'started', 'result', 'CTA', 'back', 'final results']];
  for (const g of truth.groups) {
    const results = Object.entries(g.results)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, n]) => `${id} ${n}`)
      .join(', ');
    rows.push([`v${g.version} ${g.variant}`, g.started, g.reachedResult, g.ctaClicked, g.backClicked, results || '-']);
  }
  const steps = truth.groups.map(
    (g) =>
      `v${g.version} ${g.variant}: ${Object.entries(g.reached)
        .map(([id, n]) => `${id} ${n}`)
        .join(' > ')}`,
  );
  return [...table(rows), 'reached per step:', ...steps];
}

export function eventLines(totals: IngestionTotals, log: IngestionLog, retries: number): string[] {
  const { batches } = log;
  return [
    `${totals.uniqueValid} unique valid events, ${totals.invalidEvents} deliberately invalid (unknown name or wrong property type)`,
    `${batches.sent} batch sends: ${batches.resent} re-sent with the identical payload (${totals.resentValid} valid events again), ` +
      `${batches.shuffled} shuffled, ${batches.heldBack} held back behind the next batch`,
    `${retries} HTTP retries after a network error or 5xx`,
  ];
}

export function ingestionLines(log: IngestionLog, checks: readonly IngestionCheck[]): string[] {
  const reasons = Object.entries(log.rejectedByReason)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ');
  const rows = checks.map((c) => [c.name, `expected ${c.expected}`, c.actual, okText(c.ok)]);
  return [
    `accepted ${log.responses.accepted}, duplicate ${log.responses.duplicate}, rejected ${log.responses.rejected}${reasons ? ` (${reasons})` : ''}`,
    ...table(rows),
    ...log.anomalies.map((a) => `unexpected: ${a}`),
  ];
}

/** One table per version: a row per metric, expected / actual / status per variant. */
export function verificationLines(checks: readonly MetricCheck[]): string[] {
  const lines: string[] = [];
  for (const version of [...new Set(checks.map((c) => c.version))].sort((a, b) => a - b)) {
    const forVersion = checks.filter((c) => c.version === version);
    const variants = [...new Set(forVersion.map((c) => c.variant))].sort();
    const metrics = [...new Set(forVersion.map((c) => c.metric))];
    const header: (string | number)[] = [`v${version}`];
    for (const v of variants) header.push(`${v} expected`, 'actual', '');
    const rows: (string | number)[][] = [header];
    for (const metric of metrics) {
      const row: (string | number)[] = [metric];
      for (const variant of variants) {
        const c = forVersion.find((x) => x.metric === metric && x.variant === variant);
        row.push(c?.expected ?? '-', c?.actual ?? '-', c ? okText(c.ok) : '');
      }
      rows.push(row);
    }
    lines.push(...table(rows));
  }
  return lines;
}

export interface SessionSummary {
  sessionId: string;
  version: number | null;
  variant: string | null;
  assignment: string | null;
  utmProfile: string;
  status: SessionStatus;
  lastStepId: string | null;
  resultId: string | null;
  ctaClicked: boolean;
  events: number;
  backClicks: number;
  refreshes: number;
  validationErrors: number;
  branchChanged: boolean;
  pausedAt: string | null;
  resumedOn: SessionRecord['resumedOn'];
  error: string | null;
}

export function sessionSummary(r: SessionRecord): SessionSummary {
  return {
    sessionId: r.sessionId,
    version: r.version,
    variant: r.variant,
    assignment: r.assignment,
    utmProfile: r.profile,
    status: r.status,
    lastStepId: r.lastStepId,
    resultId: r.resultId,
    ctaClicked: r.ctaClicked,
    events: r.events.length,
    backClicks: r.backClicks,
    refreshes: r.refreshes,
    validationErrors: r.validationErrors,
    branchChanged: r.branchChanged,
    pausedAt: r.pausedAt,
    resumedOn: r.resumedOn,
    error: r.error,
  };
}
