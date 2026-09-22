import { randomUUID } from "node:crypto";
import { createDocumentClient } from "../client.js";
import { DynamoDBAdapterError } from "../errors.js";
import { ttlAttribute } from "../serialize.js";
import type { BetterAuthDynamoDBOptions } from "../types.js";
import { Journal } from "./journal.js";
import { recoverDynamoDBTransactions } from "./maintenance.js";
import type { TransactionRecoveryCursor, TransactionRecoveryFailure } from "./maintenance.js";

export interface DynamoDBRecoveryWorkerOptions {
  /** Separate checkpoints for independently scheduled workers. Defaults to transactions. */
  name?: string;
  /** Maximum registry calls per invocation. Defaults to 25. */
  maxCalls?: number;
  /** Cleanup batches per transaction per call. Defaults to 1. */
  maxBatchesPerTransaction?: number;
  /** Lambda context.getRemainingTimeInMillis, or the equivalent runtime deadline. */
  getRemainingTimeInMillis?: () => number;
  /** Stop starting work below this runtime budget. Defaults to 30 seconds. */
  minRemainingTimeMs?: number;
}

export interface DynamoDBRecoveryWorkerResult {
  examined: number;
  recovered: number;
  calls: number;
  passComplete: boolean;
  failures: TransactionRecoveryFailure[];
}

/** Run bounded maintenance, durably checkpointing progress in the same DynamoDB table. */
export async function runDynamoDBRecoveryWorker(options: BetterAuthDynamoDBOptions, worker: DynamoDBRecoveryWorkerOptions = {}): Promise<DynamoDBRecoveryWorkerResult> {
  const settings = workerSettings(worker);
  const client = createDocumentClient(options);
  const journal = new Journal(client, options.tableName, ttlAttribute(options.ttl));
  const key = { pk: "BETTERAUTH#MAINTENANCE", sk: settings.name };
  let checkpoint = await journal.get(key);
  const result: DynamoDBRecoveryWorkerResult = { examined: 0, recovered: 0, calls: 0, passComplete: false, failures: [] };
  while (result.calls < settings.maxCalls && runtimeAllowsWork(worker, settings.minRemainingTimeMs)) {
    const page = await recoverDynamoDBTransactions({ ...options, client }, checkpoint?.cursor as TransactionRecoveryCursor | undefined, 1, { maxBatchesPerTransaction: settings.maxBatchesPerTransaction, continueOnError: true });
    const next = { ...key, revision: randomUUID(), cursor: page.cursor ?? { shard: 0 }, updatedAt: new Date().toISOString() };
    await journal.send([{ Put: { TableName: options.tableName, Item: next, ...checkpointGuard(checkpoint?.revision) } }]);
    checkpoint = next;
    result.calls++;
    result.examined += page.examined;
    result.recovered += page.recovered;
    result.failures.push(...page.failures);
    if (!page.cursor) { result.passComplete = true; break; }
  }
  return result;
}

function workerSettings(worker: DynamoDBRecoveryWorkerOptions) {
  const settings = { name: worker.name ?? "transactions", ...workerBudgets(worker) };
  if (!settings.name || Buffer.byteLength(settings.name) > 1024) throw new DynamoDBAdapterError("Recovery worker name must contain 1 to 1024 UTF-8 bytes.");
  return settings;
}

function workerBudgets(worker: DynamoDBRecoveryWorkerOptions) {
  const budgets = { maxCalls: worker.maxCalls ?? 25, maxBatchesPerTransaction: worker.maxBatchesPerTransaction ?? 1, minRemainingTimeMs: worker.minRemainingTimeMs ?? 30_000 };
  validateBudgets(Object.values(budgets));
  return budgets;
}

function validateBudgets(values: number[]): void {
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1) throw new DynamoDBAdapterError("Recovery worker budgets must be positive safe integers.");
  }
}

function runtimeAllowsWork(worker: DynamoDBRecoveryWorkerOptions, minimum: number): boolean {
  return !worker.getRemainingTimeInMillis || worker.getRemainingTimeInMillis() >= minimum;
}

function checkpointGuard(revision: unknown) {
  if (revision === undefined) return { ConditionExpression: "attribute_not_exists(pk)" };
  return { ConditionExpression: "revision = :revision", ExpressionAttributeValues: { ":revision": revision } };
}
