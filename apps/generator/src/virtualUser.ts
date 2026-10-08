import {
  getNextStepId,
  getPrevStepId,
  hasInput,
  resolveCurrentStepId,
  validateAnswer,
  type Answers,
  type InputStep,
  type ResolvedFunnel,
  type Step,
} from '@funnel/engine';
import {
  answerSubmitted,
  backClicked,
  ctaClicked,
  finalizeEvent,
  recommendationExpanded,
  resultViewed,
  stepCompleted,
  stepViewed,
  type Assignment,
  type ClientEvent,
  type EventContext,
  type EventDraft,
  type SessionResponse,
} from '@funnel/contracts';
import { FUNNEL_ID, UnreachableError, revConflictState, type ApiClient } from './api';
import { BEHAVIOUR, WORK_MODES, answerFor, ctaChance, invalidAttempt, leaveChance, type SessionPlan } from './behaviour';
import type { Outbox } from './outbox';
import type { Rng } from './random';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Client time of one session: starts within the last 7 days, 2–25 s between actions, never in the future. */
export class SessionClock {
  private t: number;

  constructor(
    private readonly rng: Rng,
    private readonly now: number,
  ) {
    // At least 3 hours back, so a paused session can come back later and still stay in the past.
    this.t = now - rng.int(3 * HOUR, 7 * DAY);
  }

  /** The next user action. */
  act(): void {
    this.t += this.rng.int(2 * SECOND, 25 * SECOND);
  }

  /** Timestamp of the next event within the current action. */
  stamp(): string {
    this.t += this.rng.int(20, 400);
    return new Date(this.t).toISOString();
  }

  /** The gap before a paused session comes back. */
  later(): void {
    this.t = Math.max(this.t, Math.min(this.t + this.rng.int(20 * MINUTE, 2 * HOUR), this.now - MINUTE));
  }
}

export type SessionStatus = 'new' | 'paused' | 'left' | 'completed' | 'failed';

/** What the simulation knows about one session. The ground truth is computed from these records only. */
export interface SessionRecord {
  index: number;
  sessionId: string;
  profile: string;
  requestedVariant: string | null;
  /** Pinned at creation; `null` if the session was never created. */
  version: number | null;
  variant: string | null;
  assignment: Assignment | null;
  /** Step order of the session's variant. */
  sequence: string[];
  status: SessionStatus;
  /** Step the user was on when the visit ended. */
  lastStepId: string | null;
  resultId: string | null;
  ctaClicked: boolean;
  /** Valid events in the order they happened. Broken ones live only in the ingestion log. */
  events: ClientEvent[];
  answers: Answers;
  backClicks: number;
  refreshes: number;
  validationErrors: number;
  branchChanged: boolean;
  stateSaves: number;
  pausedAt: string | null;
  /** What GET /api/sessions/:id returned when the session came back: pinned version, version of the served config, step shown. */
  resumedOn: { version: number; configVersion: number; stepId: string } | null;
  error: string | null;
}

export interface UserStreams {
  /** Behaviour decisions. */
  rng: Rng;
  clock: SessionClock;
  outbox: Outbox;
  newId: () => string;
}

export interface StartOptions {
  /** Step to pause on, chosen once the server has assigned the variant. Planned pauses never leave early. */
  pauseAt?: (funnel: ResolvedFunnel) => string | null;
}

/** Walks a funnel like the web runtime: same engine calls, same event builders, same order of events. */
export class VirtualUser {
  readonly record: SessionRecord;
  private funnel: ResolvedFunnel | null = null;
  private ctx: EventContext | null = null;
  private answers: Answers = {};
  private current = '';
  private rev = 0;
  private moves = 0;
  private dirty = false;
  private pauseAt: string | null = null;
  private refreshed = false;
  private wentBack = false;

  constructor(
    index: number,
    sessionId: string,
    readonly plan: SessionPlan,
    private readonly api: ApiClient,
    private readonly s: UserStreams,
  ) {
    this.record = {
      index,
      sessionId,
      profile: plan.profile.name,
      requestedVariant: plan.variantOverride,
      version: null,
      variant: null,
      assignment: null,
      sequence: [],
      status: 'new',
      lastStepId: null,
      resultId: null,
      ctaClicked: false,
      events: [],
      answers: this.answers,
      backClicks: 0,
      refreshes: 0,
      validationErrors: 0,
      branchChanged: false,
      stateSaves: 0,
      pausedAt: null,
      resumedOn: null,
      error: null,
    };
  }

