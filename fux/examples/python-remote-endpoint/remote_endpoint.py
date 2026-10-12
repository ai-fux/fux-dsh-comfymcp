#!/usr/bin/env python3
"""FUX remote wire protocol — Python reference endpoint (stdlib only).

Implements the language-neutral HTTP/JSON contract documented in
`docs/remote-wire-protocol.md` so a FUX runtime (e.g. the Node reference
`HttpRemoteTransport` / `HttpNodeHealthProbe`) can execute capabilities on
this process as a `remote` execution host.

Routes (protocol v1):
    GET  /capabilities -> {"capabilities": [..]}
    POST /invoke       -> RemoteCallRequest in, IpcResponse out (HTTP 200)
    GET  /health       -> {nodeId, status, capabilities, uptimeMs, protocolVersion}
    GET  /events       -> SSE stream: `data: <IpcEvent JSON>` frames, <=100 replay

No third-party dependencies: Python 3.8+ standard library only.

Usage:
    python remote_endpoint.py --demo
    python remote_endpoint.py --port 3987 --node-id py-node-1 \
        --capability 'acct:balance=ledger:balance_handler'

The endpoint prints `READY url=<url> node=<nodeId>` on stdout once it is
serving — orchestrators and tests wait for that line.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSION = "0.1.1"
MAX_REPLAY = 100
KEEPALIVE_SECONDS = 1.0


# ---------------------------------------------------------------------------
# Endpoint state
# ---------------------------------------------------------------------------


class EndpointState:
    """Shared, thread-safe state: handlers, capability list, SSE clients."""

    def __init__(self, node_id: str, capabilities: list[str], handlers: dict) -> None:
        self.node_id = node_id
        self.capabilities = capabilities
        self.handlers = handlers  # capability name -> callable(payload) -> result
        self.started_at = time.time()
        self.stopped = False
        self.replay: deque[dict] = deque(maxlen=MAX_REPLAY)
        self.clients: set = set()
        self.lock = threading.Lock()

    def push_event(self, event: dict) -> None:
        """Append to the replay buffer and fan out to every SSE client."""
        frame = f"data: {json.dumps(event)}\n\n".encode("utf-8")
        with self.lock:
            self.replay.append(event)
            dead = []
            for client in self.clients:
                try:
                    client.write(frame)
                    client.flush()
                except Exception:
                    dead.append(client)
            for client in dead:
                self.clients.discard(client)


# ---------------------------------------------------------------------------
# Demo capability handlers (--demo)
# ---------------------------------------------------------------------------


def demo_upper(payload):
    """demo:upper — payload {"text": string} -> uppercase text."""
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        raise ValueError('payload must be {"text": string}')
    return payload["text"].upper()


def demo_fail(_payload):
    """demo:fail — always raises (maps to E_PLUGIN_ERROR)."""
    raise RuntimeError("demo failure requested")


# ---------------------------------------------------------------------------
# Invoke dispatch (mirrors the wire spec's error semantics)
# ---------------------------------------------------------------------------


def handle_invoke(state: EndpointState, body: dict) -> dict:
    req_id = body.get("id") if isinstance(body.get("id"), str) else "req-unknown"
    capability = body.get("capability") if isinstance(body.get("capability"), str) else ""
    handler = state.handlers.get(capability)
    if handler is None:
        return {
            "id": req_id,
            "ok": False,
            "error": {
                "code": "E_CAPABILITY_NOT_FOUND",
                "message": f'capability "{capability}" is not served by this node',
                "retryable": False,
            },
        }
    try:
        result = handler(body.get("payload"))
        response = (
            {"id": req_id, "ok": True, "result": result}
            if result is not None
            else {"id": req_id, "ok": True}
        )
    except Exception as error:  # business-level failure stays HTTP 200
        response = {
            "id": req_id,
            "ok": False,
            "error": {
                "code": "E_PLUGIN_ERROR",
                "message": str(error) or error.__class__.__name__,
                "retryable": False,
            },
        }
    # Advisory event: one per settled invoke (best-effort, replay-buffered).
    state.push_event(
        {
            "topic": "demo:invoked",
            "payload": {"capability": capability, "ok": response["ok"]},
            "source": state.node_id,
            "occurredAt": int(time.time() * 1000),
            "schemaVersion": 1,
        }
    )
    return response


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


def make_handler(state: EndpointState) -> type[BaseHTTPRequestHandler]:
    class EndpointHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "fux-python-endpoint/1.0"

        def log_message(self, format: str, *args) -> None:  # noqa: A002
            pass  # keep stdout clean for the READY line / CI logs

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]
            if path == "/capabilities":
                self._send_json(200, {"capabilities": self.state.capabilities})
            elif path == "/health":
                self._send_json(
                    200,
                    {
                        "nodeId": self.state.node_id,
                        "status": "ok",
                        "capabilities": self.state.capabilities,
                        "uptimeMs": int((time.time() - self.state.started_at) * 1000),
                        "protocolVersion": PROTOCOL_VERSION,
                    },
                )
            elif path == "/events":
                self._handle_events()
            else:
                self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]
            if path != "/invoke":
                self._send_json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length > 0 else b""
                body = json.loads(raw.decode("utf-8")) if raw else {}
                if not isinstance(body, dict):
                    body = {}
            except Exception as error:
                # transport-level failure: HTTP 500 + req-unknown envelope
                self._send_json(
                    500,
                    {
                        "id": "req-unknown",
                        "ok": False,
                        "error": {
                            "code": "E_INTERNAL",
                            "message": f"invalid JSON body: {error}",
                        },
                    },
                )
                return
            self._send_json(200, handle_invoke(self.state, body))

        def _handle_events(self) -> None:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "keep-alive")
            self.end_headers()
            wfile = self.wfile
            with self.state.lock:
                for event in list(self.state.replay):
                    wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
                self.state.clients.add(wfile)
            try:
                # Hold the stream open; periodic comment keep-alives also
                # surface client disconnects (the Node reference client ignores
                # lines that are not `data: ` frames).
                while not self.state.stopped:
                    time.sleep(KEEPALIVE_SECONDS)
                    wfile.write(b": keep-alive\n\n")
                    wfile.flush()
            except Exception:
                pass
            finally:
                with self.state.lock:
                    self.state.clients.discard(wfile)

    # Request methods read the shared state via `self.state` — bind the closure
    # variable as a class attribute (assigned after the class body to avoid
    # class-scope name shadowing pitfalls).
    EndpointHandler.state = state
    return EndpointHandler


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def load_handler(spec: str):
    """Resolve `module:attr` into a payload->result callable."""
    module_name, _, attr = spec.partition(":")
    if not module_name or not attr:
        raise SystemExit(f"invalid --capability target {spec!r} (expected module:attr)")
    module = importlib.import_module(module_name)
    handler = getattr(module, attr)
    if not callable(handler):
        raise SystemExit(f"--capability target {spec!r} is not callable")
    return handler


def main() -> int:
    parser = argparse.ArgumentParser(description="FUX remote wire protocol endpoint (Python)")
    parser.add_argument("--host", default="127.0.0.1", help="bind host (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=0, help="bind port (default: ephemeral)")
    parser.add_argument("--node-id", default=None, help="stable node identity (default: endpoint url)")
    parser.add_argument(
        "--capability",
        action="append",
        default=[],
        metavar="DOMAIN:ACTION=module:attr",
        help="serve a capability from a python callable (repeatable)",
    )
    parser.add_argument("--demo", action="store_true", help="serve demo:upper / demo:fail")
    args = parser.parse_args()

    handlers: dict = {}
    if args.demo:
        handlers["demo:upper"] = demo_upper
        handlers["demo:fail"] = demo_fail
    for spec in args.capability:
        name, _, target = spec.partition("=")
        if not name or not target:
            raise SystemExit(f"invalid --capability {spec!r} (expected domain:action=module:attr)")
        handlers[name] = load_handler(target)

    state = EndpointState("", [], {})
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    server.daemon_threads = True
    host = args.host
    port = server.server_address[1]
    url = f"http://{host}:{port}"
    node_id = args.node_id or url
    # Identity (and therefore capabilities routing) is only final once the port
    # is bound — mutate the shared state in place; handlers read it per request.
    state.node_id = node_id
    state.capabilities = sorted(handlers)
    state.handlers = handlers

    print(f"READY url={url} node={node_id}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        state.stopped = True
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
