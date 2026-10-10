import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const password = "backup-test-password-2026";
let app: FastifyInstance;
let tempDirectory: string;
let backupDirectory: string;

beforeEach(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "finora-backup-test-"));
  backupDirectory = join(tempDirectory, "backups");
  app = await buildApp({
    databasePath: join(tempDirectory, "test.db"),
    backupPath: backupDirectory,
  });
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

function backupPayload(data = Buffer.from("opaque encrypted backup bytes")) {
  return {
    format: "finora-encrypted-backup-v1",
    ciphertext: data.toString("base64url"),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

test("backup endpoints require an authenticated session", async () => {
  const payload = backupPayload();
  const upload = await app.inject({ method: "POST", url: "/api/v1/backups", payload });
  assert.equal(upload.statusCode, 401);
  const list = await app.inject({ method: "GET", url: "/api/v1/backups" });
  assert.equal(list.statusCode, 401);
});

test("authenticated user can upload, list, download, and delete an encrypted backup", async () => {
  const token = await register("backup_owner");
  const headers = { authorization: "Bearer " + token };
  const payload = backupPayload();

  const uploaded = await app.inject({
    method: "POST", url: "/api/v1/backups", headers, payload,
  });
  assert.equal(uploaded.statusCode, 201);
  const metadata = uploaded.json().backup;
  assert.equal(metadata.format, "finora-encrypted-backup-v1");
  assert.equal(metadata.sizeBytes, Buffer.from(payload.ciphertext, "base64url").length);
  assert.equal(metadata.sha256, payload.sha256);
  assert.equal(typeof metadata.id, "string");

  const listed = await app.inject({ method: "GET", url: "/api/v1/backups", headers });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().backups.length, 1);
  assert.equal(listed.json().backups[0].id, metadata.id);

  const downloaded = await app.inject({
    method: "GET", url: "/api/v1/backups/" + metadata.id, headers,
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.json().ciphertext, payload.ciphertext);
  assert.equal(downloaded.json().backup.sha256, payload.sha256);

  const deleted = await app.inject({
    method: "DELETE", url: "/api/v1/backups/" + metadata.id, headers,
  });
  assert.equal(deleted.statusCode, 204);

  const empty = await app.inject({ method: "GET", url: "/api/v1/backups", headers });
  assert.deepEqual(empty.json().backups, []);
});

test("backup data is isolated between users", async () => {
  const ownerToken = await register("backup_owner2");
  const otherToken = await register("backup_other");
  const payload = backupPayload();
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/backups",
    headers: { authorization: "Bearer " + ownerToken },
    payload,
  });
  const id = created.json().backup.id as string;

  const otherHeaders = { authorization: "Bearer " + otherToken };
  const download = await app.inject({
    method: "GET", url: "/api/v1/backups/" + id, headers: otherHeaders,
  });
  assert.equal(download.statusCode, 404);
  const deletion = await app.inject({
    method: "DELETE", url: "/api/v1/backups/" + id, headers: otherHeaders,
  });
  assert.equal(deletion.statusCode, 404);

  const ownerList = await app.inject({
    method: "GET", url: "/api/v1/backups",
    headers: { authorization: "Bearer " + ownerToken },
  });
  assert.equal(ownerList.json().backups.length, 1);
});

test("server rejects a backup with a mismatched checksum and invalid UUID paths", async () => {
  const token = await register("backup_validation");
  const headers = { authorization: "Bearer " + token };
  const invalid = await app.inject({
    method: "POST",
    url: "/api/v1/backups",
    headers,
    payload: { ...backupPayload(), sha256: "0".repeat(64) },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "BACKUP_CHECKSUM_MISMATCH");

  const invalidId = await app.inject({
    method: "GET", url: "/api/v1/backups/not-a-uuid", headers,
  });
  assert.equal(invalidId.statusCode, 404);
});
