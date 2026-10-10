import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ApiDatabase } from "./database.js";
import { requireUser } from "./auth.js";

const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const MAX_BACKUPS_PER_USER = 10;
const MAX_REQUEST_BYTES = 7 * 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BackupMetadata = {
  id: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  format: "finora-encrypted-backup-v1";
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalDigest(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false;
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try { await chmod(path, 0o700); } catch { /* Windows and some filesystems ignore POSIX modes. */ }
}

async function listMetadata(directory: string): Promise<BackupMetadata[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if (isObject(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const metadata: BackupMetadata[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".meta.json"))) {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (isObject(value) && typeof value.id === "string" &&
          typeof value.createdAt === "string" && typeof value.sizeBytes === "number" &&
          typeof value.sha256 === "string" && value.format === "finora-encrypted-backup-v1") {
        metadata.push(value as BackupMetadata);
      }
    } catch {
      // Ignore incomplete/corrupt metadata entries; never expose filesystem paths.
    }
  }
  return metadata.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function registerBackupRoutes(
  app: FastifyInstance,
  database: ApiDatabase,
  storagePath = process.env.BACKUP_STORAGE_PATH ?? "./data/backups",
): Promise<void> {
  const root = resolve(storagePath);

  app.post("/api/v1/backups", {
    bodyLimit: MAX_REQUEST_BYTES,
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
  }, async (request, reply) => {
    const user = await requireUser(request, reply, database);
    if (!user) return;

    const body: unknown = request.body;
    if (!isObject(body) || body.format !== "finora-encrypted-backup-v1" ||
        typeof body.ciphertext !== "string" || typeof body.sha256 !== "string") {
      return reply.code(400).send({ error: { code: "INVALID_BACKUP", message: "An encrypted backup payload is required" } });
    }

    const encoded = body.ciphertext;
    if (encoded.length === 0 || encoded.length > Math.ceil(MAX_BACKUP_BYTES * 4 / 3) + 4 ||
        !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      return reply.code(413).send({ error: { code: "BACKUP_TOO_LARGE", message: "Backup exceeds the 5 MiB limit or is invalid" } });
    }

    const ciphertext = Buffer.from(encoded, "base64url");
    if (ciphertext.length === 0 || ciphertext.length > MAX_BACKUP_BYTES ||
        ciphertext.toString("base64url") !== encoded) {
      return reply.code(413).send({ error: { code: "BACKUP_TOO_LARGE", message: "Backup exceeds the 5 MiB limit or is invalid" } });
    }

    const digest = createHash("sha256").update(ciphertext).digest("hex");
    if (!equalDigest(digest, body.sha256)) {
      return reply.code(400).send({ error: { code: "BACKUP_CHECKSUM_MISMATCH", message: "Backup checksum does not match" } });
    }

    const directory = join(root, user.id);
    await ensurePrivateDirectory(directory);
    const existing = await listMetadata(directory);
    if (existing.length >= MAX_BACKUPS_PER_USER) {
      return reply.code(409).send({ error: { code: "BACKUP_LIMIT_REACHED", message: "Delete an older backup before uploading another" } });
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const metadata: BackupMetadata = {
      id, createdAt, sizeBytes: ciphertext.length, sha256: digest,
      format: "finora-encrypted-backup-v1",
    };
    const dataPath = join(directory, id + ".enc");
    const metaPath = join(directory, id + ".meta.json");
    const temporaryDataPath = join(directory, id + ".enc.tmp");
    const temporaryMetaPath = join(directory, id + ".meta.tmp");
    try {
      await writeFile(temporaryDataPath, ciphertext, { flag: "wx", mode: 0o600 });
      await writeFile(temporaryMetaPath, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
      await rename(temporaryDataPath, dataPath);
      await rename(temporaryMetaPath, metaPath);
    } catch (error) {
      await Promise.all([
        rm(temporaryDataPath, { force: true }),
        rm(temporaryMetaPath, { force: true }),
        rm(dataPath, { force: true }),
        rm(metaPath, { force: true }),
      ]);
      throw error;
    }

    return reply.code(201).send({ backup: metadata });
  });

  app.get("/api/v1/backups", async (request, reply) => {
    const user = await requireUser(request, reply, database);
    if (!user) return;
    const metadata = await listMetadata(join(root, user.id));
    return reply.send({ backups: metadata });
  });

  app.get("/api/v1/backups/:id", async (request, reply) => {
    const user = await requireUser(request, reply, database);
    if (!user) return;
    const params = request.params as { id?: string };
    if (!params.id || !ID_PATTERN.test(params.id)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Backup not found" } });
    }
    const directory = join(root, user.id);
    const metadata = (await listMetadata(directory)).find((item) => item.id === params.id);
    if (!metadata) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Backup not found" } });
    }
    const ciphertext = await readFile(join(directory, params.id + ".enc"));
    if (ciphertext.length !== metadata.sizeBytes ||
        createHash("sha256").update(ciphertext).digest("hex") !== metadata.sha256) {
      return reply.code(500).send({ error: { code: "BACKUP_CORRUPT", message: "Stored backup failed integrity verification" } });
    }
    return reply.send({ backup: metadata, ciphertext: ciphertext.toString("base64url") });
  });

  app.delete("/api/v1/backups/:id", async (request, reply) => {
    const user = await requireUser(request, reply, database);
    if (!user) return;
    const params = request.params as { id?: string };
    if (!params.id || !ID_PATTERN.test(params.id)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Backup not found" } });
    }
    const directory = join(root, user.id);
    const metadata = (await listMetadata(directory)).find((item) => item.id === params.id);
    if (!metadata) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Backup not found" } });
    }
    await Promise.all([
      rm(join(directory, params.id + ".enc"), { force: true }),
      rm(join(directory, params.id + ".meta.json"), { force: true }),
    ]);
    return reply.code(204).send();
  });
}
