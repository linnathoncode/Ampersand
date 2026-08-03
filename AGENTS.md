# AGENTS.md

- Keep changes small, modular, and within the assigned scope. Preserve unrelated files and existing work.
- Build the smallest end-to-end version that satisfies the current requirement before adding abstractions or optional features.
- Treat Nucleus as the sole public gateway for authentication, authorization, quotas, auditing, job lifecycle, tool publication, and inference validation.
- Treat PostgreSQL as the source of truth, Redis as temporary coordination, the private Python worker as training-only, and ONNX artifacts as immutable versioned outputs.
- Maintain tenant isolation and enforce these lifecycles: `queued -> running -> succeeded|failed|cancelled|dead` and `candidate -> published -> retired`.
- Only published models may be called. Out-of-range input must return a reasoned rejection, never a prediction.
- Keep shared API, job, model, artifact, and tool contracts in `packages/contracts`; coordinate contract changes across API and worker boundaries.
- Member A owns data management, model training, metrics, and reproducibility. Member B owns the Nucleus service, job lifecycle, tool generation, authorization, and quotas.

## Orchestrator Order

1. The root agent inspects the task, defines shared contracts, and divides independent work into bounded assignments.
2. Subagents change only their assigned scope, verify their work, and avoid independently expanding requirements or editing overlapping files.
3. Subagents report results, assumptions, and blockers to the root agent.
4. The root agent reviews and integrates the results, runs cross-component verification, and reports the final outcome.
