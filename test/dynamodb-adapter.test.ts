import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoDBStore } from "../src/dynamodb-adapter.js";
import { DynamoDBAdapterError, DynamoDBConflictError, UnsupportedQueryError } from "../src/errors.js";
import { entitySk, indexPk, indexSk, modelPk, uniquePk, valueSk } from "../src/keys.js";
import { REVISION_ATTRIBUTE } from "../src/serialize.js";
import type { CleanedWhere } from "../src/types.js";

const eq = (field: string, value: unknown): CleanedWhere => ({ field, value: value as never, operator: "eq", connector: "AND", mode: "sensitive" });
const rev = { [REVISION_ATTRIBUTE]: "rev-1" };

function client(items: unknown[] = []) {
  return {
    send: vi.fn(async (command) => {
      if (command instanceof GetCommand) return { Item: items[0] };
      if (command instanceof QueryCommand) return { Items: items };
      return {};
    })
  };
}

describe("DynamoDBStore", () => {
  it("creates records, scalar sidecars, and derived TTL metadata transactionally", async () => {
    const doc = client();
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl: { defaultField: "expiresAt" } });
    await store.create("session", { id: "s1", userId: "u1", expiresAt: "2030-01-01T00:00:00.000Z", ignored: undefined });
    const command = doc.send.mock.calls[0]?.[0] as TransactWriteCommand;
    const puts = command.input.TransactItems?.map((item) => item.Put?.Item);
    expect(puts?.[0]).toMatchObject({ pk: modelPk("session"), sk: entitySk("s1"), ttl: 1893456000, entity: { id: "s1", userId: "u1" } });
    expect(puts?.[0]).toHaveProperty(REVISION_ATTRIBUTE, expect.any(String));
    expect(puts).toContainEqual(expect.objectContaining({ pk: indexPk("session", "userId", "u1"), sk: indexSk("s1"), ttl: 1893456000 }));
    expect(command.input.ClientRequestToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(command.input.TransactItems?.every((item) => item.Put?.ReturnValuesOnConditionCheckFailure === "ALL_OLD")).toBe(true);
  });

  it("strips top-level and nested undefined values before command construction", async () => {
    const doc = client();
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await store.create("user", { id: "u1", email: undefined, profile: { name: "A", missing: undefined, tags: ["x", undefined, { value: undefined, keep: true }] } });
    const command = doc.send.mock.calls[0]?.[0] as TransactWriteCommand;
    const item = command.input.TransactItems?.[0]?.Put?.Item;
    expect(item).toMatchObject({ entity: { id: "u1", profile: { name: "A", tags: ["x", { keep: true }] } } });
    expect(item).not.toHaveProperty("email");
    expect(item?.entity).not.toHaveProperty("email");
  });

  it("refreshes retained sidecar and unique-lock TTL metadata when the entity TTL is extended", async () => {
    const row = { pk: modelPk("session"), sk: entitySk("s1"), id: "s1", email: "a@example.com", expiresAt: "2030-01-01T00:00:00.000Z", ttl: 1893456000, entity: { id: "s1", email: "a@example.com", expiresAt: "2030-01-01T00:00:00.000Z" }, ...rev };
    const doc = client([row]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl: { defaultField: "expiresAt" }, uniqueFields: { session: ["email"] } });
    await store.update("session", [eq("id", "s1")], { expiresAt: "2031-01-01T00:00:00.000Z" });
    const command = doc.send.mock.calls[1]?.[0] as TransactWriteCommand;
    const updates = command.input.TransactItems?.flatMap((item) => (item.Update ? [item.Update] : [])) ?? [];
    expect(updates).toEqual(expect.arrayContaining([expect.objectContaining({ Key: expect.objectContaining({ pk: indexPk("session", "email", "a@example.com"), sk: indexSk("s1") }), UpdateExpression: "SET #ttl = :ttl", ConditionExpression: "attribute_exists(#pk) AND #ownerPk = :ownerPk AND #ownerSk = :ownerSk", ExpressionAttributeValues: expect.objectContaining({ ":ownerPk": modelPk("session"), ":ownerSk": entitySk("s1"), ":ttl": 1924992000 }) }), expect.objectContaining({ Key: { pk: uniquePk("session", "email"), sk: valueSk("a@example.com", "") }, UpdateExpression: "SET #ttl = :ttl", ExpressionAttributeValues: expect.objectContaining({ ":ttl": 1924992000 }) })]));
    const keys = command.input.TransactItems?.map((item) => `${item.Put?.Item?.pk ?? item.Delete?.Key?.pk ?? item.Update?.Key?.pk}\u0000${item.Put?.Item?.sk ?? item.Delete?.Key?.sk ?? item.Update?.Key?.sk}`) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    expect(updates.every((update) => update.ReturnValuesOnConditionCheckFailure === "ALL_OLD")).toBe(true);
  });

  it("shortens and removes retained sidecar TTL metadata atomically", async () => {
    const row = { pk: modelPk("session"), sk: entitySk("s1"), id: "s1", email: "a@example.com", expiresAt: "2031-01-01T00:00:00.000Z", ttl: 1924992000, entity: { id: "s1", email: "a@example.com", expiresAt: "2031-01-01T00:00:00.000Z" }, ...rev };
    const doc = client([row]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, ttl: { defaultField: "expiresAt" }, uniqueFields: { session: ["email"] } });
    await store.update("session", [eq("id", "s1")], { expiresAt: "2030-01-01T00:00:00.000Z" });
    let command = doc.send.mock.calls[1]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.some((item) => item.Update?.UpdateExpression === "SET #ttl = :ttl" && item.Update.ExpressionAttributeValues?.[":ttl"] === 1893456000)).toBe(true);
    doc.send.mockClear();
    await store.update("session", [eq("id", "s1")], { expiresAt: null });
    command = doc.send.mock.calls[1]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.some((item) => item.Update?.UpdateExpression === "REMOVE #ttl" && item.Update.ExpressionAttributeValues?.[":ownerPk"] === modelPk("session"))).toBe(true);
  });

  it("uses transactional uniqueness locks for configured unique fields", async () => {
    const doc = client();
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, uniqueFields: { user: ["email"] } });
    await store.create("user", { id: "u1", email: "a@example.com" });
    const command = doc.send.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(4);
    expect(command.input.TransactItems).toContainEqual(expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ pk: uniquePk("user", "email") }) }) }));
  });

  it("uses get for id equality lookups and returns Better Auth-visible entity only", async () => {
    const doc = client([{ pk: modelPk("user"), sk: entitySk("u1"), id: "u1", email: "a@example.com", entity: { id: "u1", email: "a@example.com", [REVISION_ATTRIBUTE]: "user-field" }, ...rev }]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.findOne("user", [eq("id", "u1")])).resolves.toEqual({ id: "u1", email: "a@example.com", [REVISION_ATTRIBUTE]: "user-field" });
    expect(doc.send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    expect((doc.send.mock.calls[0]?.[0] as GetCommand).input.ConsistentRead).toBe(true);
  });

  it("uses base-table sidecars for equality filters and verifies owner rows", async () => {
    const owner = { pk: modelPk("user"), sk: entitySk("u1"), id: "u1", email: "a@example.com", entity: { id: "u1", email: "a@example.com" }, ...rev };
    const sidecar = { pk: indexPk("user", "email", "a@example.com"), sk: indexSk("u1"), ownerPk: modelPk("user"), ownerSk: entitySk("u1"), entity: { ownerPk: modelPk("user"), ownerSk: entitySk("u1") } };
    const doc = client([sidecar]);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof QueryCommand) return { Items: [sidecar] };
      if (command instanceof GetCommand) return { Item: owner };
      return {};
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.findMany("user", [eq("email", "a@example.com")], 10)).resolves.toEqual([{ id: "u1", email: "a@example.com" }]);
    const command = doc.send.mock.calls[0]?.[0] as QueryCommand;
    expect(command.input.IndexName).toBeUndefined();
    expect(command.input.ExpressionAttributeValues?.[":pk"]).toBe(indexPk("user", "email", "a@example.com"));
    expect(command.input.ConsistentRead).toBe(true);
  });

  it("preserves typed scalar equality in sidecar keys for plugin-like fields", async () => {
    const doc = client();
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await store.create("member", { id: "m1", organizationId: "1", seat: 1, active: true });
    const command = doc.send.mock.calls[0]?.[0] as TransactWriteCommand;
    const keys = command.input.TransactItems?.map((item) => String(item.Put?.Item?.pk));
    expect(keys).toEqual(expect.arrayContaining([indexPk("member", "organizationId", "1"), indexPk("member", "seat", 1), indexPk("member", "active", true)]));
  });

  it("filters stale sidecars whose owner no longer matches", async () => {
    const sidecar = { pk: indexPk("user", "email", "old"), sk: indexSk("u1"), ownerPk: modelPk("user"), ownerSk: entitySk("u1"), entity: {} };
    const owner = { pk: modelPk("user"), sk: entitySk("u1"), id: "u1", email: "new", entity: { id: "u1", email: "new" }, ...rev };
    const doc = client();
    doc.send.mockImplementation(async (command) => (command instanceof QueryCommand ? { Items: [sidecar] } : { Item: owner }));
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.findMany("user", [eq("email", "old")], 10)).resolves.toEqual([]);
  });

  it("rejects scan-shaped queries unless explicitly enabled", async () => {
    const store = new DynamoDBStore({ tableName: "auth", client: client() as never });
    await expect(store.findMany("user", [{ ...eq("email", "a"), operator: "contains" }], 10)).rejects.toBeInstanceOf(UnsupportedQueryError);
  });

  it("builds conditional atomic consumeOne", async () => {
    const doc = client([{ pk: modelPk("verification"), sk: entitySk("v1"), id: "v1", token: "t", entity: { id: "v1", token: "t" }, ...rev }]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.consumeOne("verification", [eq("id", "v1"), eq("token", "t")])).resolves.toEqual({ id: "v1", token: "t" });
    expect(doc.send.mock.calls[1]?.[0]).toBeInstanceOf(TransactWriteCommand);
    expect((doc.send.mock.calls[1]?.[0] as TransactWriteCommand).input.TransactItems?.[0]?.Delete?.ExpressionAttributeValues).toEqual({ ":revision": "rev-1" });
    expect((doc.send.mock.calls[1]?.[0] as TransactWriteCommand).input.TransactItems?.[0]?.Delete?.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
  });

  it("returns null for consumeOne races that fail after the target read", async () => {
    const doc = client([{ pk: modelPk("verification"), sk: entitySk("v1"), id: "v1", entity: { id: "v1" }, ...rev }]);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: { pk: modelPk("verification"), sk: entitySk("v1"), id: "v1", entity: { id: "v1" }, ...rev } };
      throw new ConditionalCheckFailedException({ message: "race", $metadata: {} });
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.consumeOne("verification", [eq("id", "v1")])).resolves.toBeNull();
  });

  it("propagates unexpected consumeOne AWS failures", async () => {
    const row = { pk: modelPk("verification"), sk: entitySk("v1"), id: "v1", entity: { id: "v1" }, ...rev };
    const throttled = Object.assign(new Error("throttled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }] });
    const doc = client([row]);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: row };
      throw throttled;
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.consumeOne("verification", [eq("id", "v1")])).rejects.toBe(throttled);
  });

  it("builds transactional native ADD incrementOne with guard and sidecar maintenance", async () => {
    const doc = client([{ pk: modelPk("rateLimit"), sk: entitySk("r1"), id: "r1", count: 1, entity: { id: "r1", count: 1 }, ...rev }]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.incrementOne("rateLimit", [eq("id", "r1")], { count: 1 }, { updatedAt: "now" })).resolves.toEqual({ id: "r1", count: 2, updatedAt: "now" });
    const command = doc.send.mock.calls[1]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[0]?.Update?.UpdateExpression).toContain("ADD #inc0 :inc0");
    expect(command.input.TransactItems?.[0]?.Update?.UpdateExpression).toContain("SET #entity = :entity");
    expect(command.input.TransactItems?.[0]?.Update?.ConditionExpression).toBe("attribute_exists(#pk) AND #revision = :revision");
    expect(command.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ":revision": "rev-1", ":inc0": 1, ":entity": { id: "r1", count: 2, updatedAt: "now" } });
    expect(command.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues?.[":newRevision"]).not.toBe("rev-1");
    expect(command.input.TransactItems).toEqual(expect.arrayContaining([expect.objectContaining({ Delete: expect.objectContaining({ Key: { pk: indexPk("rateLimit", "count", 1), sk: indexSk("r1") } }) }), expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ pk: indexPk("rateLimit", "count", 2), sk: indexSk("r1") }) }) })]));
  });

  it("increments a missing numeric field with a valid snapshot guard", async () => {
    const doc = client([{ pk: modelPk("rateLimit"), sk: entitySk("r1"), id: "r1", entity: { id: "r1" }, ...rev }]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.incrementOne("rateLimit", [eq("id", "r1")], { count: 1 })).resolves.toEqual({ id: "r1", count: 1 });
    const command = doc.send.mock.calls[1]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ":revision": "rev-1", ":inc0": 1 });
  });

  it("supports signed increment deltas and returns null for stale increment guards", async () => {
    const row = { pk: modelPk("rateLimit"), sk: entitySk("r1"), id: "r1", count: 3, entity: { id: "r1", count: 3 }, ...rev };
    const stale = Object.assign(new Error("stale"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
    const doc = client([row]);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: row };
      throw stale;
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.incrementOne("rateLimit", [eq("id", "r1")], { count: -2 })).resolves.toBeNull();
    const command = doc.send.mock.calls[1]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ":inc0": -2, ":entity": { id: "r1", count: 1 } });
  });

  it("propagates unexpected increment AWS failures", async () => {
    const row = { pk: modelPk("rateLimit"), sk: entitySk("r1"), id: "r1", count: 1, entity: { id: "r1", count: 1 }, ...rev };
    const throttled = Object.assign(new Error("throttled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }] });
    const doc = client([row]);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: row };
      throw throttled;
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.incrementOne("rateLimit", [eq("id", "r1")], { count: 1 })).rejects.toBe(throttled);
  });

  it("surfaces increment unique-lock conflicts instead of treating later cancellation reasons as stale guards", async () => {
    const row = { pk: modelPk("rateLimit"), sk: entitySk("r1"), id: "r1", count: 1, entity: { id: "r1", count: 1 }, ...rev };
    const conflict = Object.assign(new Error("unique exists"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] });
    const doc = client([row]);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: row };
      throw conflict;
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, uniqueFields: { rateLimit: ["count"] } });
    await expect(store.incrementOne("rateLimit", [eq("id", "r1")], { count: 1 })).rejects.toBeInstanceOf(DynamoDBConflictError);
  });

  it("treats non-number current values as zero and avoids invalid ADD operands", async () => {
    const row = { pk: modelPk("rateLimit"), sk: entitySk("r1"), id: "r1", count: "not-a-number", entity: { id: "r1", count: "not-a-number" }, ...rev };
    const doc = client([row]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    await expect(store.incrementOne("rateLimit", [eq("id", "r1")], { count: 1 })).resolves.toEqual({ id: "r1", count: 1 });
    const command = doc.send.mock.calls[1]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[0]?.Update?.UpdateExpression).toContain("#set0 = :set0");
    expect(command.input.TransactItems?.[0]?.Update?.UpdateExpression).not.toContain("ADD #inc0 :inc0");
    expect(command.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ":set0": 1, ":entity": { id: "r1", count: 1 } });
  });

  it("uses Better Auth fallback semantics when set overlaps increment fields", async () => {
    const row = { pk: modelPk("rateLimit"), sk: entitySk("r1"), id: "r1", count: 1, entity: { id: "r1", count: 1 }, ...rev };
    const doc = client([row]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    await expect(store.incrementOne("rateLimit", [eq("id", "r1")], { count: 1 }, { count: 10 })).resolves.toEqual({ id: "r1", count: 2 });
    const command = doc.send.mock.calls[1]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[0]?.Update?.UpdateExpression).toContain("ADD #inc0 :inc0");
    expect(command.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ":inc0": 1, ":entity": { id: "r1", count: 2 } });
  });

  it("rejects non-finite increment deltas before constructing a transactional update", async () => {
    const row = { pk: modelPk("rateLimit"), sk: entitySk("r1"), id: "r1", entity: { id: "r1" }, ...rev };
    const doc = client([row]);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });

    await expect(store.incrementOne("rateLimit", [eq("id", "r1")], { visits: Number.NaN })).rejects.toBeInstanceOf(DynamoDBAdapterError);
    expect(doc.send.mock.calls.filter((call) => call[0] instanceof TransactWriteCommand)).toHaveLength(0);
  });

  it("paginates sidecar queries before filtering, sorting, and slicing", async () => {
    const sidecar1 = { pk: "p", sk: indexSk("u1"), ownerPk: modelPk("user"), ownerSk: entitySk("u1"), entity: {} };
    const sidecar2 = { pk: "p", sk: indexSk("u2"), ownerPk: modelPk("user"), ownerSk: entitySk("u2"), entity: {} };
    const owners = new Map([
      [entitySk("u1"), { pk: modelPk("user"), sk: entitySk("u1"), id: "u1", org: "o1", email: "b", entity: { id: "u1", org: "o1", email: "b" }, ...rev }],
      [entitySk("u2"), { pk: modelPk("user"), sk: entitySk("u2"), id: "u2", org: "o1", email: "a", entity: { id: "u2", org: "o1", email: "a" }, ...rev }]
    ]);
    const doc = client();
    doc.send.mockImplementation(async (command) => {
      if (command instanceof QueryCommand) return command.input.ExclusiveStartKey ? { Items: [sidecar2] } : { Items: [sidecar1], LastEvaluatedKey: { pk: "p", sk: indexSk("u1") } };
      if (command instanceof GetCommand) return { Item: owners.get(String(command.input.Key?.sk)) };
      return {};
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, pageSize: 1 });
    await expect(store.findMany("user", [eq("org", "o1")], 1, 0, { field: "email", direction: "asc" })).resolves.toEqual([{ id: "u2", org: "o1", email: "a" }]);
    expect((doc.send.mock.calls[0]?.[0] as QueryCommand).input.Limit).toBe(1);
  });

  it("paginates explicit scans for count and hides logically expired rows", async () => {
    const rows = [
      { pk: modelPk("session"), sk: entitySk("s1"), id: "s1", userId: "u1", ttl: 1, entity: { id: "s1", userId: "u1" } },
      { pk: modelPk("session"), sk: entitySk("s2"), id: "s2", userId: "u1", ttl: 1893456000, entity: { id: "s2", userId: "u1" } }
    ];
    const doc = client();
    doc.send.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) return command.input.ExclusiveStartKey ? { Items: [rows[1]] } : { Items: [rows[0]], LastEvaluatedKey: { pk: modelPk("session"), sk: entitySk("s1") } };
      return {};
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true, ttl: { defaultField: "expiresAt" }, pageSize: 1 });
    await expect(store.count("session", [{ ...eq("userId", "u1"), operator: "contains" }])).resolves.toBe(1);
    expect((doc.send.mock.calls[0]?.[0] as ScanCommand).input.ConsistentRead).toBe(true);
    expect((doc.send.mock.calls[0]?.[0] as ScanCommand).input.Limit).toBe(1);
  });

  it("throws instead of returning partial results when maxPages is exhausted", async () => {
    const doc = client();
    doc.send.mockResolvedValue({ Items: [], LastEvaluatedKey: { pk: "p", sk: "s" } } as never);
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true, maxPages: 1 });
    await expect(store.findMany("user", [], 10)).rejects.toThrow(/exceeded maxPages/);
  });

  it("supports update, count, deleteMany and explicit scan mode", async () => {
    const rows = [
      { pk: modelPk("user"), sk: entitySk("u1"), id: "u1", email: "a", entity: { id: "u1", email: "a" }, ...rev },
      { pk: modelPk("user"), sk: entitySk("u2"), id: "u2", email: "b", entity: { id: "u2", email: "b" }, ...rev }
    ];
    const doc = client(rows);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) return { Items: rows };
      if (command instanceof GetCommand) return { Item: rows[0] };
      return {};
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true });
    await expect(store.count("user", [{ ...eq("email", "a"), operator: "contains" }])).resolves.toBe(1);
    await expect(store.update("user", [eq("id", "u1")], { name: "A" })).resolves.toMatchObject({ id: "u1", name: "A" });
    await expect(store.deleteMany("user", [])).resolves.toBe(2);
  });

  it("surfaces update unique-lock conflicts instead of returning null", async () => {
    const row = { pk: modelPk("user"), sk: entitySk("u1"), id: "u1", email: "old@example.com", entity: { id: "u1", email: "old@example.com" }, ...rev };
    const doc = client([row]);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: row };
      const error = new Error("cancelled");
      error.name = "TransactionCanceledException";
      Object.assign(error, { CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed", Message: "unique lock exists" }] });
      throw error;
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, uniqueFields: { user: ["email"] } });
    await expect(store.update("user", [eq("id", "u1")], { email: "new@example.com" })).rejects.toBeInstanceOf(DynamoDBConflictError);
  });

  it("does not classify non-conditional transaction cancellations as write conflicts", async () => {
    const row = { pk: modelPk("user"), sk: entitySk("u1"), id: "u1", entity: { id: "u1" }, ...rev };
    const doc = client([row]);
    const cancelled = Object.assign(new Error("throttled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ProvisionedThroughputExceeded", Message: "slow down" }] });
    doc.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: row };
      throw cancelled;
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.update("user", [eq("id", "u1")], { name: "A" })).rejects.toBe(cancelled);
  });

  it("surfaces delete races consistently", async () => {
    const row = { pk: modelPk("session"), sk: entitySk("s1"), id: "s1", entity: { id: "s1" }, ...rev };
    const doc = client([row]);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: row };
      throw new ConditionalCheckFailedException({ message: "race", $metadata: {} });
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await expect(store.delete("session", [eq("id", "s1")])).rejects.toBeInstanceOf(DynamoDBConflictError);
  });

  it("fails mutations on legacy rows without exposing sensitive old item details in conflict messages", async () => {
    const row = { pk: modelPk("user"), sk: entitySk("u1"), id: "u1", secret: "do-not-log", entity: { id: "u1", secret: "do-not-log" } };
    const store = new DynamoDBStore({ tableName: "auth", client: client([row]) as never });

    await expect(store.update("user", [eq("id", "u1")], { name: "A" })).rejects.toThrow(/missing internal revision metadata/);

    const doc = client([{ ...row, ...rev }]);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: { ...row, ...rev } };
      const error = Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed", Item: row }] });
      throw error;
    });
    await expect(new DynamoDBStore({ tableName: "auth", client: doc as never }).delete("user", [eq("id", "u1")])).rejects.toMatchObject({ message: expect.not.stringContaining("do-not-log") });
  });

  it("generates a fresh ClientRequestToken for each transaction command", async () => {
    const doc = client();
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never });
    await store.create("user", { id: "u1" });
    await store.transactCreate([{ model: "user", data: { id: "u2" } }]);

    const tokens = doc.send.mock.calls.map((call) => (call[0] as TransactWriteCommand).input.ClientRequestToken);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokens[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("deduplicates unique field configuration before writing locks", async () => {
    const doc = client();
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, uniqueFields: { user: ["email", "email"] } });
    await store.create("user", { id: "u1", email: "a@example.com" });
    const command = doc.send.mock.calls[0]?.[0] as TransactWriteCommand;
    const locks = command.input.TransactItems?.filter((item) => item.Put?.Item?.pk === uniquePk("user", "email"));
    expect(locks).toHaveLength(1);
  });

  it("hashes long scalar values in index keys while verifying owner equality", async () => {
    const longValue = "x".repeat(3000);
    const doc = client();
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, uniqueFields: { user: ["email"] } });
    await store.create("user", { id: "u1", email: longValue });
    const command = doc.send.mock.calls[0]?.[0] as TransactWriteCommand;
    const keys = command.input.TransactItems?.map((item) => `${item.Put?.Item?.pk}\u0000${item.Put?.Item?.sk}`) ?? [];
    expect(keys.some((key) => key.includes(longValue))).toBe(false);
    expect(keys).toEqual(expect.arrayContaining([`${indexPk("user", "email", longValue)}\u0000${indexSk("u1")}`, `${uniquePk("user", "email")}\u0000${valueSk(longValue, "")}`]));
  });

  it("rejects oversized id key components actionably", async () => {
    const store = new DynamoDBStore({ tableName: "auth", client: client() as never });
    await expect(store.create("user", { id: "x".repeat(3000) })).rejects.toThrow(/1024-byte sort key limit/);
  });

  it("supports delete, transaction callback, sorted windows, and transactional create command construction", async () => {
    const rows = [
      { pk: modelPk("user"), sk: entitySk("u1"), id: "u1", email: "b", entity: { id: "u1", email: "b" }, ...rev },
      { pk: modelPk("user"), sk: entitySk("u2"), id: "u2", email: "a", entity: { id: "u2", email: "a" }, ...rev }
    ];
    const doc = client(rows);
    doc.send.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) return { Items: rows };
      if (command instanceof GetCommand) return { Item: rows[0] };
      return {};
    });
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true });
    await expect(store.findMany("user", [], 1, 0, { field: "email", direction: "asc" })).resolves.toEqual([{ id: "u2", email: "a" }]);
    await expect(store.transaction(async () => "ok")).resolves.toBe("ok");
    await store.delete("user", [eq("id", "u1")]);
    await store.transactCreate([{ model: "user", data: { id: "u3" } }]);
    expect(doc.send.mock.calls.some((call) => call[0] instanceof TransactWriteCommand)).toBe(true);
  });

  it("sorts numeric sortBy values numerically", async () => {
    const rows = [
      { pk: modelPk("user"), sk: entitySk("u1"), id: "u1", score: 10, entity: { id: "u1", score: 10 }, ...rev },
      { pk: modelPk("user"), sk: entitySk("u2"), id: "u2", score: 2, entity: { id: "u2", score: 2 }, ...rev }
    ];
    const doc = client(rows);
    doc.send.mockImplementation(async (command) => (command instanceof ScanCommand ? { Items: rows } : {}));
    const store = new DynamoDBStore({ tableName: "auth", client: doc as never, unsafeAllowScan: true });
    await expect(store.findMany("user", [], 10, 0, { field: "score", direction: "asc" })).resolves.toEqual([{ id: "u2", score: 2 }, { id: "u1", score: 10 }]);
  });

  it("fails early when sidecars would exceed the DynamoDB transaction item limit", async () => {
    const data = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`f${index}`, String(index)]));
    const store = new DynamoDBStore({ tableName: "auth", client: client() as never });
    await expect(store.create("wide", { id: "w1", ...data })).rejects.toThrow(/TransactWrite limit 100/);
  });
});
