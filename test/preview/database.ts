import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { GenericContainer, Wait } from "testcontainers";
import { MemoryDynamoDB } from "../helpers/memory-dynamodb.js";

/** Run the same scale contract against the command double or an isolated DynamoDB Local container. */
export async function previewDatabase() {
  if (process.env.SCIM_PREVIEW_DYNAMODB !== "1") {
    const database = new MemoryDynamoDB();
    // Retaining every payload-bearing request would distort this scale test's memory use.
    database.before = () => { database.commands.length = 0; };
    return { options: { tableName: "large-scim", client: database.asClient(), transactions: true }, close: async () => {} };
  }
  const container = await new GenericContainer("amazon/dynamodb-local:2.6.1")
    .withExposedPorts(8000)
    .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb", "-disableTelemetry"])
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const native = new DynamoDBClient({ region: "us-east-1", endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`, credentials: { accessKeyId: "fake", secretAccessKey: "fake" } });
  const close = async () => { native.destroy(); await container.stop(); };
  try {
    const tableName = `scim_preview_${randomUUID().replaceAll("-", "")}`;
    await native.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
    await waitUntilTableExists({ client: native, maxWaitTime: 20, minDelay: 1 }, { TableName: tableName });
    return { options: { tableName, client: DynamoDBDocumentClient.from(native, { marshallOptions: { removeUndefinedValues: true } }), transactions: true }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
