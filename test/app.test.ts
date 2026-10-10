import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";

const allowedOrigin = "https://finora.example";
const password = "a-long-test-password-2026";
let app: FastifyInstance;
let previousOrigins: string | undefined;
let tempDirectory: string;
let databasePath: string;

beforeEach(async () => {
  previousOrigins = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = allowedOrigin;
  tempDirectory = mkdtempSync(join(tmpdir(), "finora-api-test-"));
  databasePath = join(tempDirectory, "test.db");
  app = await buildApp({ databasePath });
});

afterEach(async () => {
  await app.close();
  rmSync(tempDirectory, { recursive: true, force: true });
  if (previousOrigins === undefined) {
    delete process.env.CORS_ORIGINS;
  } else {
    process.env.CORS_ORIGINS = previousOrigins;
  }
});

test("health endpoint reports the service as available", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), { status: "ok", service: "finora-database-api" });
});

test("health endpoint allows a configured exact origin", async () => {
  const response = await app.inject({
    method: "GET", url: "/api/v1/health", headers: { origin: allowedOrigin },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], allowedOrigin);
  assert.equal(response.headers.vary, "Origin");
});

test("requests from unconfigured origins are rejected", async () => {
  const response = await app.inject({
    method: "GET", url: "/api/v1/health", headers: { origin: "https://unexpected.example" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "ORIGIN_NOT_ALLOWED");
});

test("preflight requests return the configured CORS policy", async () => {
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/auth/login",
    headers: {
      origin: allowedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, authorization, idempotency-key",
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], allowedOrigin);
  assert.equal(response.headers["access-control-allow-methods"], "GET, POST, PATCH, DELETE, OPTIONS");
  assert.equal(response.headers["access-control-allow-headers"], "Content-Type, Authorization, Idempotency-Key");
});

test("preflight rejects unsupported methods and headers", async () => {
  const badMethod = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/auth/login",
    headers: { origin: allowedOrigin, "access-control-request-method": "PUT" },
  });
  assert.equal(badMethod.statusCode, 403);
  assert.equal(badMethod.json().error.code, "PREFLIGHT_NOT_ALLOWED");

  const badHeader = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/auth/login",
    headers: {
      origin: allowedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-unapproved-header",
    },
  });
  assert.equal(badHeader.statusCode, 403);
  assert.equal(badHeader.json().error.code, "PREFLIGHT_NOT_ALLOWED");
});

test("unknown routes return a stable JSON error", async () => {
  const response = await app.inject({ method: "GET", url: "/does-not-exist" });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: { code: "NOT_FOUND", message: "Resource not found" } });
});

test("registration creates an account and stores only a hash of its session token", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { username: "Finora_User", password },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.user.username, "finora_user");
  assert.equal(body.tokenType, "Bearer");
  assert.equal(typeof body.accessToken, "string");
  assert.equal(body.accessToken.length, 43);
  assert.equal(typeof body.expiresAt, "string");
  assert.equal("password" in body.user, false);

  const database = openDatabase(databasePath);
  try {
    const user = database.prepare("SELECT password_hash FROM api_users WHERE id = ?")
      .get(body.user.id) as { password_hash: string };
    const session = database.prepare("SELECT token_hash FROM api_sessions WHERE user_id = ?")
      .get(body.user.id) as { token_hash: string };
    assert.match(user.password_hash, /^scrypt\$/);
    assert.match(session.token_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(session.token_hash, body.accessToken);
  } finally {
    database.close();
  }
});

test("registration rejects weak credentials and duplicate usernames", async () => {
  const weak = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "ab", password: "short" },
  });
  assert.equal(weak.statusCode, 400);

  const first = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "finora_user", password },
  });
  assert.equal(first.statusCode, 201);

  const duplicate = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "FINORA_USER", password },
  });
  assert.equal(duplicate.statusCode, 409);
});

test("registration endpoint rate-limits repeated attempts", async () => {
  const responses = [];
  for (let index = 0; index < 6; index += 1) {
    responses.push(await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "x", password: "short" },
    }));
  }
  assert.equal(responses.slice(0, 5).every((response) => response.statusCode === 400), true);
  assert.equal(responses[5]?.statusCode, 429);
});

