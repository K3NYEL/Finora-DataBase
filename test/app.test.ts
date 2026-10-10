import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const allowedOrigin = "https://finora.example";
const password = "a-long-test-password-2026";
let app: FastifyInstance;
let previousOrigins: string | undefined;
let tempDirectory: string;

beforeEach(async () => {
  previousOrigins = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = allowedOrigin;
  tempDirectory = mkdtempSync(join(tmpdir(), "finora-api-test-"));
  app = await buildApp({ databasePath: join(tempDirectory, "test.db") });
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
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], allowedOrigin);
  assert.equal(response.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
});

test("unknown routes return a stable JSON error", async () => {
  const response = await app.inject({ method: "GET", url: "/does-not-exist" });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: { code: "NOT_FOUND", message: "Resource not found" } });
});

test("registration creates an account and returns a bearer session", async () => {
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
