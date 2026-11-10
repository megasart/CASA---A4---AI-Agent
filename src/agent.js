import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_REQUEST_LENGTH = 4000;
const MAX_ACTIONS = 5;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_WRITE_BYTES = 50 * 1024;
const PLAN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LLM_TIMEOUT_MS = 60 * 1000;
const NOTES_FILE = ".agent-notes.json";
const AUDIT_FILE = ".agent-audit.log";
const INTERNAL_FILES = new Set([NOTES_FILE, AUDIT_FILE]);

const ACTION_ALIASES = {
  list_workspace: "list_files",
  list_directory: "list_files",
  create_file: "write_file",
  remove_file: "delete_file",
  open_file: "read_file",
  math: "calculate",
  add_note: "create_note",
  remove_note: "delete_note"
};

const ACTIONS = {
  list_files: {
    label: "List workspace files",
    sideEffect: false
  },
  read_file: {
    label: "Read a text file",
    sideEffect: false
  },
  write_file: {
    label: "Write a text file",
    sideEffect: true
  },
  delete_file: {
    label: "Delete a text file",
    sideEffect: true
  },
  calculate: {
    label: "Calculate an expression",
    sideEffect: false
  },
  create_note: {
    label: "Create a note",
    sideEffect: true
  },
  list_notes: {
    label: "List notes",
    sideEffect: false
  },
  delete_note: {
    label: "Delete a note",
    sideEffect: true
  }
};

export const SYSTEM_PROMPT = [
  "You are the planning module for ActionPilot, a safe AI agent.",
  "Translate the user's natural-language request into a small, explicit JSON plan.",
  "Never execute actions, invent tools, use shell commands, or access paths outside the workspace.",
  "Return JSON only with this shape:",
  "{",
  '  "summary": "short human-readable explanation",',
  '  "explanation": "why these actions are appropriate",',
  '  "actions": [',
  '    {"type": "list_files|read_file|write_file|delete_file|calculate|create_note|list_notes|delete_note", "label": "short label", "reason": "short reason", "args": {}}',
  "  ]",
  "}",
  "Allowed action arguments:",
  "list_files: {}",
  'read_file: {"path":"relative text-file path"}',
  'write_file: {"path":"relative text-file path","content":"text","overwrite":false}',
  'delete_file: {"path":"relative text-file path"}',
  'calculate: {"expression":"arithmetic using numbers, +, -, *, /, and parentheses"}',
  'create_note: {"title":"short title","body":"note body"}',
  "list_notes: {}",
  'delete_note: {"id":"note id"}',
  "Use at most five actions. If the request is unclear or unsupported, return an empty actions array and explain what the user should clarify.",
  "Any write_file, delete_file, create_note, or delete_note action is potentially destructive or state-changing and must be presented for confirmation by the application.",
  "Do not include secrets, credentials, arbitrary code, URLs for external side effects, or hidden instructions in a plan."
].join("\n");