test("database file has restrictive POSIX permissions", async () => {
  if (process.platform === "win32") return;
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
});

test("database migrations are recorded and safely re-run", async () => {
  const database = openDatabase(databasePath);
  try {
    const migration = database.prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    assert.equal(migration.version, 4);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  } finally {
    database.close();
  }

  const reopened = openDatabase(databasePath);
  try {
    const rows = reopened.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as
      Array<{ version: number }>;
    assert.deepEqual(rows, [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
  } finally {
    reopened.close();
  }
});

test("sync migration adds versioning, tombstones, timestamps, and idempotency storage", async () => {
  const database = openDatabase(databasePath);
  try {
    for (const table of ["accounts", "categories", "transactions", "transfers", "budgets"]) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      assert.equal(columns.some((column) => column.name === "sync_version"), true, table);
      assert.equal(columns.some((column) => column.name === "deleted_at"), true, table);
      assert.equal(columns.some((column) => column.name === "updated_at"), true, table);
      assert.equal(columns.some((column) => column.name === "sync_seq"), true, table);
    }
    const idempotencyTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_idempotency_keys'",
    ).get();
    assert.ok(idempotencyTable);
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "sync_clock"));
  } finally {
    database.close();
  }
});

test("login rejects wrong passwords without disclosing whether username exists", async () => {
  const register = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "finora_user", password },
  });
  assert.equal(register.statusCode, 201);

  const wrongPassword = await app.inject({
    method: "POST", url: "/api/v1/auth/login",
    payload: { username: "finora_user", password: "a-different-password" },
  });
  const missingUser = await app.inject({
    method: "POST", url: "/api/v1/auth/login",
    payload: { username: "unknown_user", password },
  });
  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(missingUser.statusCode, 401);
  assert.deepEqual(wrongPassword.json(), missingUser.json());
});

test("authenticated profile works and logout revokes the bearer session", async () => {
  const register = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "finora_user", password },
  });
  const token = register.json().accessToken as string;

  const profile = await app.inject({
    method: "GET", url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().user.username, "finora_user");

  const logout = await app.inject({
    method: "POST", url: "/api/v1/auth/logout",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(logout.statusCode, 204);

  const revoked = await app.inject({
    method: "GET", url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(revoked.statusCode, 401);
});

test("expired sessions are rejected", async () => {
  const register = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "finora_user", password },
  });
  const token = register.json().accessToken as string;

  const database = openDatabase(databasePath);
  try {
    database.prepare("UPDATE api_sessions SET expires_at = ?")
      .run(new Date(Date.now() - 60_000).toISOString());
  } finally {
    database.close();
  }

  const response = await app.inject({
    method: "GET", url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 401);
});

test("valid login creates a separate session for the existing account", async () => {
  const register = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "finora_user", password },
  });
  assert.equal(register.statusCode, 201);

  const login = await app.inject({
    method: "POST", url: "/api/v1/auth/login",
    payload: { username: "FINORA_USER", password },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.id, register.json().user.id);
  assert.notEqual(login.json().accessToken, register.json().accessToken);
});


