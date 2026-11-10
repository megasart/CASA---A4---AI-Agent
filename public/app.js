const state = {
  plan: null,
  busy: false
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
  modeLabel: document.getElementById("mode-label"),
  statusDot: document.getElementById("status-dot"),
  liveRegion: document.getElementById("live-region")
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

function showError(message) {
  elements.planCard.replaceChildren();
  const box = createElement("div", "inline-error");
  box.append(createElement("strong", "", "Something needs attention"), createElement("p", "", message));
  elements.planCard.append(box);
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

function renderResults(result) {
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
      row.append(createElement("p", "result-message", item.error));
    }
    elements.resultsList.append(row);
  });
  elements.resultsCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  announce("Execution report is ready.");
}

async function planRequest(event) {
  event.preventDefault();
  if (state.busy) return;
  setBusy(true, "Planning...");
  elements.resultsCard.hidden = true;
  try {
    const response = await fetch("/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: elements.input.value })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "The planner could not respond.");
    renderPlan(payload.plan);
  } catch (error) {
    showError(error.message);
    announce(error.message);
  } finally {
    setBusy(false, "Build plan");
  }
}

async function executePlan(button) {
  if (!state.plan || state.busy) return;
  button.disabled = true;
  button.textContent = "Executing...";
  setBusy(true, "Executing...");
  try {
    const response = await fetch("/api/agent/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planId: state.plan.id,
        confirmed: Boolean(state.plan.requiresConfirmation)
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "The plan could not be executed.");
    renderResults(payload.result);
    await refreshWorkspace();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = state.plan && state.plan.requiresConfirmation ? "Confirm & execute" : "Execute plan";
    setBusy(false, "Build plan");
  }
}

async function refreshWorkspace() {
  try {
    const response = await fetch("/api/workspace");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Workspace unavailable.");
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
    elements.workspaceFiles.replaceChildren(createElement("div", "loading-line", error.message));
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
document.querySelectorAll("[data-example]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.input.value = button.dataset.example;
    elements.input.focus();
  });
});

loadHealth();
refreshWorkspace();
