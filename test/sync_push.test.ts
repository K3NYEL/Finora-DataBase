import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const password = "a-long-test-password-2026";
let app: FastifyInstance;
let tempDirectory: string;
beforeEach(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "finora-sync-push-test-"));
  app = await buildApp({ databasePath: join(tempDirectory, "test.db") });
});
afterEach(async () => {
  await app.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});
async function register(username: string): Promise<string> {
  const response = await app.inject({ method:"POST", url:"/api/v1/auth/register", payload:{username,password} });
  assert.equal(response.statusCode,201);
  return response.json().accessToken as string;
}
const uuid = () => crypto.randomUUID();

test("batch push atomically creates a resource and replays an identical idempotent request", async () => {
  const token=await register("push_owner"), id=uuid(), key="sync-push-batch-0001";
  const headers={authorization:"Bearer "+token,"idempotency-key":key};
  const payload={operations:[{opId:"create-account-1",action:"create",resource:"accounts",data:{id,name:"Wallet",type:"cash",currencyCode:"DOP",openingBalanceMinor:12500}}]};
  const first=await app.inject({method:"POST",url:"/api/v1/sync/push",headers,payload});
  assert.equal(first.statusCode,200);
  assert.equal(first.json().results[0].id,id);
  assert.equal(first.json().results[0].syncVersion,1);
  const replay=await app.inject({method:"POST",url:"/api/v1/sync/push",headers,payload});
  assert.equal(replay.statusCode,200);
  assert.deepEqual(replay.json(),first.json());
  const list=await app.inject({method:"GET",url:"/api/v1/accounts",headers:{authorization:"Bearer "+token}});
  assert.equal(list.json().accounts.length,1);
});

test("batch push rejects stale versions and rolls back all operations", async () => {
  const token=await register("push_conflict"), headers={authorization:"Bearer "+token};
  const created=await app.inject({method:"POST",url:"/api/v1/accounts",headers,payload:{name:"Original",type:"cash",currencyCode:"DOP"}});
  const id=created.json().account.id as string;
  const payload={operations:[
    {opId:"update-one",action:"update",resource:"accounts",id,expectedVersion:1,changes:{name:"Changed"}},
    {opId:"update-stale",action:"update",resource:"accounts",id,expectedVersion:1,changes:{name:"Stale"}},
  ]};
  const response=await app.inject({method:"POST",url:"/api/v1/sync/push",headers:{...headers,"idempotency-key":"sync-push-rollback-01"},payload});
  assert.equal(response.statusCode,409);
  assert.equal(response.json().applied,false);
  assert.equal(response.json().error.code,"VERSION_CONFLICT");
  const list=await app.inject({method:"GET",url:"/api/v1/accounts",headers});
  assert.equal(list.json().accounts[0].name,"Original");
  assert.equal(list.json().accounts[0].syncVersion,1);
});

test("batch push requires authentication, idempotency key, UUID IDs, and unique operation IDs", async () => {
  const token=await register("push_validation");
  const payload={operations:[{opId:"create-one",action:"create",resource:"accounts",data:{id:"not-a-uuid",name:"Wallet",type:"cash",currencyCode:"DOP",openingBalanceMinor:0}}]};
  const noAuth=await app.inject({method:"POST",url:"/api/v1/sync/push",payload});
  assert.equal(noAuth.statusCode,401);
  const noKey=await app.inject({method:"POST",url:"/api/v1/sync/push",headers:{authorization:"Bearer "+token},payload:{operations:[{opId:"x",action:"create",resource:"accounts",data:{id:uuid(),name:"Wallet",type:"cash",currencyCode:"DOP",openingBalanceMinor:0}}]}});
  assert.equal(noKey.statusCode,400);
  const invalidId=await app.inject({method:"POST",url:"/api/v1/sync/push",headers:{authorization:"Bearer "+token,"idempotency-key":"sync-push-invalid-01"},payload});
  assert.equal(invalidId.statusCode,400);
  assert.equal(invalidId.json().error.code,"INVALID_SYNC_OPERATION");
  const duplicate=await app.inject({method:"POST",url:"/api/v1/sync/push",headers:{authorization:"Bearer "+token,"idempotency-key":"sync-push-duplicate-1"},payload:{operations:[
    {opId:"same-op",action:"create",resource:"accounts",data:{id:uuid(),name:"A",type:"cash",currencyCode:"DOP",openingBalanceMinor:0}},
    {opId:"same-op",action:"create",resource:"accounts",data:{id:uuid(),name:"B",type:"cash",currencyCode:"DOP",openingBalanceMinor:0}},
  ]}});
  assert.equal(duplicate.statusCode,400);
  assert.equal(duplicate.json().error.code,"DUPLICATE_OPERATION_ID");
});

test("batch push cannot update another user's resource", async () => {
  const owner=await register("push_private"), attacker=await register("push_other");
  const created=await app.inject({method:"POST",url:"/api/v1/accounts",headers:{authorization:"Bearer "+owner},payload:{name:"Private",type:"cash",currencyCode:"DOP"}});
  const id=created.json().account.id as string;
  const response=await app.inject({method:"POST",url:"/api/v1/sync/push",headers:{authorization:"Bearer "+attacker,"idempotency-key":"sync-push-crossuser-1"},payload:{operations:[
    {opId:"steal-update",action:"update",resource:"accounts",id,expectedVersion:1,changes:{name:"Stolen"}},
  ]}});
  assert.equal(response.statusCode,404);
  const list=await app.inject({method:"GET",url:"/api/v1/accounts",headers:{authorization:"Bearer "+owner}});
  assert.equal(list.json().accounts[0].name,"Private");
});
