# Ampersand

Ampersand turns tabular datasets into governed, versioned prediction tools that an LLM can call.

## Repository Structure

```text
Ampersand/
├── apps/
│   ├── api/                 # Nucleus and custom Elysia API
│   └── web/                 # Next.js chat and management UI
├── services/
│   └── worker/              # Python training worker
├── packages/
│   └── contracts/           # Shared schemas and API contracts
├── artifacts/               # Local development model artifacts
├── docs/                    # Architecture and setup documents
└── tests/
    └── e2e/                 # End-to-end workflow tests
```

## Documentation

- [Architecture](docs/architecture.md)
- [Product requirements](docs/project-requirements.md)
- [Local setup](docs/setup.md)
