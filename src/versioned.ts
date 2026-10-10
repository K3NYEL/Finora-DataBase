import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiDatabase } from "./database.js";
import { requireUser } from "./auth.js";

type Resource = "accounts" | "categories" | "transactions" | "transfers" | "budgets";
type FieldRule = { column: string; validate: (value: unknown) => boolean };
type ResourceConfig = { fields: Record<string, FieldRule> };

const nonEmpty = (max: number) => (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
const optionalString = (max: number) => (value: unknown): boolean =>
  typeof value === "string" && value.length <= max;
const positiveInteger = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const integer = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value);
const dateTime = (value: unknown): boolean =>
  typeof value === "string" && Number.isFinite(new Date(value).getTime());
const dateOnly = (value: unknown): boolean =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(new Date(value + "T00:00:00.000Z").getTime()) &&
  new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) === value;

const resources: Record<Resource, ResourceConfig> = {
  accounts: { fields: {
    name: { column: "name", validate: nonEmpty(80) },
    type: { column: "account_type", validate: (v) => ["cash", "bank", "card", "savings", "investment", "other"].includes(String(v)) },
    currencyCode: { column: "currency_code", validate: (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v) },
    openingBalanceMinor: { column: "opening_balance_minor", validate: integer },
  } },
  categories: { fields: {
    name: { column: "name", validate: nonEmpty(80) },
  } },
  transactions: { fields: {
    accountId: { column: "account_id", validate: nonEmpty(64) },
    categoryId: { column: "category_id", validate: (v) => v === null || nonEmpty(64)(v) },
    kind: { column: "kind", validate: (v) => v === "income" || v === "expense" },
    amountMinor: { column: "amount_minor", validate: positiveInteger },
    occurredAt: { column: "occurred_at", validate: dateTime },
    description: { column: "description", validate: optionalString(500) },
  } },
  transfers: { fields: {
    fromAccountId: { column: "from_account_id", validate: nonEmpty(64) },
    toAccountId: { column: "to_account_id", validate: nonEmpty(64) },
    amountMinor: { column: "amount_minor", validate: positiveInteger },
    occurredAt: { column: "occurred_at", validate: dateTime },
    description: { column: "description", validate: optionalString(500) },
  } },
  budgets: { fields: {
    categoryId: { column: "category_id", validate: nonEmpty(64) },
    amountMinor: { column: "amount_minor", validate: positiveInteger },
    periodStart: { column: "period_start", validate: dateOnly },
    periodEnd: { column: "period_end", validate: dateOnly },
  } },
};

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
function bodyObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
async function currentUser(request: FastifyRequest, reply: FastifyReply, database: ApiDatabase) {
  return await requireUser(request, reply, database) as { id: string } | null;
}
function ownedActive(database: ApiDatabase, table: string, id: string, userId: string) {
  return database.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .get(id, userId) as Record<string, unknown> | undefined;
}
function validRelations(database: ApiDatabase, resource: Resource, changes: Record<string, unknown>, row: Record<string, unknown>, userId: string): boolean {
  const merged = { ...row, ...changes };
  const owns = (table: string, id: unknown) => typeof id === "string" && Boolean(
    database.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, userId),
  );
  if (resource === "transactions") {
    if (!owns("accounts", merged.account_id)) return false;
    if (merged.category_id !== null && merged.category_id !== undefined) {
      const category = database.prepare("SELECT kind FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
        .get(merged.category_id, userId) as { kind: string } | undefined;
      if (!category || category.kind !== merged.kind) return false;
    }
  }
  if (resource === "transfers") {
    if (!owns("accounts", merged.from_account_id) || !owns("accounts", merged.to_account_id) ||
        merged.from_account_id === merged.to_account_id) return false;
  }
  if (resource === "budgets") {
    const category = database.prepare("SELECT kind FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
      .get(merged.category_id, userId) as { kind: string } | undefined;
    if (!category || category.kind !== "expense") return false;
    if (typeof merged.period_start !== "string" || typeof merged.period_end !== "string" ||
        merged.period_end < merged.period_start) return false;
  }
  return true;
}

export async function registerVersionedRoutes(app: FastifyInstance, database: ApiDatabase): Promise<void> {
  app.patch("/api/v1/:resource/:id", async (request, reply) => {
    const user = await currentUser(request, reply, database);
    if (!user) return;
    const params = request.params as { resource?: string; id?: string };
    if (!params.resource || !Object.hasOwn(resources, params.resource) || !params.id) {
      return sendError(reply, 404, "NOT_FOUND", "Resource not found");
    }
    const resource = params.resource as Resource;
    const body = bodyObject(request.body);
    const expectedVersion = body?.expectedVersion;
    const changes = bodyObject(body?.changes);
    if (!body || !Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1 ||
        !changes || Object.keys(changes).length === 0) {
      return sendError(reply, 400, "INVALID_UPDATE", "expectedVersion and a non-empty changes object are required");
    }
    const config = resources[resource];
    const entries = Object.entries(changes);
    if (entries.some(([key, value]) => !(key in config.fields) || !config.fields[key]!.validate(value))) {
      return sendError(reply, 400, "INVALID_UPDATE", "One or more fields are invalid or immutable");
    }

    const databaseChanges = Object.fromEntries(entries.map(([key, value]) => [config.fields[key]!.column, value]));
    const run = database.transaction(() => {
      const row = ownedActive(database, resource, params.id!, user.id);
      if (!row) return { kind: "missing" as const };
      if (row.sync_version !== expectedVersion) return { kind: "conflict" as const, currentVersion: row.sync_version as number };
      if (!validRelations(database, resource, databaseChanges, row, user.id)) return { kind: "relation" as const };
      const now = new Date().toISOString();
      const assignments = entries.map(([key]) => `${config.fields[key]!.column} = ?`);
      assignments.push("updated_at = ?", "sync_version = sync_version + 1");
      const values = entries.map(([key, value]) => {
        if (key === "occurredAt" && typeof value === "string") return new Date(value).toISOString();
        return value;
      });
      const result = database.prepare(`
        UPDATE ${resource} SET ${assignments.join(", ")}
        WHERE id = ? AND user_id = ? AND sync_version = ? AND deleted_at IS NULL
      `).run(...values, now, params.id, user.id, expectedVersion);
      if (result.changes !== 1) return { kind: "conflict" as const };
      return { kind: "ok" as const, id: params.id, syncVersion: (expectedVersion as number) + 1, updatedAt: now };
    });
    try {
      const result = run();
      if (result.kind === "missing") return sendError(reply, 404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (result.kind === "conflict") return reply.code(409).send({ error: { code: "VERSION_CONFLICT", message: "Resource changed; fetch the latest version before retrying" }, currentVersion: result.currentVersion });
      if (result.kind === "relation") return sendError(reply, 404, "RELATED_RESOURCE_NOT_FOUND", "A related resource was not found or is incompatible");
      return reply.send({ resource: result });
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("UNIQUE constraint failed")) {
        return sendError(reply, 409, "RESOURCE_CONFLICT", "The update conflicts with an existing resource");
      }
      throw cause;
    }
  });

  app.delete("/api/v1/:resource/:id", async (request, reply) => {
    const user = await currentUser(request, reply, database);
    if (!user) return;
    const params = request.params as { resource?: string; id?: string };
    if (!params.resource || !(params.resource in resources) || !params.id) {
      return sendError(reply, 404, "NOT_FOUND", "Resource not found");
    }
    const body = bodyObject(request.body);
    const expectedVersion = body?.expectedVersion;
    if (!body || !Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1 ||
        Object.keys(body).some((key) => key !== "expectedVersion")) {
      return sendError(reply, 400, "INVALID_DELETE", "expectedVersion is required");
    }
    const resource = params.resource as Resource;
    const run = database.transaction(() => {
      const row = ownedActive(database, resource, params.id!, user.id);
      if (!row) return { kind: "missing" as const };
      if (row.sync_version !== expectedVersion) return { kind: "conflict" as const, currentVersion: row.sync_version as number };
      if (resource === "accounts") {
        const dependent = database.prepare(`
          SELECT 1 FROM transactions WHERE user_id = ? AND account_id = ? AND deleted_at IS NULL
          UNION ALL SELECT 1 FROM transfers WHERE user_id = ? AND (from_account_id = ? OR to_account_id = ?) AND deleted_at IS NULL
          LIMIT 1
        `).get(user.id, params.id, user.id, params.id, params.id);
        if (dependent) return { kind: "in_use" as const };
      }
      if (resource === "categories") {
        const dependent = database.prepare(`
          SELECT 1 FROM transactions WHERE user_id = ? AND category_id = ? AND deleted_at IS NULL
          UNION ALL SELECT 1 FROM budgets WHERE user_id = ? AND category_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(user.id, params.id, user.id, params.id);
        if (dependent) return { kind: "in_use" as const };
      }
      const now = new Date().toISOString();
      const result = database.prepare(`
        UPDATE ${resource}
        SET deleted_at = ?, updated_at = ?, sync_version = sync_version + 1
        WHERE id = ? AND user_id = ? AND sync_version = ? AND deleted_at IS NULL
      `).run(now, now, params.id, user.id, expectedVersion);
      if (result.changes !== 1) return { kind: "conflict" as const };
      return { kind: "ok" as const, id: params.id, syncVersion: (expectedVersion as number) + 1, deletedAt: now };
    });
    const result = run();
    if (result.kind === "missing") return sendError(reply, 404, "RESOURCE_NOT_FOUND", "Resource not found");
    if (result.kind === "conflict") return reply.code(409).send({ error: { code: "VERSION_CONFLICT", message: "Resource changed; fetch the latest version before retrying" }, currentVersion: result.currentVersion });
    if (result.kind === "in_use") return sendError(reply, 409, "RESOURCE_IN_USE", "Delete dependent financial records before deleting this resource");
    return reply.send({ resource: result });
  });
}
