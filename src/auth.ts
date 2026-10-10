import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiDatabase } from "./database.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function scryptAsync(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}
const DUMMY_PASSWORD_HASH = hashPassword("dummy-password-never-used-for-an-account");

type Credentials = { username: string; password: string };

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1]!, "base64url");
    const expected = Buffer.from(parts[2]!, "base64url");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH) as Buffer;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCredentials(body: unknown): Credentials | null {
  if (typeof body !== "object" || body === null) return null;
  const value = body as Record<string, unknown>;
  if (typeof value.username !== "string" || typeof value.password !== "string") return null;
  const username = value.username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return null;
  if (value.password.length < 12 || value.password.length > 128) return null;
  return { username, password: value.password };
}

function publicUser(row: { id: string; username: string; created_at: string }) {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

function createSession(database: ApiDatabase, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  database.prepare("DELETE FROM api_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now.toISOString());
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  database.prepare(`
    INSERT INTO api_sessions(id, user_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, hashToken(token), now.toISOString(), expiresAt);
  return { token, expiresAt };
}

function getBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(header);
  return match?.[1] ?? null;
}

async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  database: ApiDatabase,
) {
  const token = getBearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    return null;
  }

  const row = database.prepare(`
    SELECT u.id, u.username, u.created_at
    FROM api_sessions s
    JOIN api_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL
      AND s.expires_at > ? AND u.disabled_at IS NULL
    LIMIT 1
  `).get(hashToken(token), new Date().toISOString()) as
    | { id: string; username: string; created_at: string }
    | undefined;

  if (!row) {
    await reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    return null;
  }
  return row;
}

export async function registerAuthRoutes(app: FastifyInstance, database: ApiDatabase): Promise<void> {
  app.post("/api/v1/auth/register", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const credentials = parseCredentials(request.body);
    if (!credentials) {
      return reply.code(400).send({
        error: { code: "INVALID_CREDENTIALS", message: "Username or password does not meet requirements" },
      });
    }

    const userId = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      database.prepare(`
        INSERT INTO api_users(id, username, password_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(userId, credentials.username, await hashPassword(credentials.password), createdAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return reply.code(409).send({
          error: { code: "ACCOUNT_EXISTS", message: "An account with that username already exists" },
        });
      }
      throw error;
    }

    const session = createSession(database, userId);
    return reply.code(201).send({
      user: { id: userId, username: credentials.username, createdAt },
      accessToken: session.token,
      tokenType: "Bearer",
      expiresAt: session.expiresAt,
    });
  });

  app.post("/api/v1/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const credentials = parseCredentials(request.body);
    if (!credentials) {
      return reply.code(400).send({
        error: { code: "INVALID_CREDENTIALS", message: "Username or password does not meet requirements" },
      });
    }

    const row = database.prepare(`
      SELECT id, username, password_hash, created_at
      FROM api_users WHERE username = ? COLLATE NOCASE AND disabled_at IS NULL LIMIT 1
    `).get(credentials.username) as
      | { id: string; username: string; password_hash: string; created_at: string }
      | undefined;

    const hashToVerify = row?.password_hash ?? await DUMMY_PASSWORD_HASH;
    const passwordValid = await verifyPassword(credentials.password, hashToVerify);
    if (!row || !passwordValid) {
      return reply.code(401).send({
        error: { code: "INVALID_LOGIN", message: "Username or password is incorrect" },
      });
    }

    const session = createSession(database, row.id);
    return reply.send({
      user: publicUser(row),
      accessToken: session.token,
      tokenType: "Bearer",
      expiresAt: session.expiresAt,
    });
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const user = await requireUser(request, reply, database);
    if (!user) return;
    return reply.send({ user: publicUser(user) });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = getBearerToken(request);
    if (!token) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    }
    database.prepare(`
      UPDATE api_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), hashToken(token));
    return reply.code(204).send();
  });
}
