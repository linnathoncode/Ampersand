# Ampersand Architecture

## System Overview

```text
┌──────────────────────────────┐
│ Next.js Chat / Management UI │
└──────────────┬───────────────┘
               │ Direct API calls
               ▼
┌─────────────────────────────────────────┐
│ Nucleus + Custom Elysia API             │
│                                         │
│ Auth · tenants · quotas · audit         │
│ Jobs · registry · tool generation       │
│ Inference validation                    │
└────────────────────┬────────────────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │ PostgreSQL           │
          │ Truth + job queue    │
          └──────────┬───────────┘
                     │ Transactional claim
                     ▼
                    ┌────────────────────┐
                    │ Private ML Worker  │
                    │ Train · evaluate   │
                    │ heartbeat · export │
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │ Artifact Storage   │
                    │ ONNX + checksums   │
                    └────────────────────┘
```

## Components

### Web Application

The Next.js application provides the LLM chat, training progress, model registry, publication controls, predictions, and rejection details. It calls Nucleus directly and does not implement a route-handler proxy.

### API

Nucleus is the only public gateway. Custom Elysia routes implement training commands, job monitoring, model publication, dynamic tool discovery, and inference. Nucleus provides authentication, authorization, tenant isolation, validation, quotas, and auditing.

### PostgreSQL

PostgreSQL is the single source of truth for datasets, snapshots, training jobs, model versions, feature metadata, artifact manifests, tool definitions, and inference records. It also provides the job queue: workers poll and claim queued rows transactionally with `FOR UPDATE SKIP LOCKED`.

### Worker

The private Python worker connects directly to PostgreSQL (the durable job
queue) and never exposes a public endpoint. It never makes authorization
decisions; all authority arrives as trusted job metadata. The worker validates
its configuration, verifies PostgreSQL connectivity, and stays idle until
`SIGTERM`/`SIGINT`. Transactional claiming with `FOR UPDATE SKIP LOCKED`,
heartbeat progress, training and evaluation, ONNX export, and structured
results are added incrementally.

### Artifact Storage

Development artifacts are stored locally. A production deployment may use S3-compatible storage. Every artifact must have a checksum, producer record, and immutable model-version association.

## Main Workflow

```text
Training request
→ queued job
→ worker training
→ candidate model
→ explicit publication
→ generated LLM tool
→ validated prediction or reasoned rejection
→ audit record
```

## Job Lifecycle

```text
queued → running → succeeded
                 → failed
                 → cancelled
                 → dead
```

## Model Lifecycle

```text
candidate → published → retired
```

Only published versions may be called.
