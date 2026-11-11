const state = {
  plan: null,
  busy: false,
  workspaceMode: null,
  debugMode: false,
  lastError: null,
  lastResult: null
};

const elements = {
  form: document.getElementById("request-form"),
  input: document.getElementById("request-input"),
  planButton: document.getElementById("plan-button"),
  planCard: document.getElementById("plan-card"),
  resultsCard: document.getElementById("results-card"),
  resultsList: document.getElementById("results-list"),
  resultStatus: document.getElementById("result-status"),
  workspaceFiles: document.getElementById("workspace-files"),
  notesSummary: document.getElementById("notes-summary"),
  refreshButton: document.getElementById("refresh-button"),
  addFileButton: document.getElementById("add-file-button"),
  addNoteButton: document.getElementById("add-note-button"),
  workspaceForm: document.getElementById("workspace-form"),
  workspaceFormTitle: document.getElementById("workspace-form-title"),
  workspaceActionForm: document.getElementById("workspace-action-form"),
  workspaceNameLabel: document.getElementById("workspace-name-label"),
  workspaceContentLabel: document.getElementById("workspace-content-label"),
  workspaceName: document.getElementById("workspace-name"),
  workspaceContent: document.getElementById("workspace-content"),
  workspaceFormHint: document.getElementById("workspace-form-hint"),
  closeWorkspaceForm: document.getElementById("close-workspace-form"),
  modeLabel: document.getElementById("mode-label"),
  statusDot: document.getElementById("status-dot"),
  liveRegion: document.getElementById("live-region"),
  debugToggle: document.getElementById("debug-toggle")
};

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function announce(message) {
  elements.liveRegion.textContent = message;
}

function setBusy(isBusy, label) {
  state.busy = isBusy;
  elements.planButton.disabled = isBusy;
  elements.planButton.querySelector("span:first-child").textContent = label || (isBusy ? "Working..." : "Build plan");
}

function technicalError(error) {
  const code = error?.code ? "[" + error.code + "] " : "";
  const status = error?.status ? " (HTTP " + error.status + ")" : "";
  return code + String(error?.message || error || "Unknown error") + status;
}

function renderError(message) {
  elements.planCard.replaceChildren();
  const box = createElement("div", "inline-error");
  box.append(createElement("strong", "", "Something needs attention"), createElement("p", "", message));
  if (state.debugMode && state.lastError) {
    box.append(createElement("pre", "debug-details", technicalError(state.lastError)));
  }
  elements.planCard.append(box);
}

function showError(message, error) {
  state.lastError = error || new Error(message);
  renderError(message);
}

async function requestJson(url, options, fallbackMessage) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    const error = new Error("The ActionPilot service could not be reached.");
    error.code = "NETWORK_ERROR";
    throw error;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error("The server returned an unexpected response.");
    error.code = "SERVER_ERROR";
    error.status = response.status;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(payload.error || fallbackMessage);
    error.code = payload.code || "SERVER_ERROR";
    error.status = response.status;
    const retryAfter = response.headers.get("Retry-After");
    error.details = payload.details || (retryAfter ? { retryAfter } : undefined);
    throw error;
  }

  return payload;
}

