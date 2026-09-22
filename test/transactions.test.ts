import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDBStore } from "../src/dynamodb-adapter.js";
import { initializeDynamoDBTransactions, recoverDynamoDBTransactions } from "../src/transactions/maintenance.js";
import { INTENT, keyId, PHYSICAL_VERSION, rootKey, versioned } from "../src/transactions/format.js";
import { JournalCodec } from "../src/transactions/codec.js";
import { TransactionEngine, DynamoDBTransactionOutcomeUnknownError } from "../src/transactions/engine.js";
import { Journal } from "../src/transactions/journal.js";
import type { Change } from "../src/transactions/types.js";
import type { CleanedWhere } from "../src/types.js";
import { MemoryDynamoDB } from "./helpers/memory-dynamodb.js";

const eq = (field: string, value: string): CleanedWhere[] => [{ field, value, operator: "eq", mode: "sensitive" }];
const id = (value: string) => eq("id", value);

async function fixture() {
  const db = new MemoryDynamoDB();
  const options = { tableName: "auth", client: db.asClient(), transactions: true, unsafeAllowScan: true, uniqueFields: { user: ["email"] } };
  await initializeDynamoDBTransactions(options);
  return { db, options, store: new DynamoDBStore(options) };
}

function changes(count: number): Change[] {
  return Array.from({ length: count }, (_, index) => { const key = { pk: "MODEL#test", sk: String(index) }; return { key, before: null, after: { ...key, value: index } }; });
}

function updates(command: any): Record<string, any>[] { return command instanceof TransactWriteCommand ? (command.input.TransactItems ?? []).flatMap((action) => action.Update ?? []) : []; }

