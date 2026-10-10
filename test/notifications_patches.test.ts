import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const ADMIN_KEY = "finora-admin-test-key-that-is-long-enough-2026";
const PASSWORD = "notification-test-password";
let app: FastifyInstance;
let oldAdminKey: string | undefined;

beforeEach(async () => {
  oldAdminKey = process.env.FINORA_ADMIN_KEY;
  process.env.FINORA_ADMIN_KEY = ADMIN_KEY;
  app = await buildApp({ databasePath: ":memory:", backupPath: "./data/test-notification-backups" });
});

afterEach(async () => {
  await app.close();
  if (oldAdminKey === undefined) delete process.env.FINORA_ADMIN_KEY;
  else process.env.FINORA_ADMIN_KEY = oldAdminKey;
});

async function register(username = "notice_user"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { username, password: PASSWORD },
  });
  assert.equal(response.statusCode, 201);
  return response.json().accessToken as string;
}

function adminHeaders() {
  return { authorization: "Bearer " + ADMIN_KEY };
}

test("admin can publish a notification; authenticated user can list and mark it read", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/admin/notifications",
    headers: adminHeaders(),
    payload: {
      title: "Mantenimiento programado",
      message: "La API tendrá mantenimiento breve.",
      severity: "info",
    },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().notification.id as string;

  const token = await register();
  const headers = { authorization: "Bearer " + token };
  const listed = await app.inject({ method: "GET", url: "/api/v1/notifications", headers });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().notifications.length, 1);
  assert.equal(listed.json().notifications[0].isRead, false);

  const marked = await app.inject({
    method: "POST",
    url: "/api/v1/notifications/" + id + "/read",
    headers,
  });
  assert.equal(marked.statusCode, 204);

  const listedAgain = await app.inject({ method: "GET", url: "/api/v1/notifications", headers });
  assert.equal(listedAgain.json().notifications[0].isRead, true);
});

test("notification admin publishing rejects invalid data and wrong admin keys", async () => {
  const wrongKey = await app.inject({
    method: "POST",
    url: "/api/v1/admin/notifications",
    headers: { authorization: "Bearer wrong-key" },
    payload: { title: "Test", message: "Test", severity: "info" },
  });
  assert.equal(wrongKey.statusCode, 401);

  const invalid = await app.inject({
    method: "POST",
    url: "/api/v1/admin/notifications",
    headers: adminHeaders(),
    payload: { title: "", message: "Test", severity: "info" },
  });
  assert.equal(invalid.statusCode, 400);
});

test("admin can publish a release patch manifest and clients can request their architecture", async () => {
  const published = await app.inject({
    method: "POST",
    url: "/api/v1/admin/patches",
    headers: adminHeaders(),
    payload: {
      version: "0.5.26",
      build: 36,
      platform: "android",
      architecture: "arm64-v8a",
      downloadUrl: "https://github.com/K3NYEL/finora/releases/download/v0.5.26/Finora_v0.5.26_arm64-v8a.apk",
      sha256: "a".repeat(64),
      sizeBytes: 4_000_000,
      mandatory: false,
      notes: ["Correcciones de estabilidad"],
    },
  });
  assert.equal(published.statusCode, 201);

  const latest = await app.inject({
    method: "GET",
    url: "/api/v1/patches/latest?platform=android&architecture=arm64-v8a",
  });
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.json().patch.version, "0.5.26");
  assert.equal(latest.json().patch.build, 36);
  assert.equal(latest.json().patch.sha256, "a".repeat(64));
  assert.deepEqual(latest.json().patch.notes, ["Correcciones de estabilidad"]);
});

test("patch catalog rejects untrusted URLs and invalid targets", async () => {
  const invalidUrl = await app.inject({
    method: "POST",
    url: "/api/v1/admin/patches",
    headers: adminHeaders(),
    payload: {
      version: "0.5.26",
      build: 36,
      platform: "android",
      architecture: "arm64-v8a",
      downloadUrl: "https://example.com/app.apk",
      sha256: "a".repeat(64),
      sizeBytes: 1000,
    },
  });
  assert.equal(invalidUrl.statusCode, 400);
  assert.equal(invalidUrl.json().error.code, "INVALID_PATCH_URL");

  const invalidTarget = await app.inject({
    method: "GET",
    url: "/api/v1/patches/latest?platform=windows&architecture=x86_64",
  });
  assert.equal(invalidTarget.statusCode, 400);
});

test("admin endpoints stay disabled when no sufficiently long admin key is configured", async () => {
  delete process.env.FINORA_ADMIN_KEY;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/notifications",
    headers: adminHeaders(),
    payload: { title: "Test", message: "Test message", severity: "info" },
  });
  assert.equal(response.statusCode, 503);
});
