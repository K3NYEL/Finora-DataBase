import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiDatabase } from "./database.js";
import { requireUser } from "./auth.js";

type AuthenticatedUser = { id: string; username: string; created_at: string };
type JsonObject = Record<string, unknown>;
const ACCOUNT_TYPES = new Set(["cash", "bank", "card", "savings", "investment", "other"]);
const TRANSACTION_KINDS = new Set(["income", "expense"]);

function objectBody(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : null;
}

function positiveMinorUnits(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function validDateTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function validDateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

async function authenticated(
  request: FastifyRequest,
  reply: FastifyReply,
  database: ApiDatabase,
): Promise<AuthenticatedUser | null> {
  return await requireUser(request, reply, database) as AuthenticatedUser | null;
}

function ownedAccount(database: ApiDatabase, accountId: string, userId: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?")
    .get(accountId, userId));
}

function ownedCategory(database: ApiDatabase, categoryId: string, userId: string, kind?: string): boolean {
  const row = database.prepare("SELECT kind FROM categories WHERE id = ? AND user_id = ?")
    .get(categoryId, userId) as { kind: string } | undefined;
  return Boolean(row && (!kind || row.kind === kind));
}

export async function registerFinanceRoutes(app: FastifyInstance, database: ApiDatabase): Promise<void> {
  app.get("/api/v1/accounts", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const accounts = database.prepare(`
      SELECT id, name, account_type AS type, currency_code AS currencyCode,
        opening_balance_minor AS openingBalanceMinor, created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts WHERE user_id = ? ORDER BY created_at, id LIMIT 500
    `).all(user.id);
    return reply.send({ accounts });
  });

  app.post("/api/v1/accounts", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const body = objectBody(request.body);
    const name = text(body?.name, 80);
    const type = body?.type;
    const currencyCode = body?.currencyCode;
    const openingBalanceMinor = body?.openingBalanceMinor === undefined ? 0 : body.openingBalanceMinor;
    if (!body || !name || typeof type !== "string" || !ACCOUNT_TYPES.has(type) ||
        typeof currencyCode !== "string" || !/^[A-Z]{3}$/.test(currencyCode) ||
        typeof openingBalanceMinor !== "number" || !Number.isSafeInteger(openingBalanceMinor)) {
      return error(reply, 400, "INVALID_ACCOUNT", "Account fields are invalid");
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO accounts(id, user_id, name, account_type, currency_code, opening_balance_minor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, name, type, currencyCode, openingBalanceMinor, now, now);
    return reply.code(201).send({
      account: { id, name, type, currencyCode, openingBalanceMinor, createdAt: now, updatedAt: now },
    });
  });

  app.get("/api/v1/categories", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const categories = database.prepare(`
      SELECT id, name, kind, created_at AS createdAt, updated_at AS updatedAt
      FROM categories WHERE user_id = ? ORDER BY kind, name COLLATE NOCASE, id LIMIT 500
    `).all(user.id);
    return reply.send({ categories });
  });

  app.post("/api/v1/categories", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const body = objectBody(request.body);
    const name = text(body?.name, 80);
    const kind = body?.kind;
    if (!body || !name || typeof kind !== "string" || !TRANSACTION_KINDS.has(kind)) {
      return error(reply, 400, "INVALID_CATEGORY", "Category fields are invalid");
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      database.prepare(`
        INSERT INTO categories(id, user_id, name, kind, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, user.id, name, kind, now, now);
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("UNIQUE constraint failed")) {
        return error(reply, 409, "CATEGORY_EXISTS", "A category with this name and kind already exists");
      }
      throw cause;
    }
    return reply.code(201).send({ category: { id, name, kind, createdAt: now, updatedAt: now } });
  });

  app.get("/api/v1/transactions", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const transactions = database.prepare(`
      SELECT id, account_id AS accountId, category_id AS categoryId, kind,
        amount_minor AS amountMinor, occurred_at AS occurredAt,
        description, created_at AS createdAt
      FROM transactions WHERE user_id = ? ORDER BY occurred_at DESC, id LIMIT 500
    `).all(user.id);
    return reply.send({ transactions });
  });

  app.post("/api/v1/transactions", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const body = objectBody(request.body);
    const accountId = text(body?.accountId, 64);
    const categoryId = body?.categoryId === undefined || body.categoryId === null
      ? null : text(body.categoryId, 64);
    const kind = body?.kind;
    const amountMinor = positiveMinorUnits(body?.amountMinor);
    const occurredAt = validDateTime(body?.occurredAt);
    const description = optionalText(body?.description, 500);
    if (!body || !accountId || (body.categoryId !== undefined && body.categoryId !== null && !categoryId) ||
        typeof kind !== "string" || !TRANSACTION_KINDS.has(kind) || amountMinor === null ||
        !occurredAt || description === null) {
      return error(reply, 400, "INVALID_TRANSACTION", "Transaction fields are invalid");
    }
    if (!ownedAccount(database, accountId, user.id)) {
      return error(reply, 404, "ACCOUNT_NOT_FOUND", "Account not found");
    }
    if (categoryId && !ownedCategory(database, categoryId, user.id, kind)) {
      return error(reply, 404, "CATEGORY_NOT_FOUND", "Category not found for this transaction");
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(`
      INSERT INTO transactions(id, user_id, account_id, category_id, kind, amount_minor, occurred_at, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, accountId, categoryId, kind, amountMinor, occurredAt, description, createdAt);
    return reply.code(201).send({
      transaction: { id, accountId, categoryId, kind, amountMinor, occurredAt, description, createdAt },
    });
  });

  app.get("/api/v1/transfers", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const transfers = database.prepare(`
      SELECT id, from_account_id AS fromAccountId, to_account_id AS toAccountId,
        amount_minor AS amountMinor, occurred_at AS occurredAt,
        description, created_at AS createdAt
      FROM transfers WHERE user_id = ? ORDER BY occurred_at DESC, id LIMIT 500
    `).all(user.id);
    return reply.send({ transfers });
  });

  app.post("/api/v1/transfers", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const body = objectBody(request.body);
    const fromAccountId = text(body?.fromAccountId, 64);
    const toAccountId = text(body?.toAccountId, 64);
    const amountMinor = positiveMinorUnits(body?.amountMinor);
    const occurredAt = validDateTime(body?.occurredAt);
    const description = optionalText(body?.description, 500);
    if (!body || !fromAccountId || !toAccountId || fromAccountId === toAccountId ||
        amountMinor === null || !occurredAt || description === null) {
      return error(reply, 400, "INVALID_TRANSFER", "Transfer fields are invalid");
    }
    if (!ownedAccount(database, fromAccountId, user.id) || !ownedAccount(database, toAccountId, user.id)) {
      return error(reply, 404, "ACCOUNT_NOT_FOUND", "One or more accounts were not found");
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(`
      INSERT INTO transfers(id, user_id, from_account_id, to_account_id, amount_minor, occurred_at, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, fromAccountId, toAccountId, amountMinor, occurredAt, description, createdAt);
    return reply.code(201).send({
      transfer: { id, fromAccountId, toAccountId, amountMinor, occurredAt, description, createdAt },
    });
  });

  app.get("/api/v1/budgets", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const budgets = database.prepare(`
      SELECT id, category_id AS categoryId, amount_minor AS amountMinor,
        period_start AS periodStart, period_end AS periodEnd,
        created_at AS createdAt, updated_at AS updatedAt
      FROM budgets WHERE user_id = ? ORDER BY period_start DESC, id LIMIT 500
    `).all(user.id);
    return reply.send({ budgets });
  });

  app.post("/api/v1/budgets", async (request, reply) => {
    const user = await authenticated(request, reply, database);
    if (!user) return;
    const body = objectBody(request.body);
    const categoryId = text(body?.categoryId, 64);
    const amountMinor = positiveMinorUnits(body?.amountMinor);
    const periodStart = validDateOnly(body?.periodStart);
    const periodEnd = validDateOnly(body?.periodEnd);
    if (!body || !categoryId || amountMinor === null || !periodStart || !periodEnd || periodEnd < periodStart) {
      return error(reply, 400, "INVALID_BUDGET", "Budget fields are invalid");
    }
    if (!ownedCategory(database, categoryId, user.id, "expense")) {
      return error(reply, 404, "CATEGORY_NOT_FOUND", "Expense category not found");
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      database.prepare(`
        INSERT INTO budgets(id, user_id, category_id, amount_minor, period_start, period_end, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, user.id, categoryId, amountMinor, periodStart, periodEnd, now, now);
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("UNIQUE constraint failed")) {
        return error(reply, 409, "BUDGET_EXISTS", "A budget already exists for this category and period");
      }
      throw cause;
    }
    return reply.code(201).send({
      budget: { id, categoryId, amountMinor, periodStart, periodEnd, createdAt: now, updatedAt: now },
    });
  });
}
