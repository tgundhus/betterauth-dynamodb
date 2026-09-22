import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { runDynamoDBRecoveryWorker } from "../../src/transactions/worker.js";

const native = new DynamoDBClient({ maxAttempts: 3, requestHandler: { connectionTimeout: 1_000, requestTimeout: 5_000, throwOnRequestTimeout: true } });
const document = DynamoDBDocumentClient.from(native, { marshallOptions: { removeUndefinedValues: true } });

/** EventBridge invokes this handler; no HTTP endpoint or bearer credentials are exposed. */
export async function handler(_event: unknown, context: { getRemainingTimeInMillis(): number }) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error("TABLE_NAME is required");
  const abortSignal = AbortSignal.timeout(Math.max(1, context.getRemainingTimeInMillis() - 5_000));
  const client = { config: document.config, send: (command: any) => document.send(command, { abortSignal }) } as DynamoDBDocumentClient;
  const result = await runDynamoDBRecoveryWorker({ tableName, client, ttl: { attributeName: process.env.TRANSACTION_TTL_ATTRIBUTE ?? "ttl" } }, { getRemainingTimeInMillis: () => context.getRemainingTimeInMillis(), maxCalls: 100, maxBatchesPerTransaction: 1 });
  console.info(JSON.stringify({ event: "transaction-recovery", examined: result.examined, recovered: result.recovered, calls: result.calls, passComplete: result.passComplete, failures: result.failures.map(({ transactionId }) => transactionId) }));
  if (result.failures.length) throw new Error("Transaction recovery requires attention. See the transaction IDs in the structured recovery log.");
  return { examined: result.examined, recovered: result.recovered, passComplete: result.passComplete };
}
