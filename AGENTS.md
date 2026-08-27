# Ampersand

Ampersand turns tenant-owned tabular data into versioned prediction tools that an LLM can discover and call.

## Architecture

- Next.js provides the web interface.
- Nucleus and Elysia form the only public API gateway.
- PostgreSQL stores tenant data, metadata, job state, model records, tool definitions, and audit history.
- The private Python worker claims training jobs and exports immutable ONNX artifacts.
- Shared contracts in `packages/contracts` define communication between the web app, API, and worker.

## Instructions

- Preserve tenant isolation and route public operations through Nucleus.
- Treat PostgreSQL as the source of truth and training-job queue.
- Keep changes small and preserve unrelated work.
- Update shared contracts when a change crosses component boundaries.
- Enforce the job lifecycle `queued -> running -> succeeded|failed|cancelled|dead`.
- Enforce the model lifecycle `candidate -> published -> retired`.
- Only published models may expose prediction tools.
- Reject invalid or out-of-range inputs without running inference.
- Verify changes with focused tests and a workspace typecheck.
