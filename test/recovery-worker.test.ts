import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { TransactionEngine } from "../src/transactions/engine.js";
import { INTENT } from "../src/transactions/format.js";
import { Journal } from "../src/transactions/journal.js";
import { runDynamoDBRecoveryWorker } from "../src/transactions/worker.js";
import { MemoryDynamoDB } from "./helpers/memory-dynamodb.js";

describe("scheduled transaction recovery", () => {
  it("continues a durable checkpoint across fresh Lambda invocations and completes repeated passes", async () => {
    const db = new MemoryDynamoDB();
    const options = { tableName: "auth", client: db.asClient() };
    const engine = new TransactionEngine(new Journal(options.client, "auth"));
    db.before = (command) => { if (command instanceof TransactWriteCommand && command.input.TransactItems?.some((action) => action.Put?.ConditionExpression?.includes("#intent.#id"))) throw new Error("interrupted cleanup"); };
    await engine.commit(Array.from({ length: 105 }, (_, index) => ({ key: { pk: "MODEL#test", sk: String(index) }, before: null, after: { pk: "MODEL#test", sk: String(index), value: index } })));
    db.before = () => {};
    const root = [...db.rows.values()].find((row) => row.state === "COMMITTED")!;
    const stopped = await runDynamoDBRecoveryWorker(options, { getRemainingTimeInMillis: () => 10_000 });
    expect(stopped.calls).toBe(0);
    expect(db.get({ pk: "BETTERAUTH#MAINTENANCE", sk: "transactions" })).toBeUndefined();
    let recovered = 0;
    for (let invocation = 0; invocation < 50 && !db.get(root)?.cleaned; invocation++) {
      const result = await runDynamoDBRecoveryWorker(options, { maxCalls: 1, getRemainingTimeInMillis: () => 90_000 });
      recovered += result.recovered;
      expect(result.failures).toEqual([]);
      expect(result.calls).toBe(1);
    }
    expect(recovered).toBe(1);
    expect(db.get(root)?.cleaned).toBe(true);
    expect([...db.rows.values()].some((row) => row[INTENT])).toBe(false);
    expect(await runDynamoDBRecoveryWorker(options)).toMatchObject({ passComplete: true, failures: [] });
  });

  it("reports corruption without losing its checkpoint and rejects overlapping checkpoint writes", async () => {
    const db = new MemoryDynamoDB();
    const options = { tableName: "auth", client: db.asClient() };
    db.put({ pk: "BETTERAUTH#TX#0", sk: "0missing", id: "0missing" });
    const result = await runDynamoDBRecoveryWorker(options, { maxCalls: 1 });
    expect(result.failures).toMatchObject([{ transactionId: "0missing", error: expect.any(Error) }]);
    db.before = (command) => {
      if (command instanceof TransactWriteCommand && command.input.TransactItems?.some((action) => action.Put?.Item?.pk === "BETTERAUTH#MAINTENANCE")) {
        db.put({ pk: "BETTERAUTH#MAINTENANCE", sk: "transactions", revision: "other-worker", cursor: { shard: 0 } });
      }
    };
    await expect(runDynamoDBRecoveryWorker(options)).rejects.toThrow("ConditionalCheckFailed");
    expect(db.get({ pk: "BETTERAUTH#MAINTENANCE", sk: "transactions" })?.revision).toBe("other-worker");
  });

  it("keeps the previous checkpoint when DynamoDB is unavailable", async () => {
    const db = new MemoryDynamoDB();
    const checkpoint = { pk: "BETTERAUTH#MAINTENANCE", sk: "transactions", revision: "last", cursor: { shard: 4 } };
    db.put(checkpoint);
    db.before = (command) => { if (!(command instanceof GetCommand)) throw new Error("offline"); };
    await expect(runDynamoDBRecoveryWorker({ tableName: "auth", client: db.asClient() })).rejects.toThrow("offline");
    expect(db.get(checkpoint)).toEqual(checkpoint);
  });

  it("validates worker names and budgets before issuing DynamoDB requests", async () => {
    const db = new MemoryDynamoDB();
    for (const worker of [{ name: "" }, { name: "é".repeat(513) }, { maxCalls: 0 }, { maxBatchesPerTransaction: 1.5 }, { minRemainingTimeMs: Infinity }]) {
      await expect(runDynamoDBRecoveryWorker({ tableName: "auth", client: db.asClient() }, worker)).rejects.toThrow("Recovery worker");
    }
    expect(db.commands).toEqual([]);
  });
});
