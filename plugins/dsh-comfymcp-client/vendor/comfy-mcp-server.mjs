// src/main.ts
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/server.ts
import { createServer } from "node:http";
import { randomUUID as randomUUID3 } from "node:crypto";
import { createReadStream as createReadStream2, statSync as statSync2 } from "node:fs";

// src/artifacts-store.ts
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
var CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8"
};
function contentTypeFor(filename) {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}
function kindFromFilename(filename) {
  const ext = extname(filename).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".flac", ".ogg", ".m4a"].includes(ext)) return "audio";
  return "file";
}
var ArtifactStore = class {
  entries = /* @__PURE__ */ new Map();
  /** Register one on-disk file; missing files are skipped, not fatal. */
  register(path, filename) {
    try {
      const stats = statSync(path);
      if (!stats.isFile()) return void 0;
      const name = filename ?? path.replaceAll("\\", "/").split("/").pop() ?? "artifact";
      const entry = {
        id: randomUUID(),
        filename: name,
        kind: kindFromFilename(name),
        bytes: stats.size,
        path
      };
      this.entries.set(entry.id, entry);
      return entry;
    } catch {
      return void 0;
    }
  }
  get(id) {
    return this.entries.get(id);
  }
  get size() {
    return this.entries.size;
  }
  list() {
    return [...this.entries.values()];
  }
};

// src/config.ts
import { tmpdir } from "node:os";
import { resolve } from "node:path";
function asString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function asPort(value, fallback) {
  if (value === void 0 || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback;
}
function resolveServerConfig(env = process.env) {
  const backendKind = asString(env["COMFY_MCP_BACKEND"], "stdio") === "mock" ? "mock" : "stdio";
  const argsEnv = asString(env["COMFY_MCP_BACKEND_ARGS"], "");
  return {
    port: asPort(env["COMFY_MCP_SERVER_PORT"], 18800),
    host: asString(env["COMFY_MCP_SERVER_HOST"], "127.0.0.1"),
    path: asString(env["COMFY_MCP_SERVER_PATH"], "/mcp"),
    backendKind,
    backendCommand: asString(env["COMFY_MCP_BACKEND_CMD"], "node"),
    backendArgs: argsEnv.length > 0 ? argsEnv.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0) : [],
    callTimeoutMs: asNumber(env["COMFY_MCP_CALL_TIMEOUT_MS"], 3e5),
    requestTimeoutMs: asNumber(env["COMFY_MCP_TIMEOUT_MS"], 3e4),
    maxArtifactsPerResult: asNumber(env["COMFY_MCP_MAX_ARTIFACTS"], 50),
    serverName: "comfy-mcp-server",
    serverVersion: "0.1.0",
    instructions: "comfy-mcp reference service. Tools follow the ComfyUI MCP contract (server_info, node_search, run_workflow, fetch_outputs, ...). File-producing tools attach artifacts[] with resolvable url fields; GET {base}{url} streams the bytes."
  };
}
function mockStageDir(env = process.env) {
  return resolve(asString(env["COMFY_MCP_MOCK_STAGE_DIR"], resolve(tmpdir(), "comfy-mcp-mock-stage")));
}