describe("DynamoDB callback transactions", () => {
  it("commits more than 100 physical items and reads its own creates, updates, increments and deletes", async () => {
    const { store, db } = await fixture();
    const result = await store.transaction(async (trx) => {
      for (let index = 0; index < 45; index++) await trx.create("user", { id: String(index), email: `user${index}@example.test`, count: 0 });
      expect(await trx.count("user")).toBe(45);
      await trx.update("user", id("0"), { email: "changed@example.test" });
      expect(await trx.findOne("user", eq("email", "changed@example.test"))).toMatchObject({ id: "0" });
      expect(await trx.incrementOne("user", id("0"), { count: 2 })).toMatchObject({ count: 2 });
      await trx.delete("user", id("1"));
      expect(await trx.findOne("user", id("1"))).toBeNull();
      expect(await store.count("user")).toBe(0);
      return "committed";
    });
    expect(result).toBe("committed");
    expect(await store.count("user")).toBe(44);
    expect(await store.findOne("user", id("0"))).toMatchObject({ count: 2, email: "changed@example.test" });
    expect([...db.rows.values()].some((row) => row[INTENT])).toBe(false);
  });

  it("discards callback failures, including a saved transaction adapter used after its lifetime", async () => {
    const { store } = await fixture();
    let saved: DynamoDBStore | undefined;
    await expect(store.transaction(async (trx) => { saved = trx; await trx.create("user", { id: "a" }); throw new Error("cancel"); })).rejects.toThrow("cancel");
    expect(await store.findOne("user", id("a"))).toBeNull();
    await expect(saved!.create("user", { id: "b" })).rejects.toThrow("no longer active");
  });

  it("rejects stale read-only and absent-row dependencies without publishing its writes", async () => {
    const { store } = await fixture();
    await store.create("user", { id: "source", email: "source@example.test" });
    await expect(store.transaction(async (trx) => {
      await trx.findOne("user", id("source"));
      await trx.create("session", { id: "s" });
      await store.update("user", id("source"), { email: "new@example.test" });
    })).rejects.toThrow();
    expect(await store.findOne("session", id("s"))).toBeNull();
    await expect(store.transaction(async (trx) => {
      expect(await trx.findOne("user", id("missing"))).toBeNull();
      await trx.create("session", { id: "s2" });
      await store.create("user", { id: "missing" });
    })).rejects.toThrow();
    expect(await store.findOne("session", id("s2"))).toBeNull();
  });

  it("maintains uniqueness across staged records and permits atomic ownership transfer", async () => {
    const { store } = await fixture();
    await expect(store.transaction(async (trx) => {
      await trx.create("user", { id: "a", email: "same@example.test" });
      await trx.create("user", { id: "b", email: "same@example.test" });
    })).rejects.toThrow("same unique value");
    expect(await store.count("user")).toBe(0);
    await store.create("user", { id: "a", email: "a@example.test" });
    await store.create("user", { id: "b", email: "b@example.test" });
    await store.transaction(async (trx) => {
      await trx.update("user", id("a"), { email: "b@example.test" });
      await trx.update("user", id("b"), { email: "a@example.test" });
    });
    expect(await store.findOne("user", eq("email", "b@example.test"))).toMatchObject({ id: "a" });
    expect(await store.findOne("user", eq("email", "a@example.test"))).toMatchObject({ id: "b" });
  });

  it("uses the same callback state for nested transactions and atomic bulk mutations", async () => {
    const { store } = await fixture();
    await store.transaction(async (trx) => {
      await trx.create("user", { id: "a", team: "x" });
      await trx.transaction(async (nested) => { await nested.create("user", { id: "b", team: "x" }); });
      expect(await trx.updateMany("user", eq("team", "x"), { team: "y" })).toBe(2);
      expect(await trx.deleteMany("user", eq("team", "y"))).toBe(2);
      await trx.create("user", { id: "a", team: "z" });
    });
    expect(await store.findMany("user")).toEqual([{ id: "a", team: "z" }]);
  });

  it("requires explicit format initialization", async () => {
    const db = new MemoryDynamoDB();
    const store = new DynamoDBStore({ tableName: "auth", client: db.asClient(), transactions: true });
    await expect(store.create("user", { id: "a" })).rejects.toThrow("initialized transaction storage format");
    await expect(new DynamoDBStore({ tableName: "auth", client: db.asClient() }).transaction(async () => 1)).rejects.toThrow("not enabled");
  });

  it("tracks ID IN reads and preserves requested order for staged rows", async () => {
    const { store } = await fixture();
    await store.create("user", { id: "a" });
    await store.transaction(async (trx) => {
      await trx.create("user", { id: "b" });
      await trx.create("user", { id: "c" });
      const where: CleanedWhere[] = [{ field: "id", value: ["c", "a", "b"], operator: "in", mode: "sensitive" }];
      expect((await trx.findMany<{ id: string }>("user", where)).map((row) => row.id)).toEqual(["c", "a", "b"]);
      await trx.update("user", id("a"), { name: "updated" });
      expect((await trx.findMany<{ id: string }>("user", where)).map((row) => row.id)).toEqual(["c", "a", "b"]);
    });
  });

  it("keeps ordinary increments, conditional conflicts, and consumes working in transaction mode", async () => {
    const { store } = await fixture();
    await store.create("user", { id: "a", email: "same@example.test", count: 0 });
    await expect(store.create("user", { id: "b", email: "same@example.test" })).rejects.toThrow();
    expect(await store.incrementOne("user", id("a"), { count: 3 })).toMatchObject({ count: 3 });
    expect(await store.consumeOne("user", id("a"))).toMatchObject({ count: 3 });
    expect(await store.findOne("user", id("a"))).toBeNull();
  });

  it("ordinary writes help clean committed intents and subsequent recovery cannot overwrite them", async () => {
    const { store, db, options } = await fixture();
    db.before = (command) => { if (command instanceof TransactWriteCommand && command.input.TransactItems?.some((action) => action.Put?.ConditionExpression?.includes("#intent.#id"))) throw new Error("pause cleanup"); };
    await store.transaction(async (trx) => { await trx.create("user", { id: "a", email: "before@example.test", name: "before" }); });
    db.before = () => {};
    await store.update("user", id("a"), { email: "after@example.test", name: "after" });
    await recoverDynamoDBTransactions(options);
    expect(await store.findOne("user", id("a"))).toEqual({ id: "a", email: "after@example.test", name: "after" });
  });
});

