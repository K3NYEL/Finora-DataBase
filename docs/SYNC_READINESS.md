# Finora synchronization readiness audit

Status: design/audit only. This document does not enable synchronization, deploy a server, or authorize uploading local financial data.

## Repositories and scope

- Flutter app: `K3NYEL/finora`.
- API: `K3NYEL/Finora-DataBase`, current API work on `feat/initial-api-and-validation` (draft PR #1).
- API PR currently implements authenticated list/create endpoints. Update/delete, idempotency, cursor-based incremental sync, conflict resolution, and sync endpoints are not implemented.

## Local schema observed

The Flutter branch `security/audit-hardening-v0.5.18` has database version 6. Its legacy tables still use integer autoincrement primary keys:
- `accounts`: `id`, `name`, `type`, `initial_balance` (REAL), `initial_balance_minor` (INTEGER), `created_at`, `is_archived`, nullable `user_id`.
- `categories`: `id`, `name`, `type`, `is_default`, nullable `user_id`.
- `transactions`: integer `id`, `account_id`, `category_id`, `type`, `amount` (REAL), `amount_minor` (INTEGER), `description`, `date`, `created_at`, nullable `user_id`.
- `transfers`: integer `id`, `source_account_id`, `destination_account_id`, `amount` (REAL), `amount_minor` (INTEGER), `description`, `date`, `created_at`, nullable `user_id`.
- The v6 migration records unresolved legacy ownership and avoids automatically claiming records for the first account to sign in.

This branch must be validated separately from `main`; do not assume v6 is released or present in users' installed databases.

## API schema observed

The API uses UUID/text IDs, authenticated `user_id` ownership, integer minor-unit amounts, and ISO timestamps:
- `accounts`: `opening_balance_minor`, `currency_code`, `account_type`, `created_at`, `updated_at`.
- `categories`: `kind`, `created_at`, `updated_at`.
- `transactions`: `account_id`, optional `category_id`, `kind`, `amount_minor`, `occurred_at`, `description`, `created_at`.
- `transfers`: `from_account_id`, `to_account_id`, `amount_minor`, `occurred_at`, `description`, `created_at`.
- `budgets` exist only in the API schema observed so far; no corresponding local table was identified in the reviewed local database bootstrap/migrations.

## Blocking mismatches

1. **Identity:** local IDs are integers; API IDs are UUIDs. A stable local-to-remote mapping is required. Never replace local primary keys in-place without a migration plan and backup/rollback testing.
2. **Money:** the API accepts integer minor units. Use the local `*_minor` columns and validate their completeness; do not sync floating-point `REAL` amounts.
3. **Field names and semantics:** `type` vs `kind`, `date` vs `occurred_at`, and transfer source/destination names need an explicit adapter. Confirm the exact local meanings before mapping.
4. **Ownership:** local `user_id` is nullable and legacy records can remain unassigned. No record may be uploaded until a user explicitly links the local profile and confirms ownership/adoption.
5. **Incremental changes:** the API currently lacks `updated_at`/deletion tombstones on transactions and transfers, stable idempotency keys, and a sync cursor/version. A retry could create duplicates and deletions could be resurrected.
6. **Conflicts:** the API currently has no optimistic concurrency/version checks. Financial edits must not silently overwrite a newer version from another device.
7. **Account balance:** opening balance is not current balance. Current balance must be derived consistently from opening balance, transactions, and transfers.

## Safe implementation sequence

1. Validate the app's v6 migration with Flutter tests and a copied pre-migration database; never test migrations against the live user database.
2. Agree on the local ID strategy (recommended: add a stable UUID sync ID while preserving local integer IDs initially).
3. [Schema groundwork added in migration v3; idempotent transaction/transfer creation added] Implement version-conflict checks, tombstone-aware reads/deletes, and incremental sync operations with authorization tests.
4. Add owner-scoped update/delete and incremental pull/push operations with conflict handling and authorization tests.
5. Implement an explicit opt-in link flow and a dry-run preview (counts and conflicts) before any upload.
6. Test offline retries, duplicate requests, cross-user access, deletion propagation, and migration rollback/recovery.
7. Only after review, enable sync behind an explicit user setting. Do not deploy publicly until transport security, backups, monitoring, and account-linking design are verified.

## Non-goals for this phase

- No automatic upload or background sync.
- No deployment or public server exposure.
- No changes to production user data.
- No merging of draft PRs or release creation.
