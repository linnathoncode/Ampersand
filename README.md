# Ampersand

Ampersand turns a tabular dataset into a versioned prediction tool that an LLM can discover and call. Users upload a CSV, choose feature and target columns in chat, review the training request, and confirm it. A private worker trains the model, exports an ONNX artifact, and registers a candidate model. Publishing the candidate creates its prediction tool.

The app includes tenant-aware authentication, model controls, input validation, inference auditing, rate limits, and daily tenant quotas.

## Stack

- Next.js and React for the web app
- Nucleus and Elysia for the API, authentication, authorization, and tenant management
- PostgreSQL for application data and the durable training-job queue
- Redis for rate limits and inference quotas
- Python, scikit-learn, and ONNX for training and inference artifacts
- Bun for the TypeScript workspace

## Local setup

### Requirements

- Bun 1.3+
- Python 3.11+
- Docker Desktop

### Install and configure

```powershell
git clone https://github.com/linnathoncode/Ampersand.git
cd Ampersand
Copy-Item .env.example .env
bun install

python -m venv .venv
. .\scripts\activate-env.ps1
python -m pip install --upgrade pip
pip install -r services\worker\requirements.txt
pip install -e services\worker
```

Replace the placeholder secrets in `.env`, especially the token secrets, `LLM_SETTINGS_ENCRYPTION_KEY`, and `NUCLEUS_INTERNAL_TOKEN`. Set Azure email values only if you want invitation emails during local development.

### Start the application

Start infrastructure:

```powershell
bun run infra:up
```

Start these in separate terminals:

```powershell
# API: http://localhost:4000
bun run dev:api

# Web app: http://localhost:3000
bun run dev:web

# Private training worker
. .\scripts\activate-env.ps1
python -m worker
```

On a new local database, start the API first, then provision the development tenant and apply its migrations:

```powershell
bun --cwd apps/api tenant:bootstrap
```

## Using Ampersand

1. Sign in and upload a CSV from **Datasets**.
2. In chat, ask to train a model using a source table, feature columns, and a numeric target.
3. Review the generated training summary and confirm it once.
4. Watch job progress in chat. A completed job appears as a candidate in **Model controls**.
5. Publish the candidate to create a discoverable prediction tool.
6. Ask the chat to list available prediction tools or make a prediction with one.

The profile page supports local Ollama models and remote OpenAI-compatible or Anthropic models. Remote API keys are encrypted before they are stored in PostgreSQL.

## Architecture

```text
Next.js web app
        |
        v
Nucleus + Elysia API
auth, tenants, jobs, registry, tools, validation, audit
        |
        +-----------------------+
        |                       |
        v                       v
PostgreSQL                  Redis
data and job queue          rate limits and quotas
        |
        v
Private Python worker
training, evaluation, ONNX export
        |
        v
Local artifact storage
```

PostgreSQL is the source of truth. The worker transactionally claims queued jobs, writes progress, and submits model metadata back to the API. Model versions move from `candidate` to `published` to `retired`. Only published models create callable tools. Every prediction and rejection is recorded in the tenant schema.

## Tests

```powershell
bun run typecheck
bun run test
python -m pytest services\worker\tests
```

For database-backed tests, start Docker first and run:

```powershell
bun run test:integration
```

Further details are in [docs](docs/), including [architecture](docs/architecture.md), [local setup](docs/setup.md), and [testing](docs/testing.md).
