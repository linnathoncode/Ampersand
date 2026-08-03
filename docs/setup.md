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
```

The activation helper searches the current directory and its parents for `.venv`, so it also works from a subdirectory of the repository.

## Local Infrastructure

Start PostgreSQL and Redis in Docker:

```powershell
bun run infra:up
```

Database rows persist in named Docker volumes when containers are stopped. Use `bun run infra:down` to stop the services without deleting their data.
