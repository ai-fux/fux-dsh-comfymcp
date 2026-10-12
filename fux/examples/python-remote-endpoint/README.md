# FUX Remote Endpoint — Python Reference (G-01)

A language-neutral reference implementation of the FUX remote wire protocol
([docs/remote-wire-protocol.md](../../docs/remote-wire-protocol.md)), written in
**Python 3.8+ standard library only** (no pip installs). It proves the remote
HTTP/JSON contract is implementable outside Node and serves as the peer for the
cross-language contract test in `packages/runtime/test/python-endpoint.contract.test.ts`.

## Run

```bash
# demo mode: serves demo:upper and demo:fail on an ephemeral port
python remote_endpoint.py --demo

# production-ish mode: custom identity, fixed port, python-loaded handlers
python remote_endpoint.py --port 3987 --node-id py-node-1 \
  --capability 'acct:balance=ledger:balance_handler'
```

The endpoint prints `READY url=<url> node=<nodeId>` once it is serving.

## Try it against the Node runtime

```ts
import { HttpRemoteTransport } from '@fux/runtime'

const transport = new HttpRemoteTransport({ url: 'http://127.0.0.1:<port>' })
await transport.open()
const reply = await transport.call({ id: 'r1', capability: 'demo:upper', payload: { text: 'abc' } })
// -> { id: 'r1', ok: true, result: 'ABC' }
```

`pnpm demo:cluster` shows the same transport wired through a `RemoteHost`;
point `SupervisorOptions.remoteNodes.urls` at this endpoint to exercise node
discovery + health handshake (G4) against the Python node.

## Routes

| Route | Method | Level | Behavior |
| ---- | ---- | ---- | ---- |
| `/capabilities` | GET | MUST | capability list |
| `/invoke` | POST | MUST | handler errors stay HTTP 200 as `E_PLUGIN_ERROR` |
| `/health` | GET | SHOULD | identity + `protocolVersion: 0.1.1` |
| `/events` | GET | SHOULD | SSE frames + ≤100-event replay + keep-alive comments |

Notes:
- Each settled invoke pushes a `demo:invoked` `IpcEvent` onto the SSE stream
  (advisory; replay-buffered for late subscribers).
- The demo endpoint is a reference, not a hardened service: it performs no
  authentication and executes the python callables you hand it. Run it on a
  trusted network.