  async start(options: StartOptions = {}): Promise<void> {
    await this.guard(async () => {
      const override = this.plan.variantOverride;
      const res = await this.api.createSession(FUNNEL_ID, this.record.sessionId, {
        utm: this.plan.profile.utm,
        ...(override ? { variant: override } : {}),
      });
      this.adopt(res);
      Object.assign(this.record, {
        version: res.session.funnelVersion,
        variant: res.session.variant,
        assignment: res.session.assignment,
        sequence: [...res.funnel.sequence],
      });
      this.pauseAt = options.pauseAt?.(res.funnel) ?? null;
      this.s.clock.act();
      this.show(resolveCurrentStepId(res.funnel, this.answers, res.state.currentStepId));
      await this.walk();
    });
  }

  /** Comes back to a paused session: the server, not the client, decides which version it runs. */
  async resume(options: { cta?: boolean } = {}): Promise<void> {
    await this.guard(async () => {
      const res = await this.api.getSession(this.record.sessionId);
      this.adopt(res);
      this.pauseAt = null;
      if (options.cta !== undefined) this.plan.cta = options.cta;
      const stepId = resolveCurrentStepId(res.funnel, this.answers, res.state.currentStepId);
      this.record.resumedOn = { version: res.session.funnelVersion, configVersion: res.funnel.version, stepId };
      this.s.clock.later();
      this.s.clock.act();
      this.show(stepId);
      await this.walk();
    });
  }

  private adopt(res: SessionResponse): void {
    this.funnel = res.funnel;
    this.ctx = { sessionId: res.session.sessionId, funnel: res.funnel, utm: res.session.utm };
    this.answers = { ...res.state.answers };
    this.record.answers = this.answers;
    this.rev = res.state.rev;
    this.dirty = false;
  }