describe("durable commit and recovery", () => {
  it("rolls back an interrupted preparation after a complete 99-item batch", async () => {
    const db = new MemoryDynamoDB();
    const engine = new TransactionEngine(new Journal(db.asClient(), "auth"));
    db.before = (command) => { if (updates(command).some((update) => update.ExpressionAttributeValues?.[":before"] === 99)) throw new Error("interrupted"); };
    await expect(engine.commit(changes(150))).rejects.toThrow("interrupted");
    expect([...db.rows.values()].filter((row) => row.pk === "MODEL#test")).toEqual([]);
    expect([...db.rows.values()].some((row) => row[INTENT])).toBe(false);
  });

  it("recognizes a committed transaction after its acknowledgement is lost", async () => {
    const db = new MemoryDynamoDB();
    const engine = new TransactionEngine(new Journal(db.asClient(), "auth"));
    db.after = (command) => { if (updates(command).some((update) => update.ExpressionAttributeValues?.[":committed"] === "COMMITTED" && update.UpdateExpression === "SET #state = :committed")) throw new Error("lost acknowledgement"); };
    await engine.commit(changes(105));
    expect([...db.rows.values()].filter((row) => row.pk === "MODEL#test")).toHaveLength(105);
  });

  it("keeps committed data readable after cleanup failure and lets a fresh worker recover", async () => {
    const db = new MemoryDynamoDB();
    const journal = new Journal(db.asClient(), "auth");
    const engine = new TransactionEngine(journal);
    db.before = (command) => { if (command instanceof TransactWriteCommand && command.input.TransactItems?.some((action) => action.Put?.ConditionExpression?.includes("#intent.#id"))) throw new Error("cleanup unavailable"); };
    await engine.commit(changes(105));
    const raw = db.get({ pk: "MODEL#test", sk: "0" })!;
    expect(raw[INTENT]).toBeDefined();
    expect(await engine.resolve(raw, { pk: raw.pk, sk: raw.sk })).toMatchObject({ value: 0 });
    db.before = () => {};
    expect(await recoverDynamoDBTransactions({ tableName: "auth", client: db.asClient() })).toMatchObject({ recovered: 1 });
    expect([...db.rows.values()].some((row) => row[INTENT])).toBe(false);
  });

  it("does not report rollback when neither commit nor abort can be acknowledged", async () => {
    const db = new MemoryDynamoDB();
    const engine = new TransactionEngine(new Journal(db.asClient(), "auth"));
    db.before = (command) => { if (updates(command).some((update) => update.ExpressionAttributeValues?.[":before"] === 99 || update.ExpressionAttributeValues?.[":aborted"] === "ABORTED")) throw new Error("offline"); };
    await expect(engine.commit(changes(120))).rejects.toBeInstanceOf(DynamoDBTransactionOutcomeUnknownError);
    const root = [...db.rows.values()].find((row) => row.state === "PREPARING")!;
    const raw = db.get({ pk: "MODEL#test", sk: "0" })!;
    expect(await engine.resolve(raw, { pk: raw.pk, sk: raw.sk })).toBeNull();
    db.before = () => {};
    db.put({ ...root, expires: 0 });
    expect(await engine.recover(root.id)).toBe(true);
    expect(db.get({ pk: "MODEL#test", sk: "0" })).toBeUndefined();
    expect((await engine.journal.get(rootKey(root.id)))?.state).toBe("ABORTED");
  });

  it("restores existing records after abort and protects versioned snapshots from ABA writes", async () => {
    const db = new MemoryDynamoDB();
    const journal = new Journal(db.asClient(), "auth");
    const engine = new TransactionEngine(journal);
    const before = versioned({ pk: "MODEL#test", sk: "a", value: "old" });
    db.put(before);
    db.put(versioned({ ...before, value: "old" }));
    await expect(engine.commit([{ key: { pk: before.pk, sk: before.sk }, before, after: { ...before, value: "new" } }])).rejects.toThrow("ConditionalCheckFailed");
    expect(db.get(before)).toMatchObject({ value: "old" });
    expect(db.get(before)?.[PHYSICAL_VERSION]).not.toBe(before[PHYSICAL_VERSION]);
    await expect(engine.commit([...changes(1), ...changes(1)])).rejects.toThrow("duplicate physical keys");
    expect(keyId({ pk: "a\u0000b", sk: "c" })).not.toBe(keyId({ pk: "a", sk: "b\u0000c" }));
  });
});

it("journals binary, sets, large numbers and large payloads without JSON type loss", () => {
  const codec = new JournalCodec();
  const input = { text: "x".repeat(280_000), binary: Buffer.from([0, 1, 255]), binaries: new Set([Buffer.from([1]), Buffer.from([2])]), numbers: new Set([1, 2]), strings: new Set(["a", "b"]), huge: 9007199254740993n, B: "ordinary attribute", BS: ["ordinary"] };
  const parts = codec.encode(input);
  expect(parts.length).toBeGreaterThan(1);
  expect(codec.decode(parts)).toEqual(input);
  expect(codec.decode(codec.encode(null))).toBeNull();
});