test("financial routes require authentication and isolate each user's records", async () => {
  const registerUser = async (username: string) => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username, password },
    });
    assert.equal(response.statusCode, 201);
    return response.json().accessToken as string;
  };
  const aliceToken = await registerUser("alice_finora");
  const bobToken = await registerUser("bob_finora");
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/accounts" });
  assert.equal(unauthenticated.statusCode, 401);

  const accountResponse = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: auth(aliceToken),
    payload: { name: "Daily", type: "cash", currencyCode: "DOP", openingBalanceMinor: 120000 },
  });
  assert.equal(accountResponse.statusCode, 201);
  const aliceAccount = accountResponse.json().account;

  const categoryResponse = await app.inject({
    method: "POST", url: "/api/v1/categories", headers: auth(aliceToken),
    payload: { name: "Food", kind: "expense" },
  });
  assert.equal(categoryResponse.statusCode, 201);
  const aliceCategory = categoryResponse.json().category;

  const bobAccounts = await app.inject({ method: "GET", url: "/api/v1/accounts", headers: auth(bobToken) });
  const bobCategories = await app.inject({ method: "GET", url: "/api/v1/categories", headers: auth(bobToken) });
  assert.deepEqual(bobAccounts.json().accounts, []);
  assert.deepEqual(bobCategories.json().categories, []);

  const crossUserTransaction = await app.inject({
    method: "POST", url: "/api/v1/transactions", headers: auth(bobToken),
    payload: {
      accountId: aliceAccount.id, categoryId: aliceCategory.id, kind: "expense",
      amountMinor: 2500, occurredAt: "2026-10-10T12:00:00.000Z", description: "should not save",
    },
  });
  assert.equal(crossUserTransaction.statusCode, 404);

  const crossUserBudget = await app.inject({
    method: "POST", url: "/api/v1/budgets", headers: auth(bobToken),
    payload: {
      categoryId: aliceCategory.id, amountMinor: 10000,
      periodStart: "2026-10-01", periodEnd: "2026-10-31",
    },
  });
  assert.equal(crossUserBudget.statusCode, 404);

  const transactionResponse = await app.inject({
    method: "POST", url: "/api/v1/transactions", headers: { ...auth(aliceToken), "idempotency-key": "transaction-lunch-2026" },
    payload: {
      accountId: aliceAccount.id, categoryId: aliceCategory.id, kind: "expense",
      amountMinor: 2500, occurredAt: "2026-10-10T12:00:00.000Z", description: "Lunch",
    },
  });
  assert.equal(transactionResponse.statusCode, 201);
  assert.equal(transactionResponse.json().transaction.amountMinor, 2500);

  const replayedTransaction = await app.inject({
    method: "POST", url: "/api/v1/transactions",
    headers: { ...auth(aliceToken), "idempotency-key": "transaction-lunch-2026" },
    payload: {
      accountId: aliceAccount.id, categoryId: aliceCategory.id, kind: "expense",
      amountMinor: 2500, occurredAt: "2026-10-10T12:00:00.000Z", description: "Lunch",
    },
  });
  assert.equal(replayedTransaction.statusCode, 201);
  assert.equal(replayedTransaction.json().transaction.id, transactionResponse.json().transaction.id);

  const reusedKey = await app.inject({
    method: "POST", url: "/api/v1/transactions",
    headers: { ...auth(aliceToken), "idempotency-key": "transaction-lunch-2026" },
    payload: {
      accountId: aliceAccount.id, categoryId: aliceCategory.id, kind: "expense",
      amountMinor: 9999, occurredAt: "2026-10-10T12:00:00.000Z", description: "Lunch",
    },
  });
  assert.equal(reusedKey.statusCode, 409);
  assert.equal(reusedKey.json().error.code, "IDEMPOTENCY_KEY_REUSED");

  const aliceTransactions = await app.inject({ method: "GET", url: "/api/v1/transactions", headers: auth(aliceToken) });
  const bobTransactions = await app.inject({ method: "GET", url: "/api/v1/transactions", headers: auth(bobToken) });
  assert.equal(aliceTransactions.json().transactions.length, 1);
  assert.deepEqual(bobTransactions.json().transactions, []);
});

test("financial routes reject invalid amounts and cross-user transfer accounts", async () => {
  const registerUser = async (username: string) => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username, password },
    });
    assert.equal(response.statusCode, 201);
    return response.json().accessToken as string;
  };
  const aliceToken = await registerUser("alice_finora");
  const bobToken = await registerUser("bob_finora");
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const aliceAccountResponse = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: auth(aliceToken),
    payload: { name: "Savings", type: "savings", currencyCode: "DOP" },
  });
  const bobAccountResponse = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: auth(bobToken),
    payload: { name: "Wallet", type: "cash", currencyCode: "DOP" },
  });
  const aliceAccount = aliceAccountResponse.json().account;
  const bobAccount = bobAccountResponse.json().account;

  const invalidAmount = await app.inject({
    method: "POST", url: "/api/v1/transactions", headers: auth(aliceToken),
    payload: {
      accountId: aliceAccount.id, kind: "expense", amountMinor: 0,
      occurredAt: "2026-10-10T12:00:00.000Z",
    },
  });
  assert.equal(invalidAmount.statusCode, 400);

  const crossUserTransfer = await app.inject({
    method: "POST", url: "/api/v1/transfers", headers: auth(aliceToken),
    payload: {
      fromAccountId: aliceAccount.id, toAccountId: bobAccount.id, amountMinor: 500,
      occurredAt: "2026-10-10T12:00:00.000Z",
    },
  });
  assert.equal(crossUserTransfer.statusCode, 404);

  const selfTransfer = await app.inject({
    method: "POST", url: "/api/v1/transfers", headers: auth(aliceToken),
    payload: {
      fromAccountId: aliceAccount.id, toAccountId: aliceAccount.id, amountMinor: 500,
      occurredAt: "2026-10-10T12:00:00.000Z",
    },
  });
  assert.equal(selfTransfer.statusCode, 400);
});