// src/mock-backend.ts
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { join } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
var MOCK_TOOLS = [
  { name: "server_info", description: "mock snapshot", inputSchema: { type: "object" } },
  { name: "node_search", description: "mock node search", inputSchema: { type: "object" } },
  { name: "node_info", description: "mock node info", inputSchema: { type: "object" } },
  { name: "list_models", description: "mock model list", inputSchema: { type: "object" } },
  { name: "list_workflows", description: "mock workflow list", inputSchema: { type: "object" } },
  { name: "get_workflow", description: "mock workflow read", inputSchema: { type: "object" } },
  { name: "save_workflow", description: "mock workflow save", inputSchema: { type: "object" } },
  { name: "build_workflow", description: "mock graph build", inputSchema: { type: "object" } },
  { name: "validate_workflow", description: "mock validation", inputSchema: { type: "object" } },
  { name: "run_workflow", description: "mock run: writes an artifact and returns files[]", inputSchema: { type: "object" } },
  { name: "fetch_outputs", description: "mock outputs fetch", inputSchema: { type: "object" } },
  { name: "list_artifacts", description: "mock gallery", inputSchema: { type: "object" } },
  { name: "echo", description: "echo arguments back", inputSchema: { type: "object" } }
];
var MockBackend = class {
  kind = "mock";
  stageDir;
  workflows = /* @__PURE__ */ new Map();
  constructor(stageDir) {
    this.stageDir = stageDir ?? join(tmpdir2(), "comfy-mcp-mock-stage");
  }
  async listTools() {
    return MOCK_TOOLS;
  }
  async callTool(name, args) {
    const payload = args ?? {};
    const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
    switch (name) {
      case "echo":
        return text({ echoed: payload });
      case "server_info":
        return text({
          reachable: true,
          version: "mock-0.1.0",
          system: { comfyui_version: "0.3.51-mock", python_version: "3.12.mock", device_name: "MockGPU" },
          queue: { running: 0, pending: 0 }
        });
      case "node_search":
        return text({
          query: payload["query"] ?? "",
          total: 2,
          nodes: [
            { classType: "UnloadAllModels", displayName: "Unload All Models", category: "Unload Model", outputNode: false },
            { classType: "UnloadModel", displayName: "Unload Model", category: "Unload Model", outputNode: false }
          ]
        });
      case "node_info": {
        const requested = Array.isArray(payload["classTypes"]) ? payload["classTypes"].map((entry) => String(entry)) : [];
        const nodes = {};
        for (const classType of requested) {
          if (classType !== "KSampler") continue;
          nodes[classType] = {
            classType,
            displayName: classType,
            category: "model/sampling",
            inputs: [
              { name: "seed", group: "required", type: "INT", required: true, default: 0, min: 0, max: 2 ** 32 },
              { name: "steps", group: "required", type: "INT", required: true, default: 20, min: 1, max: 100 },
              { name: "cfg", group: "required", type: "FLOAT", required: true, default: 8, min: 0, max: 20 }
            ]
          };
        }
        return text({ missing: requested.filter((name2) => nodes[name2] === void 0), nodes });
      }
      case "list_models":
        return text({ types: { checkpoints: ["mock.safetensors"], total: 1 } });
      case "list_workflows":
        return text({
          total: this.workflows.size,
          workflows: [...this.workflows.entries()].map(([id, entry]) => ({ id, name: entry.name, subdir: entry.subdir }))
        });
      case "get_workflow":
        return text({
          id: String(payload["id"] ?? ""),
          graph: { "1": { class_type: "KSampler", inputs: { seed: 42, steps: 20 } } }
        });
      case "save_workflow": {
        const id = randomUUID2();
        this.workflows.set(id, {
          name: String(payload["name"] ?? "workflow"),
          subdir: String(payload["subdir"] ?? ""),
          graph: payload["graph"]
        });
        return text({ ok: true, id, subdir: String(payload["subdir"] ?? "") });
      }
      case "build_workflow":
        return text({
          graph: {
            "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20, cfg: 8 } },
            "9": { class_type: "SaveImage", inputs: { filename_prefix: "mock" } }
          },
          warnings: []
        });
      case "validate_workflow":
        return text({ valid: true, errors: [], warnings: [] });
      case "run_workflow":
      case "fetch_outputs": {
        await mkdir(this.stageDir, { recursive: true });
        const filename = `mock_${randomUUID2().slice(0, 8)}.png`;
        const target = join(this.stageDir, filename);
        await writeFile(target, TINY_PNG);
        return text({
          ...name === "run_workflow" ? { promptId: randomUUID2(), state: "completed" } : {},
          files: [{ path: target, filename, bytes: TINY_PNG.length, kind: "image" }]
        });
      }
      case "list_artifacts":
        return text({ files: [], total: 0 });
      default:
        return { content: [{ type: "text", text: `mock backend does not implement ${name}` }], isError: true };
    }
  }
  async stop() {
  }
};

