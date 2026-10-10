import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiDatabase } from "./database.js";
import { requireUser } from "./auth.js";
import { executeIdempotently } from "./idempotency.js";

type Resource = "accounts" | "categories" | "transactions" | "transfers" | "budgets";
type Action = "create" | "update" | "delete";
type Rule = { column: string; valid: (value: unknown) => boolean };
type Failure = { status: number; code: string; message: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const str = (max: number) => (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
const optionalStr = (max: number) => (v: unknown) => typeof v === "string" && v.length <= max;
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
const positive = (v: unknown) => integer(v) && (v as number) > 0;
const dateTime = (v: unknown) => typeof v === "string" && Number.isFinite(new Date(v).getTime());
const dateOnly = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(new Date(v + "T00:00:00.000Z").getTime()) && new Date(v + "T00:00:00.000Z").toISOString().slice(0, 10) === v;
const rules: Record<Resource, Record<string, Rule>> = {
  accounts: {
    name: { column: "name", valid: str(80) },
    type: { column: "account_type", valid: v => ["cash","bank","card","savings","investment","other"].includes(String(v)) },
    currencyCode: { column: "currency_code", valid: v => typeof v === "string" && /^[A-Z]{3}$/.test(v) },
    openingBalanceMinor: { column: "opening_balance_minor", valid: integer },
  },
  categories: {
    name: { column: "name", valid: str(80) },
    kind: { column: "kind", valid: v => v === "income" || v === "expense" },
  },
  transactions: {
    accountId: { column: "account_id", valid: v => typeof v === "string" && UUID.test(v) },
    categoryId: { column: "category_id", valid: v => v === null || (typeof v === "string" && UUID.test(v)) },
    kind: { column: "kind", valid: v => v === "income" || v === "expense" },
    amountMinor: { column: "amount_minor", valid: positive },
    occurredAt: { column: "occurred_at", valid: dateTime },
    description: { column: "description", valid: optionalStr(500) },
  },
  transfers: {
    fromAccountId: { column: "from_account_id", valid: v => typeof v === "string" && UUID.test(v) },
    toAccountId: { column: "to_account_id", valid: v => typeof v === "string" && UUID.test(v) },
    amountMinor: { column: "amount_minor", valid: positive },
    occurredAt: { column: "occurred_at", valid: dateTime },
    description: { column: "description", valid: optionalStr(500) },
  },
  budgets: {
    categoryId: { column: "category_id", valid: v => typeof v === "string" && UUID.test(v) },
    amountMinor: { column: "amount_minor", valid: positive },
    periodStart: { column: "period_start", valid: dateOnly },
    periodEnd: { column: "period_end", valid: dateOnly },
  },
};
const columns: Record<Resource, string[]> = {
  accounts: ["id","user_id","name","account_type","currency_code","opening_balance_minor","created_at","updated_at"],
  categories: ["id","user_id","name","kind","created_at","updated_at"],
  transactions: ["id","user_id","account_id","category_id","kind","amount_minor","occurred_at","description","created_at","updated_at"],
  transfers: ["id","user_id","from_account_id","to_account_id","amount_minor","occurred_at","description","created_at","updated_at"],
  budgets: ["id","user_id","category_id","amount_minor","period_start","period_end","created_at","updated_at"],
};
class BatchError extends Error {
  constructor(readonly failure: Failure, readonly opId?: string) { super(failure.message); }
}
function fail(status: number, code: string, message: string): never { throw new BatchError({ status, code, message }); }
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
function ownedActive(db: ApiDatabase, table: Resource, id: string, userId: string) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, userId) as Record<string, unknown> | undefined;
}
function hasKeys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(k => allowed.includes(k)); }
function relationOk(db: ApiDatabase, resource: Resource, row: Record<string, unknown>, userId: string): boolean {
  const owned = (table: "accounts" | "categories", id: unknown) => typeof id === "string" && Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id,userId));
  if (resource === "transactions") {
    if (!owned("accounts", row.account_id)) return false;
    if (row.category_id !== null && row.category_id !== undefined) {
      const category = db.prepare("SELECT kind FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL").get(row.category_id as string,userId) as {kind:string}|undefined;
      if (!category || category.kind !== row.kind) return false;
    }
  }
  if (resource === "transfers") return owned("accounts",row.from_account_id) && owned("accounts",row.to_account_id) && row.from_account_id !== row.to_account_id;
  if (resource === "budgets") {
    const category = db.prepare("SELECT kind FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL").get(row.category_id as string,userId) as {kind:string}|undefined;
    return Boolean(category && category.kind === "expense" && typeof row.period_start === "string" && typeof row.period_end === "string" && row.period_end >= row.period_start);
  }
  return true;
}
function validateOperation(value: unknown): { opId: string; action: Action; resource: Resource; id?: string; expectedVersion?: number; data?: Record<string,unknown>; changes?: Record<string,unknown> } {
  const v = obj(value);
  if (!v || typeof v.opId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(v.opId) ||
      !["create","update","delete"].includes(String(v.action)) ||
      !["accounts","categories","transactions","transfers","budgets"].includes(String(v.resource))) {
    fail(400,"INVALID_SYNC_OPERATION","Each operation requires a valid opId, action, and resource");
  }
  const action = v.action as Action, resource = v.resource as Resource;
  if (action === "create") {
    const data = obj(v.data);
    if (!data || !hasKeys(v,["opId","action","resource","data"]) || !hasKeys(data,["id",...Object.keys(rules[resource])]) || typeof data.id !== "string" || !UUID.test(data.id)) fail(400,"INVALID_SYNC_OPERATION","Create requires a UUID id and only supported resource fields");
    const required = Object.keys(rules[resource]);
    if (required.some(k => !(k in data)) || Object.entries(rules[resource]).some(([k,r]) => !r.valid(data[k]))) fail(400,"INVALID_SYNC_OPERATION","Create contains missing or invalid resource fields");
    return {opId:v.opId,action,resource,data};
  }
  if (typeof v.id !== "string" || !UUID.test(v.id) || !Number.isSafeInteger(v.expectedVersion) || (v.expectedVersion as number)<1) fail(400,"INVALID_SYNC_OPERATION","Update/delete require a UUID id and positive expectedVersion");
  if (action === "delete") {
    if (!hasKeys(v,["opId","action","resource","id","expectedVersion"])) fail(400,"INVALID_SYNC_OPERATION","Delete contains unsupported fields");
    return {opId:v.opId,action,resource,id:v.id,expectedVersion:v.expectedVersion as number};
  }
  const changes = obj(v.changes);
  if (!changes || Object.keys(changes).length===0 || !hasKeys(v,["opId","action","resource","id","expectedVersion","changes"]) ||
      Object.entries(changes).some(([k,val]) => !rules[resource][k] || !rules[resource][k]!.valid(val))) fail(400,"INVALID_SYNC_OPERATION","Update contains unsupported or invalid fields");
  return {opId:v.opId,action,resource,id:v.id,expectedVersion:v.expectedVersion as number,changes};
}
function applyOne(db: ApiDatabase, userId: string, op: ReturnType<typeof validateOperation>) {
  const now = new Date().toISOString();
  if (op.action === "create") {
    const data = op.data!;
    const dbData: Record<string,unknown> = {id:data.id,user_id:userId,created_at:now,updated_at:now};
    for (const [key,value] of Object.entries(data)) if (key !== "id") dbData[rules[op.resource][key]!.column] = key === "occurredAt" && typeof value === "string" ? new Date(value).toISOString() : value;
    if (op.resource === "accounts" && !("opening_balance_minor" in dbData)) dbData.opening_balance_minor=0;
    if (op.resource === "transactions" && !("category_id" in dbData)) dbData.category_id=null;
    if (["transactions","transfers"].includes(op.resource) && !("description" in dbData)) dbData.description="";
    if (!relationOk(db,op.resource,dbData,userId)) fail(404,"RELATED_RESOURCE_NOT_FOUND","A related active resource was not found or is incompatible");
    const names = columns[op.resource].filter(c => c in dbData);
    try {
      db.prepare(`INSERT INTO ${op.resource} (${names.join(",")}) VALUES (${names.map(()=>"?").join(",")})`).run(...names.map(c=>dbData[c] as string|number|null));
    } catch (e) {
      if (e instanceof Error && (e.message.includes("UNIQUE constraint failed") || e.message.includes("PRIMARY KEY"))) fail(409,"RESOURCE_CONFLICT","Create conflicts with an existing resource");
      throw e;
    }
    return {opId:op.opId,action:op.action,resource:op.resource,id:data.id,syncVersion:1};
  }
  const row = ownedActive(db,op.resource,op.id!,userId);
  if (!row) fail(404,"RESOURCE_NOT_FOUND","Resource not found");
  if (row.sync_version !== op.expectedVersion) fail(409,"VERSION_CONFLICT","Resource changed; fetch the latest version before retrying");
  if (op.action === "delete") {
    if (op.resource === "accounts" && db.prepare("SELECT 1 FROM transactions WHERE user_id=? AND account_id=? AND deleted_at IS NULL UNION ALL SELECT 1 FROM transfers WHERE user_id=? AND (from_account_id=? OR to_account_id=?) AND deleted_at IS NULL LIMIT 1").get(userId,op.id,userId,op.id,op.id)) fail(409,"RESOURCE_IN_USE","Account has active financial dependencies");
    if (op.resource === "categories" && db.prepare("SELECT 1 FROM transactions WHERE user_id=? AND category_id=? AND deleted_at IS NULL UNION ALL SELECT 1 FROM budgets WHERE user_id=? AND category_id=? AND deleted_at IS NULL LIMIT 1").get(userId,op.id,userId,op.id)) fail(409,"RESOURCE_IN_USE","Category has active financial dependencies");
    db.prepare(`UPDATE ${op.resource} SET deleted_at=?,updated_at=?,sync_version=sync_version+1 WHERE id=? AND user_id=? AND sync_version=? AND deleted_at IS NULL`).run(now,now,op.id,userId,op.expectedVersion);
    return {opId:op.opId,action:op.action,resource:op.resource,id:op.id,syncVersion:op.expectedVersion!+1};
  }
  const dbChanges = Object.fromEntries(Object.entries(op.changes!).map(([k,v])=>[rules[op.resource][k]!.column,k==="occurredAt"&&typeof v==="string"?new Date(v).toISOString():v]));
  if (op.resource === "categories" && "kind" in op.changes! && op.changes!.kind !== row.kind) {
    const dependent = db.prepare("SELECT 1 FROM transactions WHERE user_id=? AND category_id=? AND deleted_at IS NULL UNION ALL SELECT 1 FROM budgets WHERE user_id=? AND category_id=? AND deleted_at IS NULL LIMIT 1").get(userId,op.id,userId,op.id);
    if (dependent) fail(409,"RESOURCE_IN_USE","Category kind cannot change while active transactions or budgets reference it");
  }
  if (!relationOk(db,op.resource,{...row,...dbChanges},userId)) fail(404,"RELATED_RESOURCE_NOT_FOUND","A related active resource was not found or is incompatible");
  const entries=Object.entries(dbChanges), sets=entries.map(([k])=>`${k}=?`);
  sets.push("updated_at=?","sync_version=sync_version+1");
  try {
    db.prepare(`UPDATE ${op.resource} SET ${sets.join(",")} WHERE id=? AND user_id=? AND sync_version=? AND deleted_at IS NULL`).run(...entries.map(([,v])=>v as string|number|null),now,op.id,userId,op.expectedVersion);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) fail(409,"RESOURCE_CONFLICT","Update conflicts with an existing resource");
    throw e;
  }
  return {opId:op.opId,action:op.action,resource:op.resource,id:op.id,syncVersion:op.expectedVersion!+1};
}
export async function registerSyncPushRoutes(app: FastifyInstance, database: ApiDatabase): Promise<void> {
  app.post("/api/v1/sync/push", async (request: FastifyRequest, reply: FastifyReply) => {
    const user=await requireUser(request,reply,database);
    if(!user)return;
    const body=obj(request.body);
    if(!body || !hasKeys(body,["operations"]) || !Array.isArray(body.operations) || body.operations.length<1 || body.operations.length>50) {
      return reply.code(400).send({error:{code:"INVALID_SYNC_BATCH",message:"Provide between 1 and 50 operations"}});
    }
    let operations: ReturnType<typeof validateOperation>[];
    try {
      operations=body.operations.map(validateOperation);
      if(new Set(operations.map(op=>op.opId)).size!==operations.length) fail(400,"DUPLICATE_OPERATION_ID","opId values must be unique within a batch");
    } catch(e) {
      const failure=e instanceof BatchError?e.failure:{status:400,code:"INVALID_SYNC_OPERATION",message:"Invalid operation"};
      return reply.code(failure.status).send({error:failure});
    }
    const keyHeader=request.headers["idempotency-key"];
    const key=typeof keyHeader==="string"?keyHeader:undefined;
    try {
      const result=executeIdempotently(database,user.id,key,"POST","/api/v1/sync/push",body,()=>{
        const apply=database.transaction(()=>operations.map(op=>applyOne(database,user.id,op)));
        return {statusCode:200,body:{results:apply(),applied:true}};
      });
      if(result.kind==="invalid_key") return reply.code(400).send({error:{code:"IDEMPOTENCY_KEY_REQUIRED",message:"Provide a valid Idempotency-Key header"}});
      if(result.kind==="key_reused") return reply.code(409).send({error:{code:"IDEMPOTENCY_KEY_REUSED",message:"This idempotency key was already used for a different request"}});
      if(result.kind==="in_progress") return reply.code(409).send({error:{code:"IDEMPOTENCY_REQUEST_IN_PROGRESS",message:"A request with this idempotency key is still in progress"}});
      return reply.code(result.statusCode).send(result.body);
    } catch(e) {
      const failure=e instanceof BatchError?e.failure:{status:500,code:"INTERNAL_ERROR",message:"Batch could not be applied"};
      if(failure.status===500) request.log.error({err:e},"Sync batch failed");
      return reply.code(failure.status).send({error:failure,applied:false});
    }
  });
}
