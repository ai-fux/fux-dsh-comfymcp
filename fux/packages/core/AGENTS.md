# @fux/core — Agent Notes

Read the root `AGENTS.md` first.

## What belongs here

The control plane — pure orchestration logic, no plugin hosting:

- `registry.ts` — `PluginRegistry`: manifest storage, duplicate detection.
- `resolver.ts` — `resolveProduct`: plugin selection, auto-include of
  transitive dependencies, topological order (deps **and** consumed
  capabilities both create edges), cycle/missing-provider detection.
- `lifecycle.ts` — `LifecycleManager`: legal state machine
  `registered -> starting -> started -> stopping -> stopped` (+ `broken`).
- `config.ts` — `extractDefaults` from JSON-schema-ish configSchema,
  `deepMerge`, `resolvePluginConfig` (product config wins over defaults).
- `events.ts` — `EventBus`: topic pub/sub; a failing handler is logged and
  isolated, never propagated to the emitter.
- `compose.ts` — `FuxCore` facade: `register()` + `compose(product)` ->
  `RuntimeGraph` (per-product cache keyed by serialized product + overrides).
- `graph.ts` — graph types + `CapabilityLookup` + `graphSummary` (pretty print).

## Design invariants

- Core never loads plugin code. It only sees manifests. The `ModuleResolver`
  callback lives in `@fux/runtime`.
- No I/O, no timers, no globals. Pure and deterministic so it can run in any
  host and be tested synchronously.
- Topological order must guarantee: dependencies before dependents, capability
  providers before consumers. If you touch `resolver.ts`, both edge types must
  be covered by tests.
- Compose cache: key is `JSON.stringify({product, overrides})` scoped per
  product id; a cache hit returns `{ ...result, cached: true }` — always a
  fresh wrapper object, never a shared mutable reference.

## Change rules

- New public APIs need JSDoc + tests + re-export from `src/index.ts`.
- `FuxCore` is the only class apps should need; push new features into it or a
  new module — avoid parallel facades.
- Keep errors in `src/errors.ts` with `E_*` codes matching existing style.

## Local verification

```
pnpm --filter @fux/core test
pnpm --filter @fux/core typecheck
```