// src/backend.ts
import { spawn } from "node:child_process";
var BackendError = class extends Error {
  code;
  constructor(message, code = "E_BACKEND") {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
};
var StdioBackend = class {
  kind = "stdio";
  command;
  args;
  extraEnv;
  requestTimeoutMs;
  maxRestarts;
  logger;
  child = null;
  nextId = 1;
  buffer = "";
  pending = /* @__PURE__ */ new Map();
  starting = null;
  restarts = 0;
  stopped = false;
  toolsCache = null;
  toolsCachedAt = 0;
  constructor(options) {
    this.command = options.command;
    this.args = [...options.args ?? []];
    this.extraEnv = { ...options.env ?? {} };
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3e5;
    this.maxRestarts = options.maxRestarts ?? 3;
    this.logger = options.logger ?? { error: () => {
    } };
  }
  status() {
    return {
      kind: this.kind,
      command: [this.command, ...this.args].join(" "),
      running: this.child !== null && this.child.exitCode === null,
      restarts: this.restarts,
      tools: this.toolsCache?.length ?? 0
    };
  }
  async listTools() {
    if (this.toolsCache !== null && Date.now() - this.toolsCachedAt < 6e4) return this.toolsCache;
    const result = await this.request("tools/list", {});
    const tools = result["tools"];
    this.toolsCache = Array.isArray(tools) ? tools.filter((tool) => typeof tool === "object" && tool !== null).map((tool) => ({
      name: String(tool["name"] ?? ""),
      ...typeof tool["description"] === "string" ? { description: tool["description"] } : {},
      ...typeof tool["inputSchema"] === "object" && tool["inputSchema"] !== null ? { inputSchema: tool["inputSchema"] } : {}
    })).filter((tool) => tool.name.length > 0) : [];
    this.toolsCachedAt = Date.now();
    return this.toolsCache;
  }
  async callTool(name, args) {
    this.toolsCache = null;
    const result = await this.request("tools/call", {
      name,
      ...args === void 0 ? {} : { arguments: args }
    });
    return {
      content: Array.isArray(result["content"]) ? result["content"] : [],
      ...typeof result["structuredContent"] === "object" && result["structuredContent"] !== null ? { structuredContent: result["structuredContent"] } : {},
      isError: result["isError"] === true
    };
  }
  async stop() {
    this.stopped = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BackendError("backend stopped", "E_BACKEND_STOPPED"));
    }
    this.pending = /* @__PURE__ */ new Map();
    const child = this.child;
    this.child = null;
    if (child !== null && child.exitCode === null) {
      try {
        child.kill();
      } catch {
      }
    }
  }
  /** One JSON-RPC request with a crash-restart retry. */
  async request(method, params) {
    await this.ensureStarted();
    try {
      return await this.rawRequest(method, params);
    } catch (error) {
      if (error instanceof BackendError && (error.code === "E_BACKEND_DOWN" || error.code === "E_BACKEND_STOPPED")) {
        this.killChild();
        await this.ensureStarted();
        return await this.rawRequest(method, params);
      }
      throw error;
    }
  }
  async rawRequest(method, params) {
    const child = this.child;
    if (child === null || child.stdin === null) throw new BackendError("backend is not running", "E_BACKEND_DOWN");
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}
`;
    return new Promise((resolve3, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BackendError(`backend request ${method} timed out after ${this.requestTimeoutMs}ms`, "E_BACKEND_TIMEOUT"));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve3(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer
      });
      child.stdin.write(payload);
    });
  }
  async ensureStarted() {
    if (this.stopped) throw new BackendError("backend is stopped", "E_BACKEND_STOPPED");
    if (this.child !== null && this.child.exitCode === null) return;
    if (this.starting === null) {
      this.starting = (async () => {
        await this.spawnChild();
        await this.handshake();
      })().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }
  /** MCP initialize + initialized-notification against the child. */
  async handshake() {
    const child = this.child;
    if (child === null || child.stdin === null) throw new BackendError("backend is not running", "E_BACKEND_DOWN");
    await this.rawRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "comfy-mcp-server", version: "0.1.0" }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}
`);
  }
  async spawnChild() {
    if (this.restarts > this.maxRestarts) {
      throw new BackendError(`backend restarted ${this.restarts} times and keeps dying`, "E_BACKEND_RESTARTS");
    }
    if (this.restarts > 0) {
      this.toolsCache = null;
    }
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.extraEnv },
      windowsHide: true
    });
    this.child = child;
    child.on("error", (error) => {
      this.logger.error(`backend spawn error: ${error.message}`);
    });
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        for (const [, entry] of this.pending) entry.reject(new BackendError("backend exited", "E_BACKEND_DOWN"));
        this.pending = /* @__PURE__ */ new Map();
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) this.handleFrame(line);
        newline = this.buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) this.logger.error(`[backend] ${line}`);
      }
    });
    this.restarts += 1;
  }
  handleFrame(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const id = message["id"];
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (entry === void 0) return;
    this.pending.delete(id);
    if (message["error"] !== void 0) {
      const error = message["error"];
      entry.reject(new BackendError(String(error["message"] ?? "backend error"), "E_BACKEND_RPC"));
      return;
    }
    entry.resolve(message["result"]);
  }
  killChild() {
    const child = this.child;
    this.child = null;
    if (child !== null && child.exitCode === null) {
      try {
        child.kill();
      } catch {
      }
    }
  }
};

