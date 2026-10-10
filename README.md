# Finora DataBase

Backend API for Finora, built with Node.js 22, TypeScript, Fastify, and SQLite. The API project is separate from the Flutter client. The financial database on each device remains local unless a user explicitly chooses to upload an encrypted backup.

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
- `POST /api/v1/backups` — upload an encrypted backup
- `GET /api/v1/backups` — list the authenticated user's backup metadata
- `GET /api/v1/backups/:id` — download one of the authenticated user's encrypted backups
- `DELETE /api/v1/backups/:id` — delete one of the authenticated user's backups

Registration/login use a username (3–32 characters: letters, numbers, dot, underscore, hyphen) and a password of 12–128 characters. Passwords are stored as scrypt hashes with random salts; session tokens are random, expire after 30 days, and only their SHA-256 hashes are stored in SQLite. Authentication endpoints have dedicated rate limits.

## Encrypted backup API

The backup vault stores **opaque bytes only**; it does not export financial rows from the API database. The Flutter client must encrypt the complete local backup on the device before calling this endpoint. Never upload plaintext JSON, an unencrypted SQLite file, passwords, encryption keys, or the local database directly. The server validates the payload format and SHA-256 integrity, but it cannot prove that a client really encrypted the bytes.

Upload requires `Authorization: Bearer <accessToken>` and a JSON body with:
- `format`: exactly `finora-encrypted-backup-v1`
- `ciphertext`: base64url-encoded encrypted bytes
- `sha256`: SHA-256 hex digest of the decoded encrypted bytes

The API currently limits each backup to 5 MiB and each user to 10 backups. Backup files are stored separately from SQLite under `BACKUP_STORAGE_PATH`, in per-user directories with restrictive POSIX permissions where supported. The server generates UUID IDs, verifies checksums on download, and applies ownership checks to list, download, and delete operations. Upload is limited to 10 requests per hour per IP; the global API rate limit also applies.

Example request shape (use ciphertext produced by the client-side encryption implementation; this placeholder is not a real backup):

```http
POST /api/v1/backups
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "format": "finora-encrypted-backup-v1",
  "ciphertext": "<base64url-encrypted-bytes>",
  "sha256": "<sha256-of-decoded-encrypted-bytes>"
}
```

A successful upload returns HTTP 201 with backup metadata. Listing never returns ciphertext. Download returns ciphertext plus metadata. The API alone does not implement Flutter UI, client-side encryption, restore validation, or scheduled uploads.

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

Run checks:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm start
```

## Container deployment (persistent data)

The repository includes a Dockerfile and Compose configuration. They run the API as the unprivileged `node` user, drop Linux capabilities, use a read-only container filesystem, and store SQLite plus backup files in a named persistent volume at `/data`.

```bash
cp .env.example .env
# Edit .env; set CORS_ORIGINS to the exact frontend origin only if needed.
docker compose up --build -d
docker compose ps
curl http://127.0.0.1:3000/api/v1/health
```

Compose binds the API to `127.0.0.1:3000` on the host, not to the public network. Keep it behind a trusted HTTPS reverse proxy when deployed on a server. The named volume `finora_data` survives container rebuilds; still configure an independent backup of the server volume and test restoring it. Do not run `docker compose down -v` unless you intend to permanently delete the named data volume.

## Configuration

- `HOST`: defaults to `127.0.0.1`; Compose overrides this to `0.0.0.0` inside the container.
- `PORT`: defaults to `3000`.
- `DATABASE_PATH`: defaults to `./data/finora.db`; Compose uses `/data/finora.db`.
- `BACKUP_STORAGE_PATH`: defaults to `./data/backups`; Compose uses `/data/backups`.
- `CORS_ORIGINS`: comma-separated exact web origins, including scheme and port. Keep empty until the actual frontend origin is confirmed.

Never commit `.env`, SQLite database files, backup files, credentials, tokens, or encryption keys. Public deployment requires HTTPS, persistent private storage, monitoring, and tested backup/restore procedures.

## Security and storage

- Helmet security headers, global and route-specific rate limits
- Request body limits, request timeout, and no-store response headers
- Exact-origin allowlist via `CORS_ORIGINS`
- Redaction of authorization and credential-related fields, including backup ciphertext, in logs
- Generic JSON error responses
- Transactional, versioned SQLite migrations; foreign-key enforcement, WAL mode, busy timeout, and restrictive database-file permissions where supported
- Composite foreign keys tie financial references to the same owner; API queries filter by authenticated session user, not a client-supplied owner ID
- Money values use integer minor units
- Tests cover authentication, ownership isolation, idempotency, optimistic concurrency, sync tombstones, and backup upload/download/delete/integrity checks
- Locked npm dependency tree for reproducible `npm ci` installs

## Current limitations

The Flutter app's account identity is not yet linked to this API, and automatic financial sync remains disabled. The backup endpoints are server-side groundwork only: client-side encryption, opt-in upload/restore UI, and real device integration are still required.

**Do not deploy this as a public financial-data service yet.** Before accepting real data, finish encryption and restore validation, configure HTTPS and persistent private storage on the selected host, and test recovery end to end.
