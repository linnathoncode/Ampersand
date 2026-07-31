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
cd services/worker
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```
