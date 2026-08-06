# Testing

Ampersand has two Vitest suites: fast unit tests that need no external services and integration tests that exercise the full training, tool, and prediction flows against a real PostgreSQL database.

## Unit tests

The runtime contract-validation tests in `packages/contracts/src/contracts.test.ts` validate every shared DTO against valid and invalid payloads using TypeBox.

```powershell
bun run test
```

No external services are required.

## Integration tests

The integration tests in `tests/integration` drive the workflows through the mock worker and assert on the records stored in PostgreSQL. They cover four scenarios:

1. **Successful training flow** — a dataset definition is created and validated, a training job is queued and claimed by the mock worker, and the worker returns a successful result. The test verifies the job finishes `succeeded`, progress reaches 100%, a `candidate` model version is created, artifact metadata is stored, model-feature records are created, and all shared DTO validations pass.
2. **Failed training flow** — a valid job is created and claimed, and the mock worker returns a structured failure. The test verifies the job finishes `failed`, the error code and message are stored, and no model version, artifact, or model-feature records are created.
3. **Tool-to-prediction flow** — a successful candidate model is published and converted into a tool definition, then a valid prediction is submitted. The test verifies the generated tool definition passes contract validation, the tool is linked to the published model version, the prediction request passes both the general and generated input-schema validation, a valid prediction response is produced, and the inference call is stored with the input, prediction, uncertainty, model version, and latency.
4. **Invalid-contract handling** — a deliberately malformed prediction request is rejected by contract validation and the flow stops before any inference record is created.

### Prerequisites

Follow the local setup steps in [setup.md](setup.md) first:

```powershell
bun install
```

- PostgreSQL is running: `bun run infra:up`
- `.env` exists with the required secrets
- The local tenant is bootstrapped once (start the API first, then bootstrap):

```powershell
bun run dev:api
bun run --cwd apps/api tenant:bootstrap
```

The API only needs to be running for the one-time bootstrap; the integration tests themselves connect directly to PostgreSQL.

### Running the suite

From the repository root:

```powershell
bun run test:integration
```

To typecheck the test files before running:

```powershell
bun run typecheck:integration
```

Each integration test runs inside a transaction that rolls back, so no data is persisted to the database.

### Troubleshooting

| Error | Fix |
|---|---|
| `Error: DATABASE_URL is required` | `.env` is missing or incomplete. Copy `.env.example` to `.env` and fill in the required secrets (see [setup.md](setup.md)). |
| `ECONNREFUSED ... 5432` | PostgreSQL is not running. Run `bun run infra:up`. |
| `Active tenant 'ampersand-dev' was not found` | The tenant was not bootstrapped. Run `bun run dev:api`, then `bun run --cwd apps/api tenant:bootstrap`. |
