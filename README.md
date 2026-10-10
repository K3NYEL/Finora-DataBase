# Finora DataBase

Backend foundation for Finora, built with Node.js 22, TypeScript, and Fastify. The repository is intentionally separate from the Finora client and uses an independent, GitHub-inspired developer workflow.

## Current status

- Versioned API namespace: `/api/v1`
- Health endpoint: `GET /api/v1/health`
- Security headers via Helmet
- Global and health-endpoint rate limits
- Request body limit and request timeout
- Exact-origin CORS allowlist via `CORS_ORIGINS`
- Redaction of authorization, cookie, password, token, and secret fields in logs
- Generic JSON responses for unknown routes and server errors
- Automated tests, TypeScript type-check, and build in GitHub Actions

**Not enabled yet:** database connection, user authentication, financial-data endpoints, or synchronization. Finora remains local-first with SQLite; this API scaffold does not send financial records anywhere.

## Requirements

- Node.js 22 or newer
- npm

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

By default, the server binds only to `127.0.0.1:3000`. Check health:

```bash
curl http://127.0.0.1:3000/api/v1/health
```

To test and build:

```bash
npm test
npm run typecheck
npm run build
npm start
```

## Configuration

- `HOST`: defaults to `127.0.0.1`; do not expose the process directly to the internet.
- `PORT`: defaults to `3000`.
- `CORS_ORIGINS`: comma-separated, exact web origins, including scheme and port when applicable. Keep empty until the actual frontend origin is known.

Never commit `.env`, credentials, tokens, or production secrets.

## Before public deployment

Do not deploy this scaffold as a financial-data API yet. Before public exposure, configure HTTPS through a trusted reverse proxy, production CORS origins, monitoring and alerting, and a reviewed authentication/authorization and data model. Database migrations, account isolation, validation, abuse protection, and security tests must be implemented before accepting personal financial data.
