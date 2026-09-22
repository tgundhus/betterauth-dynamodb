import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createDocumentClient } from "../client.js";
import { DynamoDBAdapterError } from "../errors.js";
import { ttlAttribute } from "../serialize.js";
import type { BetterAuthDynamoDBOptions } from "../types.js";
import { TransactionEngine } from "./engine.js";
import { FORMAT, FORMAT_KEY } from "./format.js";
import { Journal } from "./journal.js";

export interface TransactionRecoveryCursor { shard: number; key?: Record<string, unknown> }
export interface TransactionRecoveryResult { examined: number; recovered: number; cursor?: TransactionRecoveryCursor }

/** Run only after stopping incompatible writers and readers; see the storage migration instructions. */
export async function initializeDynamoDBTransactions(options: BetterAuthDynamoDBOptions): Promise<void> {
  const journal = journalFor(options);
  await journal.send([{ Put: { TableName: options.tableName, Item: { ...FORMAT_KEY, format: FORMAT }, ConditionExpression: "attribute_not_exists(pk) OR #format = :format", ExpressionAttributeNames: { "#format": "format" }, ExpressionAttributeValues: { ":format": FORMAT } } }]);
}

/** Explicit maintenance over the transaction registry, never an authentication model scan. */
export async function recoverDynamoDBTransactions(options: BetterAuthDynamoDBOptions, cursor: TransactionRecoveryCursor = { shard: 0 }, limit = 25): Promise<TransactionRecoveryResult> {
  validateCursor(cursor, limit);
  const journal = journalFor(options);
  const engine = new TransactionEngine(journal);
  let examined = 0;
  let recovered = 0;
  let position: TransactionRecoveryCursor | undefined = cursor;
  while (position && examined < limit) {
    const page = await registryPage(journal, position, limit - examined);
    const result = await recoverPage(engine, page.Items ?? []);
    examined += result.examined;
    recovered += result.recovered;
    position = nextCursor(position, page.LastEvaluatedKey);
  }
  return { examined, recovered, ...(position ? { cursor: position } : {}) };
}

async function recoverPage(engine: TransactionEngine, items: Record<string, any>[]) {
  let recovered = 0;
  for (const item of items) if (await engine.recover(item.id)) recovered++;
  return { examined: items.length, recovered };
}

function journalFor(options: BetterAuthDynamoDBOptions): Journal { return new Journal(createDocumentClient(options), options.tableName, ttlAttribute(options.ttl)); }

function validateCursor(cursor: TransactionRecoveryCursor, limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new DynamoDBAdapterError("Recovery limit must be a positive safe integer.");
  if (!Number.isInteger(cursor.shard) || cursor.shard < 0 || cursor.shard > 15) throw new DynamoDBAdapterError("Recovery shard must be between 0 and 15.");
}

function registryPage(journal: Journal, cursor: TransactionRecoveryCursor, limit: number) {
  return journal.client.send(new QueryCommand({ TableName: journal.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": `BETTERAUTH#TX#${cursor.shard.toString(16)}` }, ConsistentRead: true, Limit: limit, ...(cursor.key ? { ExclusiveStartKey: cursor.key } : {}) }));
}

function nextCursor(cursor: TransactionRecoveryCursor, key: Record<string, unknown> | undefined): TransactionRecoveryCursor | undefined {
  if (key) return { shard: cursor.shard, key };
  return cursor.shard < 15 ? { shard: cursor.shard + 1 } : undefined;
}
