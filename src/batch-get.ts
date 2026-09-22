import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBAdapterError } from "./errors.js";
import type { StoredItem } from "./types.js";

const MAX_BATCH_GET_STALLED_ATTEMPTS = 8;

export async function batchGetAttempts<T = StoredItem>(client: DynamoDBDocumentClient, tableName: string, keys: { pk: string; sk: string }[], consistentRead: boolean, stalledAttempts = 0, rows: T[] = []): Promise<T[]> {
  if (keys.length === 0) return rows;
  const result = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ConsistentRead: consistentRead } } }));
  const nextRows = [...rows, ...((result.Responses?.[tableName] ?? []) as T[])];
  const unprocessed = (result.UnprocessedKeys?.[tableName]?.Keys ?? []) as { pk: string; sk: string }[];
  if (unprocessed.length === 0) return nextRows;
  const nextStalledAttempts = batchGetStalledAttempts(keys.length, unprocessed.length, stalledAttempts);
  await batchGetBackoff(Math.max(1, nextStalledAttempts));
  return batchGetAttempts<T>(client, tableName, unprocessed, consistentRead, nextStalledAttempts, nextRows);
}

function batchGetStalledAttempts(requested: number, unprocessed: number, previous: number): number {
  // Size-limited responses and missing items can make progress without completing a batch.
  const attempts = unprocessed < requested ? 0 : previous + 1;
  if (attempts >= MAX_BATCH_GET_STALLED_ATTEMPTS) throw new DynamoDBAdapterError(`Better Auth DynamoDB BatchGet still had ${unprocessed} unprocessed keys after ${attempts} consecutive attempts without progress.`);
  return attempts;
}

function batchGetBackoff(attempt: number): Promise<void> {
  const maximum = Math.min(2 ** attempt * 10, 1000);
  return new Promise((resolve) => setTimeout(resolve, Math.random() * maximum));
}