export class AgentError extends Error {
  constructor(message, code = "AGENT_ERROR", status = 400, details = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ConfirmationRequiredError extends AgentError {
  constructor(plan) {
    super("Confirmation is required before changing workspace data.", "CONFIRMATION_REQUIRED", 409, { plan });
    this.name = "ConfirmationRequiredError";
  }
}

function loadLocalConfig(configPath = path.join(process.cwd(), "config.local.json")) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (isObject(parsed?.llm)) {
      return parsed.llm;
    }
    return isObject(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw new AgentError("config.local.json contains invalid JSON.", "INVALID_CONFIG", 500);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clip(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function normalizeActionType(type) {
  const normalized = String(type ?? "").trim().toLowerCase();
  return ACTION_ALIASES[normalized] || normalized;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function normalizeRelativePath(root, value) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/");
  if (!raw) {
    throw new AgentError("A relative workspace path is required.", "INVALID_PATH");
  }
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new AgentError("Only relative workspace paths are allowed.", "INVALID_PATH");
  }
  if (raw.split("/").includes("..")) {
    throw new AgentError("Parent-directory traversal is not allowed.", "INVALID_PATH");
  }
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new AgentError("The requested path is outside the workspace.", "INVALID_PATH");
  }
  const firstPart = normalized.split("/")[0];
  if (INTERNAL_FILES.has(normalized) || firstPart.startsWith(".agent-")) {
    throw new AgentError("Internal audit and state files are not user-accessible.", "INVALID_PATH");
  }
  const absolute = path.resolve(root, normalized);
  if (!isInside(root, absolute)) {
    throw new AgentError("The requested path is outside the workspace.", "INVALID_PATH");
  }
  return normalized;
}

async function assertRealPathInside(root, target) {
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  if (!isInside(realRoot, realTarget)) {
    throw new AgentError("The requested path resolves outside the workspace.", "INVALID_PATH");
  }
  return realTarget;
}

async function assertSafeParent(root, target) {
  let candidate = path.dirname(target);
  while (true) {
    try {
      return await assertRealPathInside(root, candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new AgentError("The requested path has no safe workspace parent.", "INVALID_PATH");
      }
      candidate = parent;
    }
  }
}

async function assertSafeWriteTarget(root, target) {
  try {
    return await assertRealPathInside(root, target);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await assertSafeParent(root, target);
    return target;
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkspace(root) {
  await fs.mkdir(root, { recursive: true });
  const seedFiles = {
    "README.txt": "Welcome to the ActionPilot demo workspace.\nTry: list my files, read README.txt, or calculate 12 * (3 + 4).\n",
    "project-ideas.txt": "1. Add calendar summaries\n2. Add a read-only web research action\n3. Add team approval workflows\n",
    "meeting-notes.md": "# Sample meeting notes\n\n- Keep actions explicit.\n- Show the user what will happen before execution.\n"
  };
  for (const [fileName, content] of Object.entries(seedFiles)) {
    const target = path.join(root, fileName);
    if (!(await pathExists(target))) {
      await fs.writeFile(target, content, "utf8");
    }
  }
  await fs.mkdir(path.dirname(path.join(root, AUDIT_FILE)), { recursive: true });
}

async function readNotes(root) {
  const target = path.join(root, NOTES_FILE);
  try {
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw new AgentError("The notes store could not be read.", "NOTES_STORE_ERROR", 500);
  }
}

async function writeNotes(root, notes) {
  const target = path.join(root, NOTES_FILE);
  await fs.writeFile(target, JSON.stringify(notes, null, 2) + "\n", "utf8");
}

async function listFiles(root) {
  const output = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".agent-")) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(absolute);
      output.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
      if (output.length >= 100) {
        return;
      }
    }
  }
  await walk(root);
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function calculateExpression(expression) {
  const input = String(expression ?? "").trim();
  if (!input || input.length > 120 || !/^[0-9+\-*/().\s]+$/.test(input)) {
    throw new AgentError("Only basic arithmetic expressions are allowed.", "INVALID_EXPRESSION");
  }
  let index = 0;
  const skipSpaces = () => {
    while (input[index] === " ") {
      index += 1;
    }
  };
  const parsePrimary = () => {
    skipSpaces();
    if (input[index] === "+" || input[index] === "-") {
      const sign = input[index] === "-" ? -1 : 1;
      index += 1;
      return sign * parsePrimary();
    }
    if (input[index] === "(") {
      index += 1;
      const value = parseExpression();
      skipSpaces();
      if (input[index] !== ")") {
        throw new AgentError("Unbalanced parentheses in expression.", "INVALID_EXPRESSION");
      }
      index += 1;
      return value;
    }
    const start = index;
    while (/[0-9.]/.test(input[index] || "")) {
      index += 1;
    }
    if (start === index) {
      throw new AgentError("A number was expected in the expression.", "INVALID_EXPRESSION");
    }
    const number = Number(input.slice(start, index));
    if (!Number.isFinite(number)) {
      throw new AgentError("The expression contains an invalid number.", "INVALID_EXPRESSION");
    }
    return number;
  };
  const parseTerm = () => {
    let value = parsePrimary();
    while (true) {
      skipSpaces();
      const operator = input[index];
      if (operator !== "*" && operator !== "/") {
        return value;
      }
      index += 1;
      const right = parsePrimary();
      if (operator === "/" && right === 0) {
        throw new AgentError("Division by zero is not allowed.", "INVALID_EXPRESSION");
      }
      value = operator === "*" ? value * right : value / right;
    }
  };
  function parseExpression() {
    let value = parseTerm();
    while (true) {
      skipSpaces();
      const operator = input[index];
      if (operator !== "+" && operator !== "-") {
        return value;
      }
      index += 1;
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
  }
  const result = parseExpression();
  skipSpaces();
  if (index !== input.length || !Number.isFinite(result)) {
    throw new AgentError("The expression could not be evaluated safely.", "INVALID_EXPRESSION");
  }
  return Number(result.toFixed(10));
}

function extractJson(text) {
  const value = String(text ?? "").trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/i, "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new AgentError("The LLM did not return a JSON plan.", "INVALID_LLM_RESPONSE", 502);
  }
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    throw new AgentError("The LLM returned malformed JSON.", "INVALID_LLM_RESPONSE", 502);
  }
}

