import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError, ConfirmationRequiredError, createAgent } from "./agent.js";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(path.dirname(currentFile));
const publicRoot = path.join(projectRoot, "public");
const port = Number(process.env.PORT || 3000);
const agentRoot = process.env.AGENT_DATA_DIR
  ? path.resolve(process.env.AGENT_DATA_DIR)
  : path.join(projectRoot, "data", "workspace");
const agent = createAgent({ rootDir: agentRoot });
const maxBodyBytes = 1024 * 1024;
const planRateLimitWindowMs = 60 * 1000;
const planRateLimitMax = 20;
const planRateLimits = new Map();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(body);
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBodyBytes) {
        reject(new AgentError("Request body is too large.", "BODY_TOO_LARGE", 413));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new AgentError("Request body must be valid JSON.", "INVALID_JSON"));
      }
    });
    request.on("error", reject);
  });
}

async function serveStatic(pathname, response) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = path.resolve(publicRoot, relative);
  if (!target.startsWith(publicRoot + path.sep) && target !== publicRoot) {
    sendText(response, 403, "Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(target);
    const extension = path.extname(target).toLowerCase();
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": "no-cache"
    });
    response.end(content);
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

function checkPlanRateLimit(request) {
  const key = request.socket.remoteAddress || "local-client";
  const now = Date.now();
  const existing = planRateLimits.get(key);
  if (!existing || now - existing.startedAt >= planRateLimitWindowMs) {
    planRateLimits.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (existing.count >= planRateLimitMax) {
    const retryAfter = Math.ceil((planRateLimitWindowMs - (now - existing.startedAt)) / 1000);
    throw new AgentError("Too many plan requests. Try again in " + retryAfter + " seconds.", "RATE_LIMITED", 429, { retryAfter });
  }
  existing.count += 1;
}

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, {
      ok: true,
      service: "ActionPilot",
      mode: agent.isLlmConfigured ? "llm" : "demo",
      llmConfigured: agent.isLlmConfigured,
      allowedActions: agent.allowedActions
    });
    return;
  }
  if (url.pathname === "/api/workspace" && request.method === "GET") {
    sendJson(response, 200, { ok: true, workspace: await agent.workspaceSnapshot() });
    return;
  }
  if (url.pathname === "/api/agent/plan" && request.method === "POST") {
    checkPlanRateLimit(request);
    const body = await readJson(request);
    const plan = await agent.planRequest(body.request);
    sendJson(response, 200, { ok: true, plan });
    return;
  }
  if (url.pathname === "/api/agent/execute" && request.method === "POST") {
    const body = await readJson(request);
    const result = await agent.executePlan(body.planId, Boolean(body.confirmed));
    sendJson(response, 200, { ok: true, result });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { ok: false, error: "API route not found." });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method not allowed");
    return;
  }
  await serveStatic(url.pathname, response);
}

const server = http.createServer(async (request, response) => {
  try {
    await handle(request, response);
  } catch (error) {
    const status = error instanceof AgentError ? error.status : 500;
    const message = error instanceof AgentError ? error.message : "Unexpected server error.";
    const retryAfter = error instanceof AgentError ? error.details?.retryAfter : undefined;
    const headers = retryAfter ? { "Retry-After": String(retryAfter) } : {};
    if (error instanceof ConfirmationRequiredError) {
      sendJson(response, status, {
        ok: false,
        code: error.code,
        error: message,
        plan: error.details.plan
      }, headers);
      return;
    }
    sendJson(response, status, {
      ok: false,
      code: error instanceof AgentError ? error.code : "SERVER_ERROR",
      error: message
    }, headers);
  }
});

async function start() {
  await agent.initialize();
  server.listen(port, "0.0.0.0", () => {
    console.log("ActionPilot listening on http://localhost:" + port);
    console.log("Planner mode: " + (agent.isLlmConfigured ? "LLM" : "demo"));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { server, agent };