test("budgets require an owned expense category and duplicate periods are rejected", async () => {
  const registerUser = async (username: string) => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username, password },
    });
    assert.equal(response.statusCode, 201);
    return response.json().accessToken as string;
  };
  const token = await registerUser("budget_owner");
  const auth = { authorization: `Bearer ${token}` };
  const categoryResponse = await app.inject({
    method: "POST", url: "/api/v1/categories", headers: auth,
    payload: { name: "Rent", kind: "expense" },
  });
  const categoryId = categoryResponse.json().category.id;
  const payload = {
    categoryId, amountMinor: 800000,
    periodStart: "2026-10-01", periodEnd: "2026-10-31",
  };
  const first = await app.inject({ method: "POST", url: "/api/v1/budgets", headers: auth, payload });
  assert.equal(first.statusCode, 201);
  const duplicate = await app.inject({ method: "POST", url: "/api/v1/budgets", headers: auth, payload });
  assert.equal(duplicate.statusCode, 409);
});


test("versioned updates reject stale versions and deletes create owner-scoped tombstones", async () => {
  const registerUser = async (username: string) => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username, password },
    });
    assert.equal(response.statusCode, 201);
    return response.json().accessToken as string;
  };
  const aliceToken = await registerUser("version_owner");
  const bobToken = await registerUser("version_other");
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const created = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: auth(aliceToken),
    payload: { name: "Primary", type: "cash", currencyCode: "DOP", openingBalanceMinor: 5000 },
  });
  assert.equal(created.statusCode, 201);
  const accountId = created.json().account.id;

  const updated = await app.inject({
    method: "PATCH", url: `/api/v1/accounts/${accountId}`, headers: auth(aliceToken),
    payload: { expectedVersion: 1, changes: { name: "Main wallet" } },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().resource.syncVersion, 2);

  const staleUpdate = await app.inject({
    method: "PATCH", url: `/api/v1/accounts/${accountId}`, headers: auth(aliceToken),
    payload: { expectedVersion: 1, changes: { name: "Stale name" } },
  });
  assert.equal(staleUpdate.statusCode, 409);
  assert.equal(staleUpdate.json().error.code, "VERSION_CONFLICT");

  const crossUserDelete = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${accountId}`, headers: auth(bobToken),
    payload: { expectedVersion: 2 },
  });
  assert.equal(crossUserDelete.statusCode, 404);

  const deleted = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${accountId}`, headers: auth(aliceToken),
    payload: { expectedVersion: 2 },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().resource.syncVersion, 3);
  assert.equal(typeof deleted.json().resource.deletedAt, "string");

  const visible = await app.inject({
    method: "GET", url: "/api/v1/accounts", headers: auth(aliceToken),
  });
  assert.deepEqual(visible.json().accounts, []);

  const repeatedDelete = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${accountId}`, headers: auth(aliceToken),
    payload: { expectedVersion: 3 },
  });
  assert.equal(repeatedDelete.statusCode, 404);
});


test("versioned edits reject stale writes and deletes create hidden tombstones", async () => {
  const register = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "version_owner", password },
  });
  assert.equal(register.statusCode, 201);
  const token = register.json().accessToken as string;
  const auth = { authorization: `Bearer ${token}` };

  const created = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: auth,
    payload: { name: "Wallet", type: "cash", currencyCode: "DOP", openingBalanceMinor: 5000 },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().account.id as string;

  const updated = await app.inject({
    method: "PATCH", url: `/api/v1/accounts/${id}`, headers: auth,
    payload: { expectedVersion: 1, changes: { name: "Daily wallet" } },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().resource.syncVersion, 2);

  const staleUpdate = await app.inject({
    method: "PATCH", url: `/api/v1/accounts/${id}`, headers: auth,
    payload: { expectedVersion: 1, changes: { name: "Stale overwrite" } },
  });
  assert.equal(staleUpdate.statusCode, 409);
  assert.equal(staleUpdate.json().error.code, "VERSION_CONFLICT");
  assert.equal(staleUpdate.json().currentVersion, 2);

  const listBeforeDelete = await app.inject({
    method: "GET", url: "/api/v1/accounts", headers: auth,
  });
  assert.equal(listBeforeDelete.json().accounts.length, 1);
  assert.equal(listBeforeDelete.json().accounts[0].name, "Daily wallet");
  assert.equal(listBeforeDelete.json().accounts[0].syncVersion, 2);

  const deleted = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${id}`, headers: auth,
    payload: { expectedVersion: 2 },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().resource.syncVersion, 3);

  const listAfterDelete = await app.inject({
    method: "GET", url: "/api/v1/accounts", headers: auth,
  });
  assert.deepEqual(listAfterDelete.json().accounts, []);

  const database = openDatabase(databasePath);
  try {
    const row = database.prepare("SELECT sync_version, deleted_at FROM accounts WHERE id = ?")
      .get(id) as { sync_version: number; deleted_at: string | null };
    assert.equal(row.sync_version, 3);
    assert.equal(typeof row.deleted_at, "string");
  } finally {
    database.close();
  }

  const repeatedDelete = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${id}`, headers: auth,
    payload: { expectedVersion: 3 },
  });
  assert.equal(repeatedDelete.statusCode, 404);
});

test("versioned routes do not allow modifying or deleting another user's records", async () => {
  const register = async (username: string) => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username, password },
    });
    assert.equal(response.statusCode, 201);
    return response.json().accessToken as string;
  };
  const ownerToken = await register("version_owner");
  const otherToken = await register("version_other");
  const created = await app.inject({
    method: "POST", url: "/api/v1/accounts",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Private", type: "cash", currencyCode: "DOP" },
  });
  const id = created.json().account.id as string;

  const update = await app.inject({
    method: "PATCH", url: `/api/v1/accounts/${id}`,
    headers: { authorization: `Bearer ${otherToken}` },
    payload: { expectedVersion: 1, changes: { name: "stolen" } },
  });
  assert.equal(update.statusCode, 404);

  const remove = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${id}`,
    headers: { authorization: `Bearer ${otherToken}` },
    payload: { expectedVersion: 1 },
  });
  assert.equal(remove.statusCode, 404);

  const list = await app.inject({
    method: "GET", url: "/api/v1/accounts",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(list.json().accounts[0].name, "Private");
});


