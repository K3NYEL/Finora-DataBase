import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const password = "a-long-test-password-2026";
let app: FastifyInstance;
let tempDirectory: string;

beforeEach(async () => {
  process.env.CORS_ORIGINS = "https://finora.example";
  tempDirectory = mkdtempSync(join(tmpdir(), "finora-versioned-test-"));
  app = await buildApp({ databasePath: join(tempDirectory, "test.db") });
});

afterEach(async () => {
  await app.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function register(username: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { username, password },
  });
  assert.equal(response.statusCode, 201);
  return response.json().accessToken as string;
}

test("updates require the current version and increment sync_version", async () => {
  const token = await register("version_owner");
  const headers = { authorization: `Bearer ${token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/accounts",
    headers,
    payload: { name: "Daily", type: "cash", currencyCode: "DOP", openingBalanceMinor: 1000 },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().account.id as string;

  const updated = await app.inject({
    method: "PATCH",
    url: `/api/v1/accounts/${id}`,
    headers,
    payload: { expectedVersion: 1, changes: { name: "Everyday" } },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().resource.syncVersion, 2);

  const stale = await app.inject({
    method: "PATCH",
    url: `/api/v1/accounts/${id}`,
    headers,
    payload: { expectedVersion: 1, changes: { name: "Stale write" } },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "VERSION_CONFLICT");

  const listed = await app.inject({ method: "GET", url: "/api/v1/accounts", headers });
  assert.equal(listed.json().accounts[0].name, "Everyday");
  assert.equal(listed.json().accounts[0].syncVersion, 2);
});

test("updates and deletes cannot access another user's records", async () => {
  const ownerToken = await register("record_owner");
  const otherToken = await register("other_owner");
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/accounts",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Private", type: "cash", currencyCode: "DOP" },
  });
  const id = created.json().account.id as string;
  const headers = { authorization: `Bearer ${otherToken}` };

  const patch = await app.inject({
    method: "PATCH", url: `/api/v1/accounts/${id}`, headers,
    payload: { expectedVersion: 1, changes: { name: "Stolen" } },
  });
  assert.equal(patch.statusCode, 404);

  const deletion = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${id}`, headers,
    payload: { expectedVersion: 1 },
  });
  assert.equal(deletion.statusCode, 404);

  const ownerList = await app.inject({
    method: "GET", url: "/api/v1/accounts",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(ownerList.json().accounts[0].name, "Private");
});

test("delete creates a tombstone, increments version, and hides the record from normal lists", async () => {
  const token = await register("delete_owner");
  const headers = { authorization: `Bearer ${token}` };
  const created = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers,
    payload: { name: "Temporary", type: "cash", currencyCode: "DOP" },
  });
  const id = created.json().account.id as string;

  const deleted = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${id}`, headers,
    payload: { expectedVersion: 1 },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().resource.syncVersion, 2);
  assert.equal(typeof deleted.json().resource.deletedAt, "string");

  const list = await app.inject({ method: "GET", url: "/api/v1/accounts", headers });
  assert.deepEqual(list.json().accounts, []);

  const repeatedDelete = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${id}`, headers,
    payload: { expectedVersion: 2 },
  });
  assert.equal(repeatedDelete.statusCode, 404);
});

test("accounts and categories with active financial dependencies cannot be tombstoned", async () => {
  const token = await register("dependency_owner");
  const headers = { authorization: `Bearer ${token}` };
  const account = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers,
    payload: { name: "Daily", type: "cash", currencyCode: "DOP" },
  });
  const category = await app.inject({
    method: "POST", url: "/api/v1/categories", headers,
    payload: { name: "Food", kind: "expense" },
  });
  const transaction = await app.inject({
    method: "POST", url: "/api/v1/transactions",
    headers: { ...headers, "idempotency-key": "dependency-transaction-01" },
    payload: {
      accountId: account.json().account.id,
      categoryId: category.json().category.id,
      kind: "expense",
      amountMinor: 1200,
      occurredAt: "2026-10-10T12:00:00.000Z",
      description: "Lunch",
    },
  });
  assert.equal(transaction.statusCode, 201);

  const deleteAccount = await app.inject({
    method: "DELETE", url: `/api/v1/accounts/${account.json().account.id}`, headers,
    payload: { expectedVersion: 1 },
  });
  assert.equal(deleteAccount.statusCode, 409);
  assert.equal(deleteAccount.json().error.code, "RESOURCE_IN_USE");

  const deleteCategory = await app.inject({
    method: "DELETE", url: `/api/v1/categories/${category.json().category.id}`, headers,
    payload: { expectedVersion: 1 },
  });
  assert.equal(deleteCategory.statusCode, 409);
  assert.equal(deleteCategory.json().error.code, "RESOURCE_IN_USE");
});
