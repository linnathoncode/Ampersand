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
└──────────┬─────────────────┬────────────┘
           │                 │
           ▼                 ▼
┌──────────────────┐   ┌───────────────┐
│ PostgreSQL       │   │ Redis Queue   │
│ Source of truth  │   └───────┬───────┘
└──────────────────┘           │
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

PostgreSQL is the single source of truth for datasets, snapshots, training jobs, model versions, feature metadata, artifact manifests, tool definitions, and inference records.

### Redis

Redis carries training jobs and supports temporary coordination. Durable job and model state remains in PostgreSQL.

### Worker

The private Python worker claims jobs, freezes and validates data, performs time-based splitting, trains and evaluates models, sends heartbeats, exports ONNX artifacts, and reports structured results. It has no public endpoint and makes no authorization decisions.

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

