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

## Error handling and auditability

- LLM timeouts, provider errors, malformed JSON, and unsupported actions become user-readable API errors.
- Provider HTTP 429 responses and repeated plan requests are rate-limited with a retry hint.
- Invalid paths, oversized content, invalid arithmetic, duplicate file writes, and missing notes are rejected.
- State-changing actions pause until the user clicks Confirm & execute.
- Every plan and action attempt is appended to data/workspace/.agent-audit.log.
- Audit records redact file content and note bodies; they record paths, lengths, action types, status, and timestamps.
