# Finora DataBase

Initial backend foundation for Finora, built with Node.js, TypeScript, and Fastify.

## Current scope

- Fastify API with security headers, rate limiting, request-size and timeout limits.
- Health endpoint: `GET /api/v1/health`.
- Exact-origin allowlist through `CORS_ORIGINS`.
- Type-check and build validation through GitHub Actions.
- No database, authentication, or financial-data synchronization is enabled yet.

Finora remains local-first with SQLite. No financial records are sent to this service by this scaffold.

## Requirements

- Node.js 22 or newer
- npm

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

The API binds to `127.0.0.1:3000` by default. To check it:

```bash
curl http://127.0.0.1:3000/api/v1/health
```

Before public deployment, configure a real HTTPS reverse proxy, a specific `CORS_ORIGINS` allowlist, production logging, monitoring, and a reviewed authentication/data model. Do not commit real credentials or `.env` files.

## Validation

```bash
npm run typecheck
npm run build
```

The GitHub Actions workflow runs these checks for pull requests targeting `main` and pushes to `main`.
