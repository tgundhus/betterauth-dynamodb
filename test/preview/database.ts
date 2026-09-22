import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { GenericContainer, Wait } from "testcontainers";
import { MemoryDynamoDB } from "../helpers/memory-dynamodb.js";
import { measuredClient } from "./metrics.js";

/** Each native run owns a newly created table; no existing table name is accepted. */
export async function previewDatabase() {
  const region = process.env.SCIM_PREVIEW_AWS_REGION;
  if (region && process.env.SCIM_PREVIEW_DYNAMODB === "1") throw new Error("Choose AWS staging or DynamoDB Local, not both");
  if (!region && process.env.SCIM_PREVIEW_DYNAMODB !== "1") {
    const database = new MemoryDynamoDB();
    // Retaining every payload-bearing request would distort this scale test's memory use.
    database.before = () => { database.commands.length = 0; };
    const metrics = measuredClient(database.asClient());
    return { options: { tableName: "large-scim", client: metrics.client, transactions: true }, close: async () => {}, metrics };
  }
  const container = region ? undefined : await new GenericContainer("amazon/dynamodb-local:2.6.1")
    .withExposedPorts(8000)
    .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb", "-disableTelemetry"])
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const native = new DynamoDBClient({ region: region ?? "us-east-1", maxAttempts: 3, requestHandler: { connectionTimeout: 1_000, requestTimeout: 20_000, throwOnRequestTimeout: true }, ...(container ? { endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`, credentials: { accessKeyId: "fake", secretAccessKey: "fake" } } : {}) });
  const tableName = `scim_preview_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  const close = async () => {
    try { if (created) await native.send(new DeleteTableCommand({ TableName: tableName })); }
    finally { native.destroy(); await container?.stop(); }
  };
  console.info(JSON.stringify({ event: "preview-table", backend: region ? "aws" : "local", tableName, region: region ?? "us-east-1" }));
  try {
    await native.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
    created = true;
    await waitUntilTableExists({ client: native, maxWaitTime: region ? 120 : 20, minDelay: 1 }, { TableName: tableName });
    const metrics = measuredClient(DynamoDBDocumentClient.from(native, { marshallOptions: { removeUndefinedValues: true } }));
    return { options: { tableName, client: metrics.client, transactions: true }, close, metrics };
  } catch (error) {
    await close();
    throw error;
  }
}
