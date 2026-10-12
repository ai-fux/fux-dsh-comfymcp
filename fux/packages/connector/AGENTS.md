# @fux/connector — Agent Notes

Read the root `AGENTS.md` first. This package owns **the external-pathway
connector contract** (CR-04) and follows the additive/backwards-compatible policy
of ADR-0005. It is a _contract package_: it defines interfaces and events, never
a transport. Concrete transports (HTTP, MQ, WS, gRPC, …) belong to implementers.

## What belongs here

- `types.ts` — `ConnectorState`, `ConnectorKind`, `ConnectorMessage<T>`,
  `SendResult`, and the lifecycle/subscribe handler types.
- `errors.ts` — `ConnectorError` base + `DuplicateConnectorError`,
  `ConnectorNotFoundError`, `ConnectorStateError`.
- `events.ts` — the framework event contract: `CONNECTOR_EVENT` topic constants,
  the `ConnectorEvent` discriminated union, and `ConnectorEventSink`.
- `connector.ts` — the `Connector` interface (the contract implementers satisfy)
  and `ConnectorRegistry` (register/lookup/open/close + lifecycle/message bridge).
- `in-memory-connector.ts` — a pure in-process pub/sub **reference** connector
  proving the contract is implementable; it is not a real transport.

## Design rules (CR-04)

- **Contract, not transport.** Nothing in this package depends on a concrete
  wire protocol. A real connector implements `Connector`; the framework only
  orchestrates and surfaces events.
- **Additive only, S-level.** A product that never registers a connector is
  unchanged. `ConnectorRegistry` is a pure sidecar — no runtime default depends
  on it.
- **`send` never throws.** Failures are `SendResult.ok === false` (the
  implementation may also emit an `error` lifecycle event).
- **Events are the seam.** Lifecycle events (`open` / `close` / `error`) are
  bridged automatically on `register`; inbound message flow (`connector:message`)
  is bridged only via opt-in `bridgeMessages(...)`. Observers never break the
  connector dispatch.
- **Semantics belong to the implementation.** `ConnectorKind` is advisory
  metadata; you do not branch framework behavior on it.

## Change rules

- New errors extend `ConnectorError` with a unique `code` (add, never rename).
- New public functions need tests in `test/`: state machine transitions,
  send/subscribe delivery (incl. wildcard), registry add/dup/not-found, event
  bridging, bridge teardown, and error paths.

## Local verification

```
pnpm --filter @fux/connector test
pnpm --filter @fux/connector typecheck
```
