import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ApiDatabase } from "./database.js";
import { requireUser } from "./auth.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARCHITECTURES = new Set(["arm64-v8a", "armeabi-v7a", "x86_64", "universal"]);
const SEVERITIES = new Set(["info", "success", "warning", "critical"]);
const MAX_PATCH_BYTES = 100 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adminKeyMatches(request: FastifyRequest): boolean | "unconfigured" {
  const configured = process.env.FINORA_ADMIN_KEY;
  if (!configured || configured.length < 32) return "unconfigured";
  const authorization = request.headers.authorization;
  const match = authorization && /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization);
  if (!match) return false;
  const supplied = Buffer.from(match[1]!, "utf8");
  const expected = Buffer.from(configured, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function rejectAdmin(reply: FastifyReply, request: FastifyRequest): boolean {
  const result = adminKeyMatches(request);
  if (result === "unconfigured") {
    void reply.code(503).send({ error: { code: "ADMIN_NOT_CONFIGURED", message: "Admin publishing is not configured" } });
    return true;
  }
  if (!result) {
    void reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Admin authentication required" } });
    return true;
  }
  return false;
}

function publicPatch(row: Record<string, unknown>) {
  let notes: unknown = [];
  try {
    const parsed: unknown = JSON.parse(String(row.notes_json ?? "[]"));
    if (Array.isArray(parsed)) notes = parsed;
  } catch {
    notes = [];
  }
  return {
    id: row.id,
    version: row.version,
    build: row.build,
    platform: row.platform,
    architecture: row.architecture,
    downloadUrl: row.download_url,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    mandatory: row.mandatory === 1,
    notes,
    createdAt: row.created_at,
  };
}

export async function registerNotificationAndPatchRoutes(
  app: FastifyInstance,
  database: ApiDatabase,
): Promise<void> {
  app.get("/api/v1/notifications", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const user = await requireUser(request, reply, database);
    if (!user) return;
    const now = new Date().toISOString();
    const rows = database.prepare(`
      SELECT n.id, n.title, n.message, n.severity, n.created_at, n.expires_at,
             CASE WHEN r.notification_id IS NULL THEN 0 ELSE 1 END AS is_read
      FROM notifications n
      LEFT JOIN notification_reads r
        ON r.notification_id = n.id AND r.user_id = ?
      WHERE n.published = 1 AND (n.expires_at IS NULL OR n.expires_at > ?)
      ORDER BY n.created_at DESC
      LIMIT 100
    `).all(user.id, now) as Array<Record<string, unknown>>;
    return reply.send({
      notifications: rows.map((row) => ({
        id: row.id, title: row.title, message: row.message, severity: row.severity,
        createdAt: row.created_at, expiresAt: row.expires_at, isRead: row.is_read === 1,
      })),
    });
  });

  app.post("/api/v1/notifications/:id/read", async (request, reply) => {
    const user = await requireUser(request, reply, database);
    if (!user) return;
    const params = request.params as { id?: string };
    if (!params.id || !UUID_PATTERN.test(params.id)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Notification not found" } });
    }
    const notification = database.prepare(`
      SELECT id FROM notifications
      WHERE id = ? AND published = 1 AND (expires_at IS NULL OR expires_at > ?)
    `).get(params.id, new Date().toISOString());
    if (!notification) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Notification not found" } });
    }
    database.prepare(`
      INSERT INTO notification_reads(notification_id, user_id, read_at)
      VALUES (?, ?, ?)
      ON CONFLICT(notification_id, user_id) DO UPDATE SET read_at = excluded.read_at
    `).run(params.id, user.id, new Date().toISOString());
    return reply.code(204).send();
  });

  app.post("/api/v1/admin/notifications", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (rejectAdmin(reply, request)) return;
    const body: unknown = request.body;
    if (!isRecord(body) || typeof body.title !== "string" ||
        body.title.trim().length < 1 || body.title.trim().length > 120 ||
        typeof body.message !== "string" || body.message.trim().length < 1 ||
        body.message.trim().length > 2000 ||
        typeof body.severity !== "string" || !SEVERITIES.has(body.severity)) {
      return reply.code(400).send({ error: { code: "INVALID_NOTIFICATION", message: "Invalid notification fields" } });
    }
    let expiresAt: string | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== "string" || !Number.isFinite(Date.parse(body.expiresAt))) {
        return reply.code(400).send({ error: { code: "INVALID_EXPIRY", message: "expiresAt must be an ISO-compatible date" } });
      }
      expiresAt = new Date(body.expiresAt).toISOString();
      if (expiresAt <= new Date().toISOString()) {
        return reply.code(400).send({ error: { code: "INVALID_EXPIRY", message: "expiresAt must be in the future" } });
      }
    }
    const notification = {
      id: randomUUID(), title: body.title.trim(), message: body.message.trim(),
      severity: body.severity, createdAt: new Date().toISOString(), expiresAt,
    };
    database.prepare(`
      INSERT INTO notifications(id, title, message, severity, created_at, expires_at, published)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(notification.id, notification.title, notification.message, notification.severity,
      notification.createdAt, notification.expiresAt);
    return reply.code(201).send({ notification });
  });

  app.get("/api/v1/patches/latest", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const query = request.query as { platform?: string; architecture?: string };
    const platform = query.platform ?? "android";
    const architecture = query.architecture;
    if (platform !== "android" || !architecture || !ARCHITECTURES.has(architecture)) {
      return reply.code(400).send({
        error: { code: "INVALID_PATCH_TARGET", message: "Use platform=android and a supported architecture" },
      });
    }
    const row = database.prepare(`
      SELECT id, version, build, platform, architecture, download_url, sha256,
             size_bytes, mandatory, notes_json, created_at
      FROM patch_releases
      WHERE published = 1 AND platform = ? AND architecture IN (?, 'universal')
      ORDER BY build DESC, CASE WHEN architecture = ? THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `).get(platform, architecture, architecture) as Record<string, unknown> | undefined;
    if (!row) return reply.send({ patch: null });
    return reply.header("Cache-Control", "no-store").send({ patch: publicPatch(row) });
  });

  app.post("/api/v1/admin/patches", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (rejectAdmin(reply, request)) return;
    const body: unknown = request.body;
    if (!isRecord(body) ||
        typeof body.version !== "string" || !/^\d+\.\d+\.\d+$/.test(body.version) ||
        !Number.isSafeInteger(body.build) || (body.build as number) < 1 ||
        body.platform !== "android" ||
        typeof body.architecture !== "string" || !ARCHITECTURES.has(body.architecture) ||
        typeof body.downloadUrl !== "string" ||
        !/^[a-f0-9]{64}$/i.test(String(body.sha256 ?? "")) ||
        !Number.isSafeInteger(body.sizeBytes) || (body.sizeBytes as number) < 1 ||
        (body.sizeBytes as number) > MAX_PATCH_BYTES ||
        (body.mandatory !== undefined && typeof body.mandatory !== "boolean") ||
        (body.notes !== undefined && (!Array.isArray(body.notes) || body.notes.length > 20 ||
          body.notes.some((note) => typeof note !== "string" || note.trim().length > 300)))) {
      return reply.code(400).send({ error: { code: "INVALID_PATCH", message: "Invalid patch manifest fields" } });
    }

    let url: URL;
    try { url = new URL(body.downloadUrl); }
    catch { return reply.code(400).send({ error: { code: "INVALID_PATCH_URL", message: "A trusted HTTPS release asset URL is required" } }); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" ||
        !url.pathname.startsWith("/K3NYEL/finora/releases/download/")) {
      return reply.code(400).send({ error: { code: "INVALID_PATCH_URL", message: "Patch assets must use Finora GitHub Release HTTPS URLs" } });
    }

    const notes = Array.isArray(body.notes)
      ? body.notes.map((note) => (note as string).trim()).filter(Boolean)
      : [];
    const record = {
      id: randomUUID(), version: body.version, build: body.build as number,
      platform: body.platform, architecture: body.architecture, downloadUrl: url.toString(),
      sha256: (body.sha256 as string).toLowerCase(), sizeBytes: body.sizeBytes as number,
      mandatory: body.mandatory === true, notes, createdAt: new Date().toISOString(),
    };
    try {
      database.prepare(`
        INSERT INTO patch_releases(
          id, version, build, platform, architecture, download_url, sha256,
          size_bytes, mandatory, notes_json, created_at, published
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(record.id, record.version, record.build, record.platform, record.architecture,
        record.downloadUrl, record.sha256, record.sizeBytes, record.mandatory ? 1 : 0,
        JSON.stringify(record.notes), record.createdAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return reply.code(409).send({ error: { code: "PATCH_ALREADY_EXISTS", message: "A patch already exists for this version, build, platform and architecture" } });
      }
      throw error;
    }
    return reply.code(201).send({ patch: record });
  });
}
