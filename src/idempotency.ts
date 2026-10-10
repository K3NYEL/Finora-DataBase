import { createHash } from "node:crypto";
import type { ApiDatabase } from "./database.js";

export type IdempotencyResult<T> =
  | { kind: "ok"; statusCode: number; body: T; replayed: boolean }
  | { kind: "invalid_key" }
  | { kind: "key_reused" }
  | { kind: "in_progress" };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function executeIdempotently<T>(
  database: ApiDatabase,
  userId: string,
  key: string | undefined,
  method: string,
  path: string,
  requestBody: unknown,
  operation: () => { statusCode: number; body: T },
): IdempotencyResult<T> {
  if (!key || key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    return { kind: "invalid_key" };
  }

  const requestHash = createHash("sha256")
    .update(canonicalJson({ method, path, body: requestBody }))
    .digest("hex");

  const run = database.transaction((): IdempotencyResult<T> => {
    const existing = database.prepare(`
      SELECT request_hash AS requestHash, response_status AS responseStatus,
        response_json AS responseJson
      FROM api_idempotency_keys
      WHERE user_id = ? AND idempotency_key = ?
    `).get(userId, key) as {
      requestHash: string;
      responseStatus: number | null;
      responseJson: string | null;
    } | undefined;

    if (existing) {
      if (existing.requestHash !== requestHash) return { kind: "key_reused" };
      if (existing.responseStatus === null || existing.responseJson === null) {
        return { kind: "in_progress" };
      }
      return {
        kind: "ok",
        statusCode: existing.responseStatus,
        body: JSON.parse(existing.responseJson) as T,
        replayed: true,
      };
    }

    database.prepare(`
      INSERT INTO api_idempotency_keys(
        user_id, idempotency_key, request_hash, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(userId, key, requestHash, new Date().toISOString());

    const result = operation();
    database.prepare(`
      UPDATE api_idempotency_keys
      SET response_status = ?, response_json = ?, completed_at = ?
      WHERE user_id = ? AND idempotency_key = ?
    `).run(
      result.statusCode,
      JSON.stringify(result.body),
      new Date().toISOString(),
      userId,
      key,
    );
    return { kind: "ok", ...result, replayed: false };
  });

  return run();
}