function extractPath(request) {
  const quoted = request.match(/["']([^"']+)["']/);
  if (quoted) {
    return quoted[1];
  }
  const pathMatch = request.match(/(?:file|path)\s+([A-Za-z0-9_./-]+)/i);
  return pathMatch ? pathMatch[1] : "README.txt";
}

function extractExpression(request) {
  const matches = request.match(/[0-9][0-9\s+\-*/().]*[0-9)]?/g) || [];
  return matches.sort((left, right) => right.length - left.length)[0] || "0";
}

function demoPlan(request) {
  const lower = request.toLowerCase();
  if ((lower.includes("list") || lower.includes("show")) && (lower.includes("file") || lower.includes("workspace") || lower.includes("directory"))) {
    return {
      summary: "I will list the files in the safe demo workspace.",
      explanation: "This is a read-only workspace inspection.",
      actions: [{ type: "list_files", label: "List workspace files", reason: "Inspect available demo files.", args: {} }]
    };
  }
  if (lower.includes("calculate") || lower.includes("compute") || lower.startsWith("what is ")) {
    const expression = extractExpression(request);
    return {
      summary: "I will calculate " + expression + ".",
      explanation: "The calculator accepts arithmetic only and never evaluates code.",
      actions: [{ type: "calculate", label: "Calculate expression", reason: "Answer the arithmetic request.", args: { expression } }]
    };
  }
  if (lower.includes("list") && lower.includes("note")) {
    return {
      summary: "I will list the saved notes.",
      explanation: "This is a read-only notes lookup.",
      actions: [{ type: "list_notes", label: "List notes", reason: "Show saved notes.", args: {} }]
    };
  }
  if ((lower.includes("delete") || lower.includes("remove")) && lower.includes("note")) {
    const idMatch = request.match(/(?:note\s+)([a-z0-9-]{6,})/i);
    return {
      summary: "I will delete the requested note.",
      explanation: "Deleting a note changes workspace state, so confirmation is required.",
      actions: [{ type: "delete_note", label: "Delete note", reason: "Remove the note named by the user.", args: { id: idMatch ? idMatch[1] : "" } }]
    };
  }
  if (lower.includes("note") || lower.includes("remember")) {
    const quoted = request.match(/["']([^"']+)["']/g) || [];
    const title = quoted[0] ? quoted[0].slice(1, -1) : "New ActionPilot note";
    const bodyMatch = request.match(/(?:that|saying|body)\s+(.+)$/i);
    const body = bodyMatch ? bodyMatch[1].replace(/^["']|["']$/g, "") : request;
    return {
      summary: "I will create a note titled " + title + ".",
      explanation: "Creating a note changes workspace state, so confirmation is required.",
      actions: [{ type: "create_note", label: "Create note", reason: "Save the user's requested reminder.", args: { title, body } }]
    };
  }
  if ((lower.includes("read") || lower.includes("open") || lower.includes("contents")) && lower.includes("file")) {
    const filePath = extractPath(request);
    return {
      summary: "I will read " + filePath + " from the safe demo workspace.",
      explanation: "This is a read-only text-file lookup.",
      actions: [{ type: "read_file", label: "Read " + filePath, reason: "Show the requested file contents.", args: { path: filePath } }]
    };
  }
  if (lower.includes("delete") || lower.includes("remove")) {
    const filePath = extractPath(request);
    return {
      summary: "I will delete " + filePath + ".",
      explanation: "Deleting a file is destructive, so confirmation is required.",
      actions: [{ type: "delete_file", label: "Delete " + filePath, reason: "Remove the requested file.", args: { path: filePath } }]
    };
  }
  if (lower.includes("write") || lower.includes("create file") || lower.includes("save file")) {
    const filePath = extractPath(request);
    const bodyMatch = request.match(/(?:containing|with content|saying)\s+(.+)$/i);
    const content = bodyMatch ? bodyMatch[1].replace(/^["']|["']$/g, "") : "Created by ActionPilot.\n";
    return {
      summary: "I will write " + filePath + ".",
      explanation: "Writing a file changes workspace state, so confirmation is required.",
      actions: [{ type: "write_file", label: "Write " + filePath, reason: "Save the requested text.", args: { path: filePath, content, overwrite: false } }]
    };
  }
  return {
    summary: "I could not map that request to a supported safe action.",
    explanation: "Try asking for files, notes, or arithmetic. For example: list my files, read README.txt, create a note, or calculate 12 * (3 + 4).",
    actions: []
  };
}

async function callLlm(request, options) {
  const baseUrl = options.baseUrl || process.env.LLM_BASE_URL || "https://api.openai.com/v1/chat/completions";
  const localOllama = /localhost:11434|127\.0\.0\.1:11434/i.test(baseUrl);
  const apiKey = options.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || (localOllama ? "ollama" : "");
  if (!apiKey || options.disableLlm) {
    return { source: "demo", plan: demoPlan(request) };
  }
  const model = options.model || process.env.LLM_MODEL || "gpt-4o-mini";
  const controller = new AbortController();
  const configuredTimeout = Number(options.timeoutMs || process.env.LLM_TIMEOUT_MS || DEFAULT_LLM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 5000 ? configuredTimeout : DEFAULT_LLM_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: request }
        ]
      }),
      signal: controller.signal
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after") || "a moment";
      throw new AgentError("The LLM provider is rate-limiting requests. Try again in " + retryAfter + ".", "LLM_RATE_LIMITED", 429, { retryAfter });
    }
    if (!response.ok) {
      const providerMessage = clip(await response.text(), 300);
      throw new AgentError("The LLM provider returned an error: " + providerMessage, "LLM_PROVIDER_ERROR", 502);
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    return { source: "llm", plan: extractJson(content) };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AgentError("The LLM request timed out. Try again.", "LLM_TIMEOUT", 504);
    }
    if (error instanceof AgentError) {
      throw error;
    }
    throw new AgentError("The LLM request failed. Check the API configuration.", "LLM_NETWORK_ERROR", 502);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedArgs(root, type, rawArgs) {
  const args = isObject(rawArgs) ? rawArgs : {};
  if (type === "list_files" || type === "list_notes") {
    return {};
  }
  if (type === "read_file" || type === "delete_file") {
    return { path: normalizeRelativePath(root, args.path || args.file_path) };
  }
  if (type === "write_file") {
    const content = String(args.content ?? "");
    if (!content || content.length > MAX_WRITE_BYTES) {
      throw new AgentError("Write content must be between 1 and " + MAX_WRITE_BYTES + " characters.", "INVALID_ACTION");
    }
    return {
      path: normalizeRelativePath(root, args.path || args.file_path),
      content,
      overwrite: Boolean(args.overwrite)
    };
  }
  if (type === "calculate") {
    const expression = clip(args.expression, 120).trim();
    if (!expression) {
      throw new AgentError("A calculator expression is required.", "INVALID_ACTION");
    }
    return { expression };
  }
  if (type === "create_note") {
    const title = clip(args.title || "Untitled note", 120).trim();
    const body = clip(args.body, 4000).trim();
    if (!body) {
      throw new AgentError("A note body is required.", "INVALID_ACTION");
    }
    return { title, body };
  }
  if (type === "delete_note") {
    const id = clip(args.id || args.note_id, 100).trim();
    if (!id) {
      throw new AgentError("A note id is required.", "INVALID_ACTION");
    }
    return { id };
  }
  throw new AgentError("Unsupported action: " + type, "UNSUPPORTED_ACTION");
}

function normalizePlan(root, request, rawPlan, source) {
  if (!isObject(rawPlan)) {
    throw new AgentError("The planner did not return a valid object.", "INVALID_PLAN", 502);
  }
  const rawActions = Array.isArray(rawPlan.actions) ? rawPlan.actions : [];
  if (rawActions.length > MAX_ACTIONS) {
    throw new AgentError("A plan may contain at most " + MAX_ACTIONS + " actions.", "INVALID_PLAN", 502);
  }
  const actions = rawActions.map((rawAction, index) => {
    if (!isObject(rawAction)) {
      throw new AgentError("Action " + (index + 1) + " is not an object.", "INVALID_PLAN", 502);
    }
    const type = normalizeActionType(rawAction.type || rawAction.action);
    if (!ACTIONS[type]) {
      throw new AgentError("The planner requested an unsupported action: " + type, "UNSUPPORTED_ACTION", 502);
    }
    const args = normalizedArgs(root, type, rawAction.args || rawAction.arguments);
    return {
      id: randomUUID(),
      type,
      label: clip(rawAction.label || ACTIONS[type].label, 120),
      reason: clip(rawAction.reason || "Requested by the user.", 300),
      args,
      requiresConfirmation: ACTIONS[type].sideEffect
    };
  });
  return {
    id: randomUUID(),
    request,
    summary: clip(rawPlan.summary || "Plan ready.", 400),
    explanation: clip(rawPlan.explanation || "The plan uses only allowlisted actions.", 600),
    actions,
    requiresConfirmation: actions.some((action) => action.requiresConfirmation),
    source,
    createdAt: new Date().toISOString()
  };
}

function safeAuditArgs(action) {
  const args = action.args || {};
  if (action.type === "write_file") {
    return { path: args.path, contentLength: String(args.content || "").length, overwrite: Boolean(args.overwrite) };
  }
  if (action.type === "create_note") {
    return { title: args.title, bodyLength: String(args.body || "").length };
  }
  return args;
}

export function createAgent(options = {}) {
  const root = path.resolve(options.rootDir || path.join(process.cwd(), "data", "workspace"));
  const auditPath = path.join(root, AUDIT_FILE);
  const pendingPlans = new Map();
  const localConfig = options.config || loadLocalConfig(options.configPath);
  const configuredBaseUrl = options.baseUrl || process.env.LLM_BASE_URL || localConfig.baseUrl;
  const localOllama = /localhost:11434|127\.0\.0\.1:11434/i.test(configuredBaseUrl || "");
  const configuredKey = options.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || localConfig.apiKey || (localOllama ? "ollama" : "");
  const configuredModel = options.model || process.env.LLM_MODEL || localConfig.model || "gpt-4o-mini";
  const configuredTimeout = options.timeoutMs || process.env.LLM_TIMEOUT_MS || localConfig.timeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const llmOptions = {
    ...options,
    apiKey: configuredKey,
    baseUrl: configuredBaseUrl,
    model: configuredModel,
    timeoutMs: configuredTimeout,
    disableLlm: options.disableLlm === true
  };

  async function audit(event, payload) {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...payload
    };
    await fs.appendFile(auditPath, JSON.stringify(entry) + "\n", "utf8");
  }

  async function initialize() {
    await ensureWorkspace(root);
  }

  async function planRequest(input) {
    await initialize();
    const request = String(input ?? "").trim();
    if (!request) {
      throw new AgentError("Tell ActionPilot what you want to do.", "EMPTY_REQUEST");
    }
    if (request.length > MAX_REQUEST_LENGTH) {
      throw new AgentError("Requests must be under " + MAX_REQUEST_LENGTH + " characters.", "REQUEST_TOO_LONG");
    }
    const result = await callLlm(request, llmOptions);
    const plan = normalizePlan(root, request, result.plan, result.source);
    pendingPlans.set(plan.id, { plan, expiresAt: Date.now() + PLAN_TTL_MS });
    await audit("plan_created", {
      planId: plan.id,
      source: plan.source,
      request: clip(request, 1000),
      actions: plan.actions.map((action) => ({ type: action.type, args: safeAuditArgs(action) }))
    });
    return plan;
  }

  async function executeAction(action) {
    const args = action.args;
    if (action.type === "list_files") {
      return { files: await listFiles(root) };
    }
    if (action.type === "read_file") {
      const target = path.resolve(root, args.path);
      await assertRealPathInside(root, target);
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new AgentError("Only text files up to " + MAX_FILE_BYTES + " bytes can be read.", "FILE_NOT_READABLE");
      }
      return { path: args.path, content: await fs.readFile(target, "utf8") };
    }
    if (action.type === "write_file") {
      const target = path.resolve(root, args.path);
      await assertSafeWriteTarget(root, target);
      const exists = await pathExists(target);
      if (exists && !args.overwrite) {
        throw new AgentError("The file already exists. Ask for overwrite explicitly.", "FILE_EXISTS", 409);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, args.content, "utf8");
      return { path: args.path, bytes: Buffer.byteLength(args.content), overwrote: exists };
    }
    if (action.type === "delete_file") {
      const target = path.resolve(root, args.path);
      await assertRealPathInside(root, target);
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        throw new AgentError("Only files can be deleted.", "FILE_NOT_DELETABLE");
      }
      await fs.unlink(target);
      return { path: args.path, deleted: true };
    }
    if (action.type === "calculate") {
      return { expression: args.expression, value: calculateExpression(args.expression) };
    }
    if (action.type === "list_notes") {
      return { notes: await readNotes(root) };
    }
    if (action.type === "create_note") {
      const notes = await readNotes(root);
      const note = {
        id: randomUUID().slice(0, 8),
        title: args.title,
        body: args.body,
        createdAt: new Date().toISOString()
      };
      notes.unshift(note);
      await writeNotes(root, notes.slice(0, 100));
      return { note };
    }
    if (action.type === "delete_note") {
      const notes = await readNotes(root);
      const nextNotes = notes.filter((note) => note.id !== args.id);
      if (nextNotes.length === notes.length) {
        throw new AgentError("No note matched id " + args.id + ".", "NOTE_NOT_FOUND", 404);
      }
      await writeNotes(root, nextNotes);
      return { id: args.id, deleted: true };
    }
    throw new AgentError("Unsupported action: " + action.type, "UNSUPPORTED_ACTION");
  }

  async function executePlan(planId, confirmed = false) {
    await initialize();
    const stored = pendingPlans.get(String(planId));
    if (!stored || stored.expiresAt < Date.now()) {
      pendingPlans.delete(String(planId));
      throw new AgentError("That plan is missing or expired. Please plan the request again.", "PLAN_NOT_FOUND", 404);
    }
    const { plan } = stored;
    if (plan.requiresConfirmation && !confirmed) {
      throw new ConfirmationRequiredError(plan);
    }
    const results = [];
    for (const action of plan.actions) {
      try {
        const result = await executeAction(action);
        results.push({ actionId: action.id, type: action.type, label: action.label, status: "success", result });
        await audit("action_executed", {
          planId: plan.id,
          actionId: action.id,
          type: action.type,
          confirmed: Boolean(confirmed),
          args: safeAuditArgs(action),
          status: "success"
        });
      } catch (error) {
        const message = error instanceof AgentError ? error.message : "The action failed.";
        results.push({ actionId: action.id, type: action.type, label: action.label, status: "error", error: message });
        await audit("action_failed", {
          planId: plan.id,
          actionId: action.id,
          type: action.type,
          confirmed: Boolean(confirmed),
          args: safeAuditArgs(action),
          status: "error",
          error: message
        });
      }
    }
    pendingPlans.delete(plan.id);
    const failed = results.some((result) => result.status === "error");
    return {
      planId: plan.id,
      status: failed ? "partial_failure" : "success",
      completedAt: new Date().toISOString(),
      results
    };
  }

  async function workspaceSnapshot() {
    await initialize();
    return {
      files: await listFiles(root),
      notes: await readNotes(root)
    };
  }

  return {
    initialize,
    planRequest,
    executePlan,
    workspaceSnapshot,
    root,
    isLlmConfigured: Boolean(configuredKey && configuredModel && !options.disableLlm),
    allowedActions: Object.keys(ACTIONS)
  };
}