function friendlyError(error) {
  const message = String(error?.message || error || "Unknown error");
  const code = error?.code || "";
  const retryAfter = error?.details?.retryAfter;

  if (code === "LLM_PROVIDER_ERROR" || /valid api key|authentication|unauthorized/i.test(message)) {
    return "The AI service could not authenticate this request. Check the LLM_API_KEY in the hosting environment, then redeploy.";
  }
  if (code === "LLM_TIMEOUT" || /timed out|timeout/i.test(message)) {
    return "The AI service timed out while responding. Please try again in a moment.";
  }
  if (code === "LLM_RATE_LIMITED") {
    return retryAfter ? "The AI service has reached its request limit. Please return later or try again in about " + retryAfter + " seconds." : "The AI service has reached its request limit. Please return later.";
  }
  if (code === "RATE_LIMITED") {
    return retryAfter ? "ActionPilot has reached its request limit. Please return later or try again in about " + retryAfter + " seconds." : "ActionPilot has reached its request limit. Please return later.";
  }
  if (code === "LLM_NETWORK_ERROR") {
    return "The AI service could not be reached. Check the provider connection and try again.";
  }
  if (code === "INVALID_LLM_RESPONSE") {
    return "The AI service returned an unreadable plan. Please try the request again.";
  }
  if (code === "INVALID_PATH") {
    return "That file path is not allowed. Use a file inside the workspace, such as README.txt.";
  }
  if (code === "FILE_EXISTS") {
    return "That file already exists. Choose a different name or explicitly request an overwrite.";
  }
  if (code === "PLAN_NOT_FOUND") {
    return "That plan expired. Please build the plan again.";
  }
  if (code === "INVALID_JSON" || code === "BODY_TOO_LARGE") {
    return "The request could not be read. Please try a shorter request.";
  }
  if (code === "EMPTY_REQUEST") {
    return "Please enter a task before building a plan.";
  }
  if (code === "REQUEST_TOO_LONG") {
    return "That request is too long. Please shorten it and try again.";
  }
  if (code === "INVALID_EXPRESSION") {
    return "The calculator could not understand that expression. Try something like 12 * (3 + 4).";
  }
  if (code === "FILE_NOT_FOUND" || code === "NOTE_NOT_FOUND" || /does not exist|no note matched|not found/i.test(message)) {
    return "The requested file or note could not be found.";
  }
  if (code === "FILE_NOT_DELETABLE") {
    return "Only individual files can be removed from the workspace.";
  }
  if (code === "FILE_NOT_READABLE") {
    return "That file cannot be read. Only text files within the workspace are supported.";
  }
  if (code === "INVALID_CONFIG" || code === "NOTES_STORE_ERROR") {
    return "A runtime configuration or storage error occurred on the server. Please try again later.";
  }
  if (code === "ACTION_ERROR") {
    return "A runtime error occurred while running that action. Please try again later.";
  }
  if (code === "INVALID_PLAN" || code === "UNSUPPORTED_ACTION") {
    return "The AI returned an action ActionPilot cannot safely run. Please try rephrasing the request.";
  }
  if (code === "NETWORK_ERROR" || /network|failed to fetch|fetch resource/i.test(message)) {
    return "The ActionPilot service could not be reached. Check your connection and try again.";
  }
  if (code === "SERVER_ERROR") {
    return "A runtime error occurred on the ActionPilot server. Please try again shortly.";
  }
  return "ActionPilot could not complete that request. A runtime error may have occurred; please try again.";
}

function actionDescription(action) {
  const args = action.args || {};
  if (action.type === "list_files") return "Inspect the safe workspace file list.";
  if (action.type === "read_file") return "Read " + args.path;
  if (action.type === "write_file") return "Write " + args.path + " (" + String(args.content || "").length + " characters)";
  if (action.type === "delete_file") return "Delete " + args.path;
  if (action.type === "calculate") return "Evaluate " + args.expression;
  if (action.type === "create_note") return "Create note: " + args.title;
  if (action.type === "list_notes") return "Show all saved notes.";
  if (action.type === "delete_note") return "Delete note " + args.id;
  return action.type;
}

