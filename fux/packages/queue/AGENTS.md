# @fux/queue — Agent Notes

Read the root `AGENTS.md` first. This package owns the **coordination /
scheduling abstraction** and follows the additive/backwards-compatible policy of
ADR-0005. It is a framework (CR-03): it gives the mechanism, never the policy.

## What belongs here

- `task.ts` — `Task<T>` (id, `run()`, optional `priority` / `group` / `meta`)
  and `PendingTaskInfo<T>` (task + monotonic `order` + `queuedAt`).
- `strategy.ts` — the `SchedulingStrategy<T>` contract and built-in `fifo`,
  `priority`, and `compose`. Strategies are **pure** and must not mutate the
  pending array they receive.
- `scheduler.ts` — `TaskScheduler<T>`: enforces the concurrency cap, group
  exclusivity, per-task timeout, `submit`/`drain`/`clear`/`close`, and a
  read-only `stats` + `on()` event channel.
- `errors.ts` — `QueueError` base + `DuplicateTaskError`,
  `TaskCancelledError`, `TaskTimeoutError`.

## Design rules (CR-03)

- **Mechanism, not policy.** The scheduler owns concurrency cap, group
  exclusivity, and timeout; ordering semantics live in the strategy. With no
  strategy and `concurrency = 1` the scheduler is a plain bounded sequential
  queue — the built-in default keeps old behavior.
- **Additive only.** A caller that never supplies a strategy / concurrency /
  timeout must see exactly the old one-task-at-a-time ordering.
- **Group exclusivity is structural.** Tasks sharing a non-empty `group` never
  run concurrently, regardless of the strategy's ordering.
- **`_pending` and `_pendingById` must stay in sync** whenever a task is
  started or cleared — dropping a task from only one of them breaks the pump
  (a started task must be removed from the `_pending` array, not just the map).
- Idle notification must fire on completion even when the scheduler is closed;
  `_notifyIdle()` lives outside the pump early-return so `close()`/`drain()`
  always settle.

## Change rules

- New errors extend `QueueError` with a unique `code` (add, never rename).
- New public functions need tests in `test/`: default FIFO, concurrency,
  priority, group exclusivity, custom strategy, duplicate detection, drain /
  clear, timeout, close, and events.

## Local verification

```
pnpm --filter @fux/queue test
pnpm --filter @fux/queue typecheck
```
