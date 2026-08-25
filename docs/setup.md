# Local Setup

## Prerequisites

- Git
- Bun 1.3.14 or a compatible newer release
- Python 3.11 or newer
- Docker with Docker Compose

## Initial Repository Setup

```powershell
git clone <repository-url>
cd Ampersand
Copy-Item .env.example .env
```

Replace the example secrets in `.env` before running the application.

## TypeScript Packages

Install all workspace packages from the repository root:

```powershell
bun install
```

This installs the root, API, web, and shared-contract packages and creates the Bun lockfile.

## Python Worker Environment

```powershell
python -m venv .venv
. .\scripts\activate-env.ps1
python -m pip install --upgrade pip
pip install -r services\worker\requirements.txt
pip install -e services\worker
```

The activation helper searches the current directory and its parents for `.venv`, so it also works from a subdirectory of the repository.

Run the worker package from the repository root (or any parent of `.venv`):

```powershell
python -m worker
```

The worker loads its configuration from `.env` and from the `WORKER_*`
variables documented in `.env.example`, plus `NUCLEUS_INTERNAL_URL` and
`NUCLEUS_INTERNAL_TOKEN` for submitting training results to Nucleus. The
worker validates configuration,
connects directly to PostgreSQL, confirms connectivity, and then claims
queued training jobs, trains on the frozen snapshot, and submits each
result to Nucleus over the internal endpoint. It never starts an HTTP
server and keeps running until it receives `SIGTERM` or `SIGINT`.

To run the worker test suite:

```powershell
python -m pytest services\worker\tests
```

## Local Infrastructure

Start PostgreSQL in Docker:

```powershell
bun run infra:up
```

Database rows persist in named Docker volumes when containers are stopped. Use `bun run infra:down` to stop the services without deleting their data.

## Running Tests

See [testing.md](testing.md) for the unit and integration test suites, their prerequisites, and troubleshooting.