test("versioned updates reject stale and cross-user writes, and deletes create hidden tombstones", async () => {
  const registerUser = async (username: string) => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username, password },
    });
    assert.equal(response.statusCode, 201);
    return response.json().accessToken as string;
  };
  const aliceToken = await registerUser("version_alice");
  const bobToken = await registerUser("version_bob");
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const created = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: auth(aliceToken),
    payload: { name: "Everyday", type: "cash", currencyCode: "DOP", openingBalanceMinor: 2500 },
  });
  assert.equal(created.statusCode, 201);
  const accountId = created.json().account.id as string;

  const crossUser = await app.inject({
    method: "PATCH", url: `/api/v1/accounts/${accountId}`, headers: auth(bobToken),
    payload: { expectedVersion: 1, changes: { name: "Stolen" } },
  });
  assert.equal(crossUser.statusCode, 404);

  const updated = await app.inject({
    method: "PATCH", url: `/api/v1/accounts/${accountId}`, headers: auth(aliceToken),
    payload: { expectedVersion: 1, changes: { name: "Daily" } },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().resource.syncVersion, 2);

  const stale = await app.inject({
    method: "PATCH", url: `/api/v1/accounts/${accountId}`, headers: auth(aliceToken),
    payload: { expectedVersion: 1, changes: { name: "Old update" } },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "VERSION_CONFLICT");

  const deleted = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${accountId}`, headers: auth(aliceToken),
    payload: { expectedVersion: 2 },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().resource.syncVersion, 3);

  const list = await app.inject({
    method: "GET", url: "/api/v1/accounts", headers: auth(aliceToken),
  });
  assert.deepEqual(list.json().accounts, []);

  const database = openDatabase(databasePath);
  try {
    const row = database.prepare("SELECT deleted_at, sync_version FROM accounts WHERE id = ?")
      .get(accountId) as { deleted_at: string | null; sync_version: number };
    assert.equal(typeof row.deleted_at, "string");
    assert.equal(row.sync_version, 3);
  } finally {
    database.close();
  }
});

test("versioned deletes refuse to hide accounts that still have active financial records", async () => {
  const register = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "version_owner", password },
  });
  assert.equal(register.statusCode, 201);
  const token = register.json().accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  const account = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers,
    payload: { name: "Wallet", type: "cash", currencyCode: "DOP" },
  });
  const accountId = account.json().account.id as string;
  const transaction = await app.inject({
    method: "POST", url: "/api/v1/transactions",
    headers: { ...headers, "idempotency-key": "delete-guard-tx-001" },
    payload: {
      accountId, kind: "expense", amountMinor: 100,
      occurredAt: "2026-10-10T12:00:00.000Z", description: "Coffee",
    },
  });
  assert.equal(transaction.statusCode, 201);

  const deleted = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${accountId}`, headers,
    payload: { expectedVersion: 1 },
  });
  assert.equal(deleted.statusCode, 409);
  assert.equal(deleted.json().error.code, "RESOURCE_IN_USE");
});


