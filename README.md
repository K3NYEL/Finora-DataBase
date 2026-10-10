# Finora DataBase

Backend API foundation for Finora, built with Node.js 22, TypeScript, Fastify, and SQLite. The backend has its own GitHub-inspired workflow and remains separate from the Flutter client.

## Current API

- `GET /api/v1/health` — service health
- `POST /api/v1/auth/register` — create an API account
- `POST /api/v1/auth/login` — authenticate and create a session
- `GET /api/v1/auth/me` — return the authenticated account
- `POST /api/v1/auth/logout` — revoke the current bearer session
- `GET/POST /api/v1/accounts` — list/create the authenticated user's financial accounts
- `GET/POST /api/v1/categories` — list/create income and expense categories
- `GET/POST /api/v1/transactions` — list/create income and expense movements
- `GET/POST /api/v1/transfers` — list/create transfers between the user's own accounts
- `GET/POST /api/v1/budgets` — list/create budgets tied to the user's own expense categories

Registration/login currently use a username (3–32 characters: letters, numbers, dot, underscore, hyphen) and a password of 12–128 characters. Passwords are stored as scrypt hashes with random salts; session tokens are random, expire after 30 days, and only their SHA-256 hashes are stored in SQLite. Authentication endpoints have dedicated rate limits.

## Security and storage

- Helmet security headers, global and route-specific rate limits
- Request body limit and request timeout
- Exact-origin allowlist via `CORS_ORIGINS`
- Redaction of authorization and credential-related fields in logs
- Generic JSON error responses
- Transactional, versioned SQLite migrations (v1 auth/session tables; v2 financial tables); foreign-key enforcement, WAL mode, busy timeout, and restrictive database-file permissions where supported
- Composite foreign keys tie each transaction, transfer, and budget reference to the same owner; API queries filter by the authenticated session user, not a client-supplied owner ID
- Money values use positive integer minor units for movements and budgets; account opening balances are integer minor units
- Automated tests for CORS preflight policy, session expiry/revocation, registration rate limits, token-hash storage, and cross-user financial access; TypeScript type-check and build in GitHub Actions
- Locked npm dependency tree with reproducible `npm ci` installs

The server binds to `127.0.0.1:3000` by default. SQLite storage defaults to `./data/finora.db`; the database and its sidecar files must not be committed or served as static files.

## Run locally

Requirements: Node.js 22 or newer and npm.

```bash
npm ci
cp .env.example .env
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:3000/api/v1/health
```

Example account registration:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"finora_user","password":"use-a-long-unique-password"}'
```

Use the returned `accessToken` as `Authorization: Bearer <token>` for `/api/v1/auth/me` and `/api/v1/auth/logout`. Do not put real passwords or tokens in shell history, screenshots, or issue reports.

Run checks:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm start
```

## Configuration

- `HOST`: defaults to `127.0.0.1`; use a trusted reverse proxy before public exposure.
- `PORT`: defaults to `3000`.
- `DATABASE_PATH`: defaults to `./data/finora.db`.
- `CORS_ORIGINS`: comma-separated exact web origins, including scheme and port. Keep empty until the actual frontend origin is confirmed.

Never commit `.env`, SQLite database files, credentials, tokens, or production secrets.

## Current financial API scope

The first financial API iteration provides list/create endpoints only. It intentionally does not yet support update/delete, pagination cursors, conflict resolution, balance summaries, idempotency keys, or client synchronization. Account balances must be derived from opening balances plus movements and transfers; do not treat stored opening balances as current balances.

## Not implemented yet

- Client synchronization and conflict resolution
- Linking API accounts to existing local Finora profiles
- Password reset, session listing/revocation across devices, and account recovery
- Production HTTPS, monitoring, backups, and deployment configuration

The existing Finora app currently identifies local profiles by first and last name and does not collect a unique username. This API's username-based identity is deliberately not wired into the app yet; a client/account-linking design must be agreed and tested before sync can be enabled. No local financial records are uploaded by this API.

**Do not deploy this as a public financial-data service yet.** Before accepting real personal financial data, complete account-linking design, financial schema/migrations, ownership checks on every query, authorization tests, production HTTPS/CORS, backup and restore procedures, and operational monitoring.
