# Working with AI agents

The orchestrator is a Claude Code session. Implementation tracks run as parallel sub-agents, each in its own git worktree and branch. The orchestrator reviews every branch before merging.

## Decomposition

The order follows the dependency graph, not the feature list.

1. **Contracts first, sequential (orchestrator).** Everything else depends on these, so they are written and tested before any parallel work starts:
   - `packages/engine`: config schema, condition evaluation, path and progress, answer validation, result rules, publish-time config validation, version diff. 30 unit tests against the real v1/v2/v3 configs.
   - `packages/contracts`: HTTP API shapes, the event wire format, event builders shared by the web runtime and the traffic generator, analytics report types.
   - `apps/server/src/db/migrations.ts`: the SQLite schema.
   - Skeletons with fixed signatures: `buildApp()`, `aggregate()`, web pages, generator CLI.
2. **Four parallel tracks**, each touching only its own directories:

   | Track | Owns | Depends on |
   | --- | --- | --- |
   | Server | `apps/server` | engine, contracts, `aggregate()` signature |
   | Web runtime and admin | `apps/web/src/{funnel,admin,tracking,api}` | engine, contracts, HTTP API contract |
   | Analytics | `packages/analytics`, `apps/web/src/dashboard` | contracts (`AggregateInput`, `AnalyticsReport`) |
   | Generator | `apps/generator` | engine, contracts, HTTP API contract |

   Shared files (contracts, schema, root configs, lockfile) are read-only for the tracks. A track that needs a contract change reports it instead of making it.
3. **Integration and review (orchestrator).** Merge branch by branch, run the full test suite, review diffs against the invariants checklist below, run the generator against the real server, check the UI in a browser.

## Invariants checklist used in review

- Config is always taken from the session's pinned version, never from the active one.
- Events are validated against the pinned version's `events.allowed` (a v3 session keeps working after a rollback to v2).
- Version, variant, experiment and UTM of an event come from the session row, not from the client.
- `event_id` is the primary key, inserts use `ON CONFLICT DO NOTHING`, every event in a batch is validated separately.
- Session creation is idempotent (client-generated id), `session_started` is written by the server in the same transaction.
- Raw answers never reach the events table.
- Aggregates count distinct sessions, take step positions from the config and do not depend on arrival order.
- Overridden (`?variant=`) sessions are excluded from the A/B comparison by default.
- No schema change is needed for a new event, step, operator or result.

## Log