// src/wrap.ts
import { isAbsolute, resolve as resolve2 } from "node:path";
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function injectArtifacts(data, store, maxArtifacts) {
  if (Array.isArray(data["artifacts"])) return { data, injected: 0 };
  const files = data["files"];
  if (!Array.isArray(files)) return { data, injected: 0 };
  const artifacts = [];
  for (const entry of files.slice(0, maxArtifacts)) {
    const record = asRecord(entry);
    const rawPath = record?.["path"];
    if (typeof rawPath !== "string" || rawPath.length === 0) continue;
    const absolute = isAbsolute(rawPath) ? resolve2(rawPath) : resolve2(rawPath);
    const registered = store.register(absolute, typeof record?.["filename"] === "string" ? record["filename"] : void 0);
    if (registered === void 0) continue;
    artifacts.push({
      id: registered.id,
      filename: registered.filename,
      kind: typeof record?.["kind"] === "string" ? record["kind"] : registered.kind,
      bytes: registered.bytes,
      url: `/artifacts/${registered.id}`
    });
  }
  if (artifacts.length === 0) return { data, injected: 0 };
  return { data: { ...data, artifacts }, injected: artifacts.length };
}

// src/server.ts
var MAX_BODY_BYTES = 8 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolveBody(data));
    req.on("error", reject);
  });
}
function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(body);
}
async function createComfyMcpServer(options = {}) {
  const config = options.config ?? resolveServerConfig(options.env ?? process.env);
  const store = options.store ?? new ArtifactStore();
  const backend = options.backend ?? (config.backendKind === "mock" ? new MockBackend(mockStageDir(options.env ?? process.env)) : new StdioBackend({
    command: config.backendCommand,
    args: config.backendArgs,
    requestTimeoutMs: config.callTimeoutMs,
    logger: { error: (message) => process.stderr.write(`comfy-mcp-server: ${message}
`) }
  }));
  const sessions = /* @__PURE__ */ new Map();
  const startedAt = Date.now();
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        uptimeMs: Date.now() - startedAt,
        backend: backend.kind,
        artifacts: store.size,
        sessions: sessions.size
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      await serveArtifact(url.pathname.slice("/artifacts/".length), res);
      return;
    }
    if (req.method === "POST" && url.pathname === config.path) {
      await handlePost(req, res);
      return;
    }
    json(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
  }
  async function serveArtifact(id, res) {
    const entry = store.get(id);
    if (entry === void 0) {
      json(res, 404, { error: "artifact not found (expired or unknown id)" });
      return;
    }
    try {
      const stats = statSync2(entry.path);
      res.statusCode = 200;
      res.setHeader("content-type", contentTypeFor(entry.filename));
      res.setHeader("content-length", stats.size);
      const stream = createReadStream2(entry.path);
      stream.on("error", () => {
        if (!res.headersSent) json(res, 500, { error: "artifact read failed" });
        else res.destroy();
      });
      stream.pipe(res);
    } catch {
      json(res, 404, { error: "artifact file is gone" });
    }
  }
  async function handlePost(req, res) {
    const raw = await readBody(req);
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      json(res, 400, { error: "invalid JSON body" });
      return;
    }
    const method = typeof message["method"] === "string" ? message["method"] : "";
    const id = message["id"];
    if (method === "initialize") {
      const token2 = randomUUID3();
      sessions.set(token2, { token: token2, createdAt: Date.now() });
      json(
        res,
        200,
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: config.serverName, version: config.serverVersion },
            ...config.instructions.length > 0 ? { instructions: config.instructions } : {}
          }
        },
        { "mcp-session-id": token2 }
      );
      return;
    }
    if (method.startsWith("notifications/")) {
      res.statusCode = 202;
      res.end();
      return;
    }
    const sessionToken = req.headers["mcp-session-id"];
    const token = Array.isArray(sessionToken) ? sessionToken[0] : sessionToken;
    if (typeof token !== "string" || !sessions.has(token)) {
      json(res, 404, { jsonrpc: "2.0", id: id ?? null, error: { code: -32001, message: "unknown or expired session" } });
      return;
    }
    sessions.get(token).createdAt = Date.now();
    try {
      if (method === "tools/list") {
        const tools = await backend.listTools();
        json(res, 200, { jsonrpc: "2.0", id, result: { tools } });
        return;
      }
      if (method === "tools/call") {
        const params = message["params"] ?? {};
        const name = String(params["name"] ?? "");
        const args = params["arguments"] ?? void 0;
        const outcome = await backend.callTool(name, args);
        const structured = outcome.structuredContent ?? (typeof (outcome.content ?? []).find((block) => block.type === "text")?.text === "string" ? safeParse((outcome.content ?? []).find((block) => block.type === "text").text) : void 0);
        const data = structured !== void 0 && typeof structured === "object" ? structured : { text: typeof structured === "string" ? structured : "" };
        const wrapped = injectArtifacts(data, store, config.maxArtifactsPerResult);
        const result = {
          content: outcome.content ?? [],
          isError: outcome.isError === true,
          structuredContent: wrapped.data
        };
        json(res, 200, { jsonrpc: "2.0", id, result });
        return;
      }
      if (method === "ping") {
        json(res, 200, { jsonrpc: "2.0", id, result: {} });
        return;
      }
      json(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` }
      });
    } catch (error) {
      json(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32e3, message: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  function safeParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, config.host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  return {
    server,
    config,
    store,
    url: `http://${config.host}:${port}${config.path}`,
    status() {
      return {
        ok: true,
        url: `http://${config.host}:${port}${config.path}`,
        backend: backend.kind,
        artifacts: store.size,
        sessions: sessions.size,
        uptimeMs: Date.now() - startedAt
      };
    },
    async stop() {
      await backend.stop();
      server.close();
    }
  };
}

