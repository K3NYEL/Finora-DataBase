import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { openDatabase } from "./database.js";
import { registerAuthRoutes } from "./auth.js";
import { registerFinanceRoutes } from "./finance.js";

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

const allowedMethods = new Set(["GET", "POST"]);
const allowedHeaders = new Set(["authorization", "content-type"]);

export async function buildApp(options: { databasePath?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['set-cookie']",
        "*.password",
        "*.password_hash",
        "*.accessToken",
        "*.token",
        "*.secret",
      ],
    },
    bodyLimit: 64 * 1024,
    requestTimeout: 10_000,
  });

  const database = openDatabase(options.databasePath);
  app.addHook("onClose", async () => database.close());

  await app.register(helmet);
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGINS);
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({
        error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed" },
      });
    }

    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers["access-control-request-method"]?.toUpperCase();
      if (requestedMethod && !allowedMethods.has(requestedMethod)) {
        return reply.code(403).send({
          error: { code: "PREFLIGHT_NOT_ALLOWED", message: "Requested method is not allowed" },
        });
      }

      const requestedHeaders = (request.headers["access-control-request-headers"] ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (requestedHeaders.some((header) => !allowedHeaders.has(header))) {
        return reply.code(403).send({
          error: { code: "PREFLIGHT_NOT_ALLOWED", message: "Requested headers are not allowed" },
        });
      }
    }

    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
  });

  app.options("/*", async (_request, reply) => reply.code(204).send());

  app.get("/api/v1/health", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async () => ({ status: "ok", service: "finora-database-api" }));

  await registerAuthRoutes(app, database);
  await registerFinanceRoutes(app, database);

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Resource not found" } }),
  );

  app.setErrorHandler(async (error: unknown, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    const possibleStatusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const statusCode =
      typeof possibleStatusCode === "number" &&
      possibleStatusCode >= 400 &&
      possibleStatusCode < 500
        ? possibleStatusCode
        : 500;

    return reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message: statusCode === 500 ? "An unexpected error occurred" : "Request could not be processed",
      },
    });
  });

  return app;
}