function renderPlan(plan) {
  state.plan = plan;
  elements.resultsCard.hidden = true;
  elements.planCard.replaceChildren();

  const heading = createElement("div", "card-heading");
  const headingCopy = createElement("div");
  headingCopy.append(createElement("div", "section-kicker", "02 / REVIEW PLAN"), createElement("h2", "", "Ready to run"));
  heading.append(headingCopy, createElement("span", plan.source === "llm" ? "source-badge llm" : "source-badge", plan.source === "llm" ? "LLM plan" : "Demo plan"));
  elements.planCard.append(heading);

  const summary = createElement("div", "plan-summary");
  summary.append(createElement("div", "summary-icon", "✦"));
  const summaryCopy = createElement("div");
  summaryCopy.append(createElement("h3", "", plan.summary), createElement("p", "", plan.explanation));
  summary.append(summaryCopy);
  elements.planCard.append(summary);

  const actionHeader = createElement("div", "action-header");
  actionHeader.append(createElement("span", "section-kicker", "ACTIONS"), createElement("span", "action-count", plan.actions.length + " step" + (plan.actions.length === 1 ? "" : "s")));
  elements.planCard.append(actionHeader);

  const actionList = createElement("ol", "action-list");
  if (!plan.actions.length) {
    actionList.append(createElement("li", "no-actions", "No executable actions were generated."));
  }
  plan.actions.forEach((action, index) => {
    const item = createElement("li", "action-item");
    const number = createElement("span", "action-number", String(index + 1).padStart(2, "0"));
    const copy = createElement("div", "action-copy");
    copy.append(createElement("strong", "", action.label), createElement("p", "", actionDescription(action) + " · " + action.reason));
    const badge = createElement("span", action.requiresConfirmation ? "risk-badge" : "safe-badge", action.requiresConfirmation ? "CONFIRM" : "READ-ONLY");
    item.append(number, copy, badge);
    actionList.append(item);
  });
  elements.planCard.append(actionList);

  const footer = createElement("div", "plan-footer");
  const note = createElement("span", "hint", plan.requiresConfirmation ? "This plan changes data and needs your confirmation." : "This plan only reads data or calculates a result.");
  const executeButton = createElement("button", "primary-button", plan.requiresConfirmation ? "Confirm & execute" : "Execute plan");
  executeButton.type = "button";
  executeButton.addEventListener("click", () => executePlan(executeButton));
  footer.append(note, executeButton);
  elements.planCard.append(footer);
  announce("Plan ready for review.");
}

function renderResults(result, shouldScroll = true) {
  state.lastResult = result;
  elements.resultsCard.hidden = false;
  elements.resultsList.replaceChildren();
  elements.resultStatus.textContent = result.status === "success" ? "Completed" : "Completed with errors";
  elements.resultStatus.className = result.status === "success" ? "result-status success" : "result-status warning";
  result.results.forEach((item) => {
    const row = createElement("div", item.status === "success" ? "result-row" : "result-row result-error");
    const title = createElement("div", "result-title");
    title.append(createElement("span", item.status === "success" ? "result-mark success" : "result-mark error", item.status === "success" ? "✓" : "!"), createElement("strong", "", item.label));
    row.append(title);
    if (item.status === "success") {
      const pre = createElement("pre", "result-data", JSON.stringify(item.result, null, 2));
      row.append(pre);
    } else {
      const itemError = { message: item.error, code: item.code };
      row.append(createElement("p", "result-message", state.debugMode ? technicalError(itemError) : friendlyError(itemError)));
    }
    elements.resultsList.append(row);
  });
  if (shouldScroll) {
    elements.resultsCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  announce("Execution report is ready.");
}

async function planRequest(event) {
  event.preventDefault();
  await submitRequest();
}

async function submitRequest() {
  if (state.busy) return;
  setBusy(true, "Planning...");
  elements.resultsCard.hidden = true;
  state.lastError = null;
  state.lastResult = null;
  try {
    const payload = await requestJson("/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: elements.input.value })
    }, "The planner could not respond.");
    renderPlan(payload.plan);
  } catch (error) {
    const message = friendlyError(error);
    showError(message, error);
    announce(message);
  } finally {
    setBusy(false, "Build plan");
  }
}

function openWorkspaceForm(mode) {
  state.workspaceMode = mode;
  const isFile = mode === "file";
  elements.workspaceForm.hidden = false;
  elements.workspaceFormTitle.textContent = isFile ? "Add a file" : "Add a note";
  elements.workspaceNameLabel.textContent = isFile ? "File name" : "Note title";
  elements.workspaceContentLabel.textContent = isFile ? "File contents" : "Note body";
  elements.workspaceName.placeholder = isFile ? "example.txt" : "Project reminder";
  elements.workspaceContent.placeholder = isFile ? "Write the text to save..." : "Write the note...";
  elements.workspaceFormHint.textContent = "The agent will show a confirmation plan before saving it.";
  elements.workspaceName.focus();
}

