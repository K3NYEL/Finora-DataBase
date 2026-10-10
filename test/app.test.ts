import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const allowedOrigin = "https://finora.example";
let app: FastifyInstance;
let previousOrigins: string | undefined;

beforeEach(async () => {
  previousOrigins = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = allowedOrigin;
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  if (previousOrigins === undefined) {
    delete process.env.CORS_ORIGINS;
  } else {
    process.env.CORS_ORIGINS = previousOrigins;
  }
});

test("health endpoint reports the service as available", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "finora-database-api",
  });
});

test("health endpoint allows a configured exact origin", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health",
    headers: { origin: allowedOrigin },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], allowedOrigin);
  assert.equal(response.headers.vary, "Origin");
});

test("requests from unconfigured origins are rejected", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health",
    headers: { origin: "https://unexpected.example" },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "ORIGIN_NOT_ALLOWED");
});

test("preflight requests return the configured CORS policy", async () => {
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/health",
    headers: {
      origin: allowedOrigin,
      "access-control-request-method": "GET",
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
  assert.deepEqual(response.json(), {
    error: { code: "NOT_FOUND", message: "Resource not found" },
  });
});
