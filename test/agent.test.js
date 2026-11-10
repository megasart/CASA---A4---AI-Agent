import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentError, ConfirmationRequiredError, createAgent } from "../src/agent.js";

async function makeAgent() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "actionpilot-"));
  const agent = createAgent({ rootDir: directory, disableLlm: true });
  await agent.initialize();
  return { directory, agent };
}

test("lists only files inside the workspace", async () => {
  const { directory, agent } = await makeAgent();
  try {
    const plan = await agent.planRequest("List the files in my workspace");
    assert.equal(plan.requiresConfirmation, false);
    const result = await agent.executePlan(plan.id);
    assert.equal(result.status, "success");
    assert.ok(result.results[0].result.files.some((file) => file.path === "README.txt"));
    assert.ok(!result.results[0].result.files.some((file) => file.path.includes(".agent-")));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("requires confirmation before creating a note", async () => {
  const { directory, agent } = await makeAgent();
  try {
    const plan = await agent.planRequest('Create a note titled "Test" saying remember the demo');
    assert.equal(plan.requiresConfirmation, true);
    await assert.rejects(() => agent.executePlan(plan.id, false), ConfirmationRequiredError);
    const result = await agent.executePlan(plan.id, true);
    assert.equal(result.status, "success");
    assert.equal(result.results[0].result.note.title, "Test");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("calculates arithmetic without evaluating code", async () => {
  const { directory, agent } = await makeAgent();
  try {
    const plan = await agent.planRequest("Calculate 12 * (3 + 4)");
    const result = await agent.executePlan(plan.id);
    assert.equal(result.results[0].result.value, 84);
    const unsafePlan = await agent.planRequest("Calculate 1 + 2");
    assert.equal(unsafePlan.actions[0].type, "calculate");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects parent-directory traversal during planning", async () => {
  const { directory, agent } = await makeAgent();
  try {
    await assert.rejects(() => agent.planRequest("Read file ../outside.txt"), (error) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.code, "INVALID_PATH");
      return true;
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
