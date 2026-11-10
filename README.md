# ActionPilot

ActionPilot is a safe, auditable AI agent for common workspace and productivity tasks. It turns a natural-language request into a structured plan, validates that plan on the server, shows the user exactly what will happen, and executes only allowlisted operations.

This project is designed for CS4680 Assignment 4. The assignment asks for an LLM integration module, an action interpreter/executor, a user interface, and error handling with safety checks and audit logging. ActionPilot implements each requirement in one small, deployable Node application.

## Problem and relevance

Many AI demos stop after generating text. Real usefulness begins when an assistant can perform a concrete task, but that also introduces risk: an ambiguous prompt or unsafe model output could modify the wrong data. ActionPilot focuses on the small but important gap between language and action:

1. The user describes a task naturally.
2. The planner proposes a JSON action plan.
3. The server validates the plan against an allowlist and a workspace sandbox.
4. The interface displays the plan and requests confirmation for state-changing actions.
5. The executor performs the action and writes a JSONL audit event.

The app includes a deterministic demo planner, so the entire workflow works without an API key. When LLM_API_KEY is present, it uses an OpenAI-compatible Chat Completions endpoint.

## Run locally

Requirements: Node.js 20 or newer. There are no third-party npm dependencies.

~~~text
npm run start
~~~

Open http://localhost:3000.

Without configuration, the app is in Demo mode. Try:

- List the files in my workspace
- Read file README.txt
- Calculate 12 * (3 + 4)
- Create a note titled "Demo" saying follow up on the project

To enable an LLM planner, copy .env.example to .env and export the variables in your shell:

~~~text
LLM_API_KEY=your_key
LLM_BASE_URL=https://api.openai.com/v1/chat/completions
LLM_MODEL=gpt-4o-mini
~~~

The server reads environment variables directly. Do not commit .env or API keys.

## Architecture

~~~text
Browser UI
   |
   | POST /api/agent/plan
   v
LLM planner or demo planner
   |
   v
Plan validator: schema, allowlist, path sandbox, size limits
   |
   v
Review screen + confirmation gate
   |
   | POST /api/agent/execute
   v
Action executor -> workspace / notes / safe calculator
   |
   v
JSONL audit log
~~~

Important modules:

- src/agent.js: LLM integration, deterministic fallback, schema validation, action interpreter, safety checks, executor, and audit log.
- src/server.js: dependency-free HTTP server and API routes.
- public/index.html, public/app.js, public/styles.css: responsive UI with plan review and result feedback.
- data/workspace/: seeded demo files used by the file actions.

## Supported actions

| Action | Domain | Side effect | Confirmation |
| --- | --- | --- | --- |
| list_files | File workspace | No | No |
| read_file | File workspace | No | No |
| write_file | File workspace | Yes | Yes |
| delete_file | File workspace | Yes | Yes |
| calculate | Utility | No | No |
| create_note | Productivity | Yes | Yes |
| list_notes | Productivity | No | No |
| delete_note | Productivity | Yes | Yes |

The executor never runs shell commands and never accepts absolute paths or parent-directory traversal. File reads are limited to 100 KB, writes to 50 KB, and plans to five actions.

## Prompt engineering techniques

The planner prompt uses:

- Role and context: the model is explicitly a planning module, not an executor.
- Constrained output: a small JSON schema with named action types and argument shapes.
- Allowlisting: the prompt lists every valid action and says that unsupported requests should produce no actions.
- Safety rules: the prompt forbids shell commands, secrets, external side effects, and hidden instructions.
- Separation of concerns: planning and execution are separate HTTP requests, with validation between them.
- Deterministic settings: temperature is set to 0 for the provider call.

The application treats the prompt as a first line of defense only. The server independently validates every model field, which protects the app if the model ignores part of the prompt.

## Error handling and auditability

- LLM timeouts, provider errors, malformed JSON, and unsupported actions become user-readable API errors.
- Provider HTTP 429 responses and repeated plan requests are rate-limited with a retry hint.
- Invalid paths, oversized content, invalid arithmetic, duplicate file writes, and missing notes are rejected.
- State-changing actions pause until the user clicks Confirm & execute.
- Every plan and action attempt is appended to data/workspace/.agent-audit.log.
- Audit records redact file content and note bodies; they record paths, lengths, action types, status, and timestamps.

## Tests

Run:

~~~text
npm test
~~~

The tests exercise the safe calculator, read-only execution, confirmation gating, note creation, and workspace isolation using a temporary directory.
