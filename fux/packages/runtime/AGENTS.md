# @fux/runtime — Agent Notes

Read the root `AGENTS.md` first.

## What belongs here

The data plane host for v0.0.1 — everything that touches plugin _code_:

- `supervisor.ts` — `Supervisor.start(graph, resolveModule)`: pre-flights
  protocol compatibility for every plugin in the graph (defense in depth on
  top of the registry check), starts plugins in graph order, rolls back
  started plugins (reverse order) on failure, exposes `StartedRuntime`
  (`call`, `callAsSystem`, `states`, `stop`). `stop()` is idempotent.
- `broker.ts` — `CapabilityBroker`: the security chokepoint. Lookup capability
  -> authorize caller (`consumes` must contain it; `system` bypasses) ->
  forward to provider host -> unwrap `IpcResponse` into errors.
- `in-process-host.ts` — `InProcessHost`: loads the module in the same Node
  process, injects `PluginContext`, enforces `provide()` stays inside the
  manifest's declared capabilities (`ProvideUndeclaredError`).
- `types.ts` — the plugin author-facing API: `FuxPluginModule`,
  `PluginContext`, `PluginHost`.
- `errors.ts` — `FuxRuntimeError` family with `E_*` codes + `retryable` flags.

## Security rules (do not weaken)

1. A plugin can only `call()` capabilities declared in its manifest `consumes`
   — enforced by the broker before dispatch. Test: "denies calls to undeclared
   capabilities".
2. A plugin can only `provide()` capabilities declared in its manifest
   `capabilities` — enforced at activation. Test: "rejects undeclared
   capability providers at activation".
3. Unknown callers get `UnknownCallerError`; requests to stopped hosts get
   `HostNotRunningError` (retryable).

## Execution modes

`worker` and `remote` manifests are valid protocol-wise but
`Supervisor.start` throws `UnsupportedExecutionModeError`. Adding them is a
major feature — sketch an ADR first (`docs/adr/`), then a new `PluginHost`
implementation; the broker must stay transport-agnostic.

## Change rules

- Handlers may be sync or async; hosts must await both.
- Plugin handler exceptions become `IpcInvocationError` wrapping
  `E_PLUGIN_ERROR`; never let them escape as raw `Error`.
- New host types implement the `PluginHost` interface (`types.ts`) exactly.

## Local verification

```
pnpm --filter @fux/runtime test
pnpm --filter @fux/runtime typecheck
```