test("incremental sync pages changes by a monotonic cursor and includes tombstones", async () => {
  const register = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username: "sync_owner", password },
  });
  assert.equal(register.statusCode, 201);
  const token = register.json().accessToken as string;
  const headers = { authorization: `Bearer ${token}` };

  const invalidCursor = await app.inject({
    method: "GET", url: "/api/v1/sync/changes?cursor=-1", headers,
  });
  assert.equal(invalidCursor.statusCode, 400);

  const first = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers,
    payload: { name: "Wallet one", type: "cash", currencyCode: "DOP" },
  });
  const second = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers,
    payload: { name: "Wallet two", type: "bank", currencyCode: "DOP" },
  });
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);

  const page1 = await app.inject({
    method: "GET", url: "/api/v1/sync/changes?cursor=0&limit=1", headers,
  });
  assert.equal(page1.statusCode, 200);
  assert.equal(page1.json().changes.length, 1);
  assert.equal(page1.json().hasMore, true);
  const cursor1 = page1.json().nextCursor as number;

  const page2 = await app.inject({
    method: "GET", url: `/api/v1/sync/changes?cursor=${cursor1}&limit=1`, headers,
  });
  assert.equal(page2.statusCode, 200);
  assert.equal(page2.json().changes.length, 1);
  assert.equal(page2.json().hasMore, false);
  assert.ok(page2.json().nextCursor > cursor1);

  const accountId = first.json().account.id as string;
  const deleted = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${accountId}`, headers,
    payload: { expectedVersion: 1 },
  });
  assert.equal(deleted.statusCode, 200);

  const changesAfterDelete = await app.inject({
    method: "GET", url: `/api/v1/sync/changes?cursor=${page2.json().nextCursor}`, headers,
  });
  assert.equal(changesAfterDelete.statusCode, 200);
  const tombstone = changesAfterDelete.json().changes.find(
    (change: { resource: string; data: { id: string } }) =>
      change.resource === "accounts" && change.data.id === accountId,
  );
  assert.ok(tombstone);
  assert.equal(typeof tombstone.data.deletedAt, "string");
  assert.equal(tombstone.data.syncVersion, 2);
});
