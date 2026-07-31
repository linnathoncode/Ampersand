# Product Requirements

## Functional Requirements

1. A user can define a tabular dataset, feature columns, a target column, and an optional time column.
2. The system freezes or fingerprints the exact data used by a training run.
3. An authorized user or LLM can request model training.
4. Training runs asynchronously in a private worker.
5. The system reports job state, progress, heartbeat, logs, and structured errors.
6. Time-ordered data is split chronologically.
7. Every trained model is compared with a naive baseline.
8. Successful training creates an immutable candidate model version.
9. Publication requires an explicit authorized action.
10. A published model automatically produces an LLM-compatible JSON Schema.
11. Newly published tools can be discovered and called in the same chat.
12. Inference returns a prediction, uncertainty, model version, and boundary warnings.
13. Invalid or out-of-range inputs return a structured rejection without a prediction.
14. Every significant action and inference call is audited.

## Required Invariants

1. The same training fingerprint is not trained twice.
2. An unpublished model version cannot be called.
3. A tenant cannot access another tenant's model.
4. A running job cannot remain alive without a recent heartbeat.
5. Out-of-range input never returns a numeric prediction.
6. Every prediction is linked to an exact model version.
7. Only artifacts produced by the trusted worker can be loaded.

Each invariant must have a separately named test that fails when its enforcement is removed.

## Technical Requirements

- Nucleus is the single public backend gateway.
- PostgreSQL is the single source of truth.
- Redis is used for queueing and temporary coordination.
- The worker has no public API.
- Next.js must not contain route handlers or a custom backend proxy.
- Model artifacts should use ONNX where supported.
- Artifact checksums and provenance must be verified before inference.
- Tenant ownership must be enforced on every tenant-owned resource.
- Secrets must come from environment variables and must not be committed.
- Local startup must be documented without undocumented manual steps.

## Initial Technology Stack

| Area | Technology |
|---|---|
| Frontend | Next.js, React, TypeScript |
| Backend | Nucleus Core, Elysia, Bun |
| Database access | Drizzle ORM |
| Validation | TypeBox and JSON Schema |
| Database | PostgreSQL |
| Queue and cache | Redis |
| Worker | Python |
| Data processing | Pandas |
| Machine learning | Scikit-learn |
| Model format | ONNX |
| Inference runtime | ONNX Runtime |
| Backend tests | Vitest |
| Worker tests | Pytest |
| End-to-end tests | Playwright |
| Local infrastructure | Docker Compose |

## Required Deliverables

- Working system
- Data dictionary
- Model card for every published version
- Generated tool-schema example and generation rules
- Seven named invariant tests
- Complete setup documentation
- Chat transcript and matching audit log
- Evidence that killing a worker causes a `dead` job
- Known limitations list
