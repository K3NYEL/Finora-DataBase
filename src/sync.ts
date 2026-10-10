import type { FastifyInstance } from "fastify";
import type { ApiDatabase } from "./database.js";
import { requireUser } from "./auth.js";

const TABLES = ["accounts", "categories", "transactions", "transfers", "budgets"] as const;
type TableName = typeof TABLES[number];

function serialize(table: TableName, row: Record<string, unknown>) {
  const common = { id: row.id, syncVersion: row.sync_version, syncCursor: row.sync_seq,
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
  switch (table) {
    case "accounts": return { ...common, name: row.name, type: row.account_type,
      currencyCode: row.currency_code, openingBalanceMinor: row.opening_balance_minor };
    case "categories": return { ...common, name: row.name, kind: row.kind };
    case "transactions": return { ...common, accountId: row.account_id, categoryId: row.category_id,
      kind: row.kind, amountMinor: row.amount_minor, occurredAt: row.occurred_at, description: row.description };
    case "transfers": return { ...common, fromAccountId: row.from_account_id, toAccountId: row.to_account_id,
      amountMinor: row.amount_minor, occurredAt: row.occurred_at, description: row.description };
    case "budgets": return { ...common, categoryId: row.category_id, amountMinor: row.amount_minor,
      periodStart: row.period_start, periodEnd: row.period_end };
  }
}

export async function registerSyncRoutes(app: FastifyInstance, database: ApiDatabase): Promise<void> {
  app.get("/api/v1/sync/changes", async (request, reply) => {
    const user = await requireUser(request, reply, database);
    if (!user) return;
    const query = request.query as { cursor?: string; limit?: string };
    const cursor = query.cursor === undefined ? 0 : Number(query.cursor);
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return reply.code(400).send({ error: { code: "INVALID_SYNC_CURSOR", message: "cursor must be a non-negative integer and limit must be between 1 and 200" } });
    }

    // One synchronous SQLite transaction gives a stable watermark and matching row snapshots.
    const result = database.transaction(() => {
      const watermark = (database.prepare("SELECT value FROM sync_clock WHERE id = 1").get() as { value: number }).value;
      const unions = TABLES.map((table) =>
        `SELECT sync_seq AS seq, '${table}' AS resource, id FROM ${table}
         WHERE user_id = ? AND sync_seq > ? AND sync_seq <= ?`).join(" UNION ALL ");
      const candidates = database.prepare(`
        SELECT seq, resource, id FROM (${unions}) ORDER BY seq ASC LIMIT ?
      `).all(...TABLES.flatMap(() => [user.id, cursor, watermark]), limit + 1) as
        Array<{ seq: number; resource: TableName; id: string }>;
      const hasMore = candidates.length > limit;
      const page = candidates.slice(0, limit);
      const changes = page.map((candidate) => {
        const row = database.prepare(`SELECT * FROM ${candidate.resource}
          WHERE id = ? AND user_id = ? AND sync_seq = ?`)
          .get(candidate.id, user.id, candidate.seq) as Record<string, unknown> | undefined;
        return row ? { resource: candidate.resource, data: serialize(candidate.resource, row) } : null;
      }).filter((item): item is NonNullable<typeof item> => item !== null);
      const nextCursor = hasMore ? page[page.length - 1]!.seq : watermark;
      return { changes, nextCursor, hasMore, limit };
    });
    return reply.send(result());
  });
}