function closeWorkspaceForm() {
  state.workspaceMode = null;
  elements.workspaceForm.hidden = true;
  elements.workspaceActionForm.reset();
}

async function planWorkspaceAddition(event) {
  event.preventDefault();
  const name = elements.workspaceName.value.trim();
  const content = elements.workspaceContent.value.trim();
  if (!name || !content) return;
  if (state.workspaceMode === "file") {
    elements.input.value = "Write file " + name + " containing " + content;
  } else {
    elements.input.value = "Create a note titled " + JSON.stringify(name) + " saying " + content;
  }
  closeWorkspaceForm();
  await submitRequest();
}

async function executePlan(button) {
  if (!state.plan || state.busy) return;
  button.disabled = true;
  button.textContent = "Executing...";
  setBusy(true, "Executing...");
  try {
    const payload = await requestJson("/api/agent/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planId: state.plan.id,
        confirmed: Boolean(state.plan.requiresConfirmation)
      })
    }, "The plan could not be executed.");
    renderResults(payload.result);
    await refreshWorkspace();
  } catch (error) {
    const message = friendlyError(error);
    showError(message, error);
    announce(message);
  } finally {
    button.disabled = false;
    button.textContent = state.plan && state.plan.requiresConfirmation ? "Confirm & execute" : "Execute plan";
    setBusy(false, "Build plan");
  }
}

async function refreshWorkspace() {
  try {
    const payload = await requestJson("/api/workspace", undefined, "Workspace unavailable.");
    elements.workspaceFiles.replaceChildren();
    const files = payload.workspace.files || [];
    if (!files.length) {
      elements.workspaceFiles.append(createElement("div", "loading-line", "No files yet."));
    } else {
      files.slice(0, 8).forEach((file) => {
        const row = createElement("div", "file-row");
        row.append(createElement("span", "file-icon", "▤"), createElement("span", "file-name", file.path), createElement("span", "file-size", formatBytes(file.bytes)));
        elements.workspaceFiles.append(row);
      });
    }
    const notes = payload.workspace.notes || [];
    elements.notesSummary.textContent = notes.length + " saved note" + (notes.length === 1 ? "" : "s");
  } catch (error) {
    elements.workspaceFiles.replaceChildren(createElement("div", "loading-line", friendlyError(error)));
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  return (bytes / 1024).toFixed(1) + " KB";
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    const llm = payload.mode === "llm";
    elements.modeLabel.textContent = llm ? "LLM connected" : "Demo mode";
    elements.statusDot.className = llm ? "status-dot online" : "status-dot demo";
  } catch {
    elements.modeLabel.textContent = "Offline";
    elements.statusDot.className = "status-dot offline";
  }
}

elements.form.addEventListener("submit", planRequest);
elements.refreshButton.addEventListener("click", refreshWorkspace);
elements.addFileButton.addEventListener("click", () => openWorkspaceForm("file"));
elements.addNoteButton.addEventListener("click", () => openWorkspaceForm("note"));
elements.closeWorkspaceForm.addEventListener("click", closeWorkspaceForm);
elements.workspaceActionForm.addEventListener("submit", planWorkspaceAddition);
elements.debugToggle.addEventListener("click", () => {
  state.debugMode = !state.debugMode;
  elements.debugToggle.textContent = "Debug details: " + (state.debugMode ? "On" : "Off");
  elements.debugToggle.setAttribute("aria-pressed", String(state.debugMode));
  elements.debugToggle.classList.toggle("active", state.debugMode);
  if (state.lastError) {
    renderError(friendlyError(state.lastError));
  }
  if (state.lastResult) {
    renderResults(state.lastResult, false);
  }
});
document.querySelectorAll("[data-example]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.input.value = button.dataset.example;
    elements.input.focus();
  });
});

loadHealth();
refreshWorkspace();
