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
| 2026-10-08 13:45 | orchestrator | Contracts: engine (30 tests), contracts (3 tests), DB schema, skeletons. Commit `A1`. |
| 2026-10-08 13:50 | 4 tracks | Launched in parallel worktrees. All four died on a network error (ENOTFOUND) before committing anything; the empty worktrees were cleaned up. |
| 2026-10-08 16:40 | orchestrator | Relaunched the tracks with a new rule: commit after every working module, so an interruption keeps the progress. Stopped again a few minutes later because the session hit its usage limit; to be relaunched with the same briefs. |