// src/main.ts
var NAME = "comfy-mcp-server";
async function runSelfTest() {
  const handle = await createComfyMcpServer({
    config: void 0,
    env: { ...process.env, COMFY_MCP_BACKEND: "mock", COMFY_MCP_SERVER_PORT: "0" }
  });
  try {
    const response = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    const body = await response.json();
    const ok = response.headers.get("mcp-session-id") !== null && body.result?.serverInfo?.name === "comfy-mcp-server";
    process.stdout.write(`${JSON.stringify({ ok, url: handle.url })}
`);
    return ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}
`);
    return 1;
  } finally {
    await handle.stop();
  }
}
var USAGE = `comfy-mcp-server \u2014 MCP Streamable HTTP reference service for ComfyUI

Usage:
  comfy-mcp-server              listen on COMFY_MCP_SERVER_PORT (default 18800)
  comfy-mcp-server --selftest   boot the mock backend, initialize, exit 0/1
  comfy-mcp-server --help       show this message

Environment: COMFY_MCP_BACKEND=stdio|mock, COMFY_MCP_BACKEND_CMD, COMFY_MCP_BACKEND_ARGS,
COMFY_MCP_SERVER_PORT, COMFY_MCP_SERVER_HOST, COMFY_MCP_SERVER_PATH, COMFY_MCP_CALL_TIMEOUT_MS.
`;
async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes("--selftest")) {
    process.exit(await runSelfTest());
  }
  const handle = await createComfyMcpServer({});
  process.stderr.write(`${NAME}: listening on ${handle.url} (backend: ${handle.status()["backend"]})
`);
  const shutdown = (signal) => {
    process.stderr.write(`${NAME}: ${signal}, shutting down
`);
    void handle.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
function isMainModule() {
  const entry = process.argv[1];
  if (entry === void 0) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(self).href;
  } catch {
    return entry.endsWith("main.ts") || entry.endsWith("main.js");
  }
}
if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${NAME}: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}
`);
    process.exit(1);
  });
}
export {
  main,
  runSelfTest
};
