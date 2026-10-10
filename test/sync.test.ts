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
  tempDirectory = mkdtempSync(join(tmpdir(), "finora-sync-test-"));
  app = await buildApp({ databasePath: join(tempDirectory, "test.db") });
});

afterEach(async () => {
  await app.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function register(username: string): Promise<string> {
  const response = await app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { username, password },
  });
  assert.equal(response.statusCode, 201);
  return response.json().accessToken as string;
}

test("incremental changes paginate and include the latest tombstone without leaking other users", async () => {
  const alice = await register("sync_alice");
  const bob = await register("sync_bob");
  const auth = (token: string) => ({ authorization: "Bearer " + token });

  const aliceCreated = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: auth(alice),
    payload: { name: "Wallet", type: "cash", currencyCode: "DOP", openingBalanceMinor: 12345 },
  });
  assert.equal(aliceCreated.statusCode, 201);
  const aliceId = aliceCreated.json().account.id as string;

  const aliceSecondCreated = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: auth(alice),
    payload: { name: "Savings", type: "savings", currencyCode: "DOP" },
  });
  assert.equal(aliceSecondCreated.statusCode, 201);

  const bobCreated = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: auth(bob),
    payload: { name: "Bob wallet", type: "cash", currencyCode: "DOP" },
  });
  assert.equal(bobCreated.statusCode, 201);
  const bobId = bobCreated.json().account.id as string;

  const first = await app.inject({
    method: "GET", url: "/api/v1/sync/changes?cursor=0&limit=1", headers: auth(alice),
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().changes.length, 1);
  assert.equal(first.json().changes[0].data.id, aliceId);
  assert.equal(first.json().hasMore, true);

  const updated = await app.inject({
    method: "PATCH", url: "/api/v1/accounts/" + aliceId, headers: auth(alice),
    payload: { expectedVersion: 1, changes: { name: "Daily wallet" } },
  });
  assert.equal(updated.statusCode, 200);

  const deleted = await app.inject({
    method: "DELETE", url: "/api/v1/accounts/" + aliceId, headers: auth(alice),
    payload: { expectedVersion: 2 },
  });
  assert.equal(deleted.statusCode, 200);

  const next = await app.inject({
    method: "GET", url: "/api/v1/sync/changes?cursor=" + first.json().nextCursor + "&limit=10",
    headers: auth(alice),
  });
  assert.equal(next.statusCode, 200);
  const changes = next.json().changes;
  assert.equal(changes.some((change: { data: { id: string } }) => change.data.id === bobId), false);
  const tombstone = changes.find((change: { data: { id: string } }) => change.data.id === aliceId);
  assert.ok(tombstone);
  assert.equal(tombstone.data.syncVersion, 3);
  assert.equal(typeof tombstone.data.deletedAt, "string");
  assert.equal(tombstone.data.name, "Daily wallet");
  assert.equal(next.json().hasMore, false);
});

test("incremental changes require authentication and reject invalid cursors and limits", async () => {
  const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/sync/changes" });
  assert.equal(unauthenticated.statusCode, 401);

  const token = await register("sync_validation");
  const headers = { authorization: "Bearer " + token };
  for (const url of [
    "/api/v1/sync/changes?cursor=-1",
    "/api/v1/sync/changes?cursor=abc",
    "/api/v1/sync/changes?limit=0",
    "/api/v1/sync/changes?limit=201",
  ]) {
    const response = await app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error.code, "INVALID_SYNC_CURSOR");
  }
});
