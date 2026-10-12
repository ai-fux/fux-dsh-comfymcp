# @fux/protocol — Agent Notes

Read the root `AGENTS.md` first. This package has the strictest change policy
in the repo.

## What belongs here

- Zod schemas + inferred types for: plugin manifests (`manifest.ts`),
  capabilities (`capability.ts`), IPC envelopes (`ipc.ts`), product
  definitions (`product.ts`), semver ranges (`semver.ts`).
- `FUX_PROTOCOL_VERSION` (`version.ts`) — currently `0.1.0`.
- Pure validation helpers (`parseManifest`, `parseProductDefinition`,
  `isProtocolCompatible`, `ipcOk`/`ipcFail`, `newRequestId`).

## What must NOT land here

- Any dependency on `@fux/core`, `@fux/runtime`, Node APIs, or the filesystem.
  This package must stay importable by browsers, workers, and any host.
- Business logic, plugins, hosts. Schemas and pure functions only.

## Change rules

- Schema changes are protocol changes: bump `FUX_PROTOCOL_VERSION` (patch for
  additive-optional, minor for new fields, major for removals/restrictions)
  and record the reason in the PR.
- Error codes in `IpcErrorCodeSchema` are a public contract; add, never rename.
- Every schema needs tests in `test/`: valid case, invalid case, boundary
  (e.g. 64-capability max, name regex limits).
- Keep validation messages actionable — they surface directly to plugin
  authors via `ProtocolError.issues`.

## Local verification

```
pnpm --filter @fux/protocol test
pnpm --filter @fux/protocol typecheck
```