  /** Records a failed visit instead of failing the run, except when the server is gone. Always flushes the outbox. */
  private async guard(visit: () => Promise<void>): Promise<void> {
    try {
      await visit();
    } catch (err) {
      this.fail(err);
    }
    try {
      await this.s.outbox.flush();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    if (err instanceof UnreachableError) throw err;
    this.record.status = 'failed';
    this.record.lastStepId = this.current || null;
    this.record.error ??= err instanceof Error ? err.message : String(err);
  }

  private async walk(): Promise<void> {
    const funnel = this.funnel!;
    for (;;) {
      await this.s.outbox.pump();
      const step = funnel.steps[this.current];
      if (!step) throw new Error(`Step "${this.current}" is not part of the session's funnel`);

      if (this.current === this.pauseAt) return this.pause();
      if (this.plan.refreshAtMove === this.moves && !this.refreshed && step.type !== 'result') await this.refresh();
      if (step.type === 'result') return this.finish(step.id);
      if (this.leaves(step.id)) return this.end('left');
      if (this.backDue(step.id)) {
        this.goBack();
        continue;
      }
      await this.forward(step);
    }
  }

  /** Info steps only show the next step. Questions emit answer_submitted and step_completed before it. */
  private async forward(step: Step): Promise<void> {
    this.s.clock.act();
    if (hasInput(step)) this.submit(step);
    const nextId = getNextStepId(this.funnel!, this.answers, step.id);
    if (!nextId) throw new Error(`No step after "${step.id}"`);
    if (hasInput(step)) this.emit(stepCompleted(step.id, nextId));
    this.moves++;
    this.show(nextId);
    if (hasInput(step) && this.s.rng.chance(BEHAVIOUR.saveStateChance)) await this.save();
  }

  private submit(step: InputStep): void {
    const name = step.input.name;
    if (this.s.rng.chance(BEHAVIOUR.invalidFirst[step.type] ?? 0) && invalidAttempt(step, this.s.rng) !== undefined) {
      this.record.validationErrors++;
    }
    const kept = this.answers[name];
    const value = kept !== undefined && validateAnswer(step, kept).ok ? kept : answerFor(step, this.plan.persona, this.answers);
    const check = validateAnswer(step, value);
    if (!check.ok) throw new Error(`Generated answer for "${step.id}" is invalid: ${check.message}`);
    this.answers[name] = check.value;
    this.emit(answerSubmitted(this.funnel!, step.id));
  }

  private leaves(stepId: string): boolean {
    if (this.pauseAt !== null || this.record.resumedOn !== null) return false;
    if (this.plan.leaveAt !== undefined) return this.plan.leaveAt === stepId;
    return this.s.rng.chance(leaveChance(this.funnel!, stepId, this.plan.profile.leaveFactor));
  }

  private backDue(stepId: string): boolean {
    const back = this.plan.back;
    if (!back || this.wentBack || this.pauseAt !== null) return false;
    if (back.kind === 'review') return this.moves >= back.atMove;
    return getPrevStepId(this.funnel!, this.answers, stepId) === 'work_mode';
  }

  private goBack(): void {
    const back = this.plan.back!;
    this.wentBack = true;
    const hops = back.kind === 'review' ? back.steps : 1;
    for (let i = 0; i < hops; i++) {
      const destination = getPrevStepId(this.funnel!, this.answers, this.current);
      if (!destination) break;
      this.s.clock.act();
      this.emit(backClicked(this.current, destination));
      this.record.backClicks++;
      this.show(destination);
    }
    if (back.kind === 'branch' && this.current === 'work_mode') {
      // The user changes their mind: the next submit of work_mode takes the new mode from the persona.
      const persona = this.plan.persona;
      persona.workMode = this.s.rng.pick(WORK_MODES.filter((mode) => mode !== persona.workMode));
      delete this.answers.work_mode;
      this.record.branchChanged = true;
    }
  }

  /** A page reload: the state is saved first, then the runtime renders the same step again. */
  private async refresh(): Promise<void> {
    this.refreshed = true;
    this.record.refreshes++;
    if (this.dirty) await this.save();
    this.s.clock.act();
    this.show(resolveCurrentStepId(this.funnel!, this.answers, this.current));
  }

  private async pause(): Promise<void> {
    await this.save();
    this.pauseAt = null;
    this.record.pausedAt = this.current;
    this.end('paused');
  }

  private async finish(resultStep: string): Promise<void> {
    const res = await this.api.submitResult(this.record.sessionId, { answers: this.answers });
    this.rev = res.state.rev;
    this.dirty = false;
    this.record.resultId = res.resultId;
    this.s.clock.act();
    this.emit(resultViewed(resultStep, res.resultId));
    if (this.plan.cta ?? this.s.rng.chance(ctaChance(this.funnel!.variant))) {
      this.s.clock.act();
      this.emit(ctaClicked(resultStep, res.resultId, res.result.cta.action));
      // Dropped by finalizeEvent for versions that do not allow it.
      this.emit(recommendationExpanded(resultStep, res.resultId, res.result.cta.action));
      this.record.ctaClicked = true;
    }
    this.end('completed');
  }

  private end(status: 'left' | 'paused' | 'completed'): void {
    this.record.status = status;
    this.record.lastStepId = this.current;
  }

  private async save(): Promise<void> {
    const body = { answers: this.answers, currentStepId: this.current, rev: this.rev };
    try {
      this.rev = (await this.api.saveState(this.record.sessionId, body)).state.rev;
    } catch (err) {
      // An unanswered earlier attempt may have bumped the rev. This tab is the only writer, so it wins.
      const server = revConflictState(err);
      if (!server) throw err;
      this.rev = (await this.api.saveState(this.record.sessionId, { ...body, rev: server.rev })).state.rev;
    }
    this.dirty = false;
    this.record.stateSaves++;
  }

  private show(stepId: string): void {
    this.current = stepId;
    this.dirty = true;
    this.emit(stepViewed(this.funnel!, this.answers, stepId));
  }

  private emit(draft: EventDraft): void {
    const event = finalizeEvent(draft, this.ctx!, this.s.newId(), this.s.clock.stamp());
    if (!event) return;
    this.record.events.push(event);
    this.s.outbox.push(event);
  }
}