| When | Who | What |
| --- | --- | --- |
| 2026-10-08 13:23 | orchestrator | Analysed the assignment and the three configs, wrote the plan. |
| 2026-10-08 13:40 | orchestrator | Contracts: engine (30 tests), contracts (3 tests), DB schema, skeletons. Commit `A1`. |
| 2026-10-08 13:50 | 4 tracks | Launched in parallel worktrees. All four died on a network error (ENOTFOUND) before committing anything; the empty worktrees were cleaned up. |
| 2026-10-08 16:40 | orchestrator | Relaunched the tracks with a new rule: commit after every working module, so an interruption keeps the progress. Stopped a few minutes later because the session hit its usage limit. |
| 2026-10-08 16:52 | 4 tracks | Relaunched with unchanged briefs. |
| 2026-10-08 17:15 | server track | Finished: 68 tests, 1 skipped until the analytics merge. Reported 7 deviations and a CSRF risk it did not fix. |
| 2026-10-08 17:16 | orchestrator | Review of the server track against the checklist: accepted all 7 deviations, merged. |
| 2026-10-08 17:20 | 3 tracks | Stopped by the usage limit, resumed with their context and worktrees; allowed to merge `main` to test against the real server on separate ports. |
| 2026-10-08 17:27 | orchestrator | Fixed the risk the server track reported: mutating requests to internal endpoints with `Sec-Fetch-Site` other than same-origin get 403 (browsers attach cached Basic auth to cross-site requests). Patched a critical advisory in a dev dependency (`shell-quote` via `concurrently`). |
| 2026-10-08 17:30 | orchestrator | First deploy to Hostinger while the tracks work, to de-risk the platform early: the Hostinger GitHub app has no access to the repository, so deploys go as a `git archive` zip. Verified SQLite writes, Basic auth behind the proxy, cache headers, and that the database survives a redeploy. |
| 2026-10-08 17:31 | analytics track | Finished: `aggregate()` over per-session sets and maxima, statistics, dashboard, the unskipped route test; 141 tests. Load-tested 263k events in ~220 ms. |
| 2026-10-08 17:33 | orchestrator | Review of the analytics track, merged. Fixed one finding the track itself flagged: a session that left while the result was loading counted neither as a drop-off nor as reaching the result, so the funnel did not add up. It is now a drop-off at the result step, with a test that drop-offs plus results equal sessions that reached the first step. |
| 2026-10-08 17:38 | generator track | Finished: virtual users on the shared engine and event builders, transport chaos, ground truth from its own records, verification against the analytics API, scenarios `generate`, `demo`, `iteration2`; 28 tests; ran all scenarios against the real server. |
| 2026-10-08 17:40 | orchestrator | Review of the generator track (ground truth independent of `@funnel/analytics`, same event order as the runtime), merged. End-to-end on a production build with a fresh database: `demo` 60/60 checks (4,705 events accepted, 436 duplicates, 61 rejected with reasons, 50 dashboard metrics equal to the ground truth, 24/24 paused v1 sessions finished on v1 after v2 was published), then `iteration2` 69/69 (v2 sessions finish on v2 after v3 is published, v3 sessions keep working after the rollback and their `recommendation_expanded` is accepted). Checked the dashboard in a browser; pinned number formatting to en-AU because a Russian browser locale mixed "60,9 %" into the English UI. |
| 2026-10-08 17:45 | web track | Finished: funnel runtime, tracker, admin; 35 tests. Found and fixed a race on the real server: the result request also bumps `rev`, so it now goes through the state-save queue. |
| 2026-10-08 17:46 | orchestrator | Review of the web track (all funnel logic from the engine, one `step_viewed` per view under StrictMode, persistent outbox), merged: 206 tests. Walked both variants in a browser: auto-advance, validation messages from the config, progress shrinking from 8 to 7 when a branch closes, refresh and Back keep state, multi-select limit, result with the variant B override, CTA expanding the recommendations, dark mode. Checked the stored event trail of that session. Fixed admin date formatting and the layout of config errors on narrow screens. |
| 2026-10-08 17:55 | orchestrator | Production on a fresh database: `demo` (publish v2) 59/60, the only miss was one outside visitor during the run; `iteration2` (publish v3, verify, roll back) 69/69. |
| 2026-10-08 18:20 | 12 reviewers | Code review of the whole repository at max effort: line-by-line scans per area, removed-behaviour audit, cross-file contract tracing, language pitfalls, wrappers and queues, reuse, simplification, efficiency, altitude. 15 findings survived verification, most in config validation, state sync and the generator. |
| 2026-10-08 18:50 | orchestrator + 2 tracks | Fixes: engine and contracts by the orchestrator (variant overrides validated like base steps, conditional result step rejected, own-key lookups, API length limits, TTL cap, empty includeOverrides); web and server/generator by two agents in worktrees, one commit and one failing-before regression test per finding. Lesson: for small fixes in familiar code the agents cold start (npm ci, reading the code) costs more than parallelism saves, so such fixes are done in the main session next time. |
| 2026-10-08 19:15 | orchestrator | Reviewed and merged both branches, plus follow-ups (migration 2 also removes old duplicate dead letters, Vite dev proxy forwards the host). 245 tests. Production redeployed on the same database: dead letters deduplicated (112 to 105), all versions intact, a cross-site rollback gets 403. |
| 2026-10-08 21:25 | orchestrator | Number question: the input is as wide as its digits and sits next to its unit, singular unit for 1, unit kept on the baseline after trying it centred. |
| 2026-10-08 22:40 | orchestrator | Extras beyond the assignment, done in the main session without agents (small changes in familiar code): previews of stored versions (migration 3 rebuilds `sessions` for the `preview` assignment and the `demo` flag), sample ratio mismatch check and experiment ETA, demo data buttons running the generator in-process through `app.inject`, English and Russian admin and dashboard, GitHub Actions CI. Caught in a browser check: right after generating demo data the ETA extrapolated 200 sessions from 0.3 s to millions a day, so rates are now averaged over at least a day. 268 tests. |
