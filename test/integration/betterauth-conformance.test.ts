import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  waitUntilTableExists
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  normalTestSuite,
  testAdapter,
  uuidTestSuite
} from "@better-auth/test-utils/adapter";
import { randomUUID } from "node:crypto";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { dynamoDBAdapter } from "../../src/index.js";
import type { BetterAuthDynamoDBOptions } from "../../src/index.js";

const IMAGE = "amazon/dynamodb-local:2.6.1";
const REGION = "us-east-1";
const PORT = 8000;

let container: StartedTestContainer;
let nativeClient: DynamoDBClient;
let docClient: DynamoDBDocumentClient;
const tableName = `betterauth_dynamodb_conformance_${randomUUID().replaceAll("-", "")}`;

await startDynamoDBLocal();

const conformance = await testAdapter({
  adapter: () => dynamoDBAdapter(adapterOptions()),
  runMigrations: () => createTable(nativeClient, tableName),
  onFinish: async () => {
    await deleteTable(nativeClient, tableName);
    nativeClient.destroy();
    await container.stop();
  },
  overrideBetterAuthOptions: (options) => ({
    ...options,
    emailAndPassword: { enabled: true, ...options.emailAndPassword },
    verification: { disableCleanup: true, ...options.verification }
  }),
  tests: [
    // Included: canonical CRUD/query/mutation suite. Its fallback join cases are applicable because Better Auth
    // performs them as separate adapter reads when experimental native joins are disabled.
    normalTestSuite(),
    // Included: this adapter intentionally sets supportsNumericIds=false, but UUID string ids are supported.
    uuidTestSuite(),
    // Included with unsafeAllowScan=true: DynamoDB sidecar keys are case-sensitive, so insensitive predicates
    // require the adapter's explicit bounded model scan opt-in in tests.
    caseInsensitiveTestSuite(),
    // Included: exercises Better Auth's public auth flows against the adapter. Verification cleanup is disabled
    // above because Better Auth's range-only cleanup is an unsupported scan-shaped production access pattern.
    authFlowTestSuite()
    // Excluded: numberIdTestSuite because supportsNumericIds=false.
    // Excluded: transactionsTestSuite because config.transaction=false and DynamoDB cannot support Better Auth's
    // arbitrary callback transaction contract honestly.
    // Excluded: joinsTestSuite because experimental native joins are rejected; Better Auth fallback joins are
    // covered by the normal/UUID suites, while native join tests would conflict with the adapter invariant.
  ],
  prefixTests: "dynamodb-local-conformance"
});

conformance.execute();

function adapterOptions(): BetterAuthDynamoDBOptions {
  return {
    tableName,
    client: docClient,
    unsafeAllowScan: true,
    maxPages: 100
  };
}

async function startDynamoDBLocal(): Promise<void> {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(PORT)
    .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb", "-disableTelemetry"])
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}`;
  nativeClient = new DynamoDBClient({ region: REGION, endpoint, credentials: { accessKeyId: "fake", secretAccessKey: "fake" } });
  docClient = DynamoDBDocumentClient.from(nativeClient, { marshallOptions: { removeUndefinedValues: true } });
  await waitForDynamoDBLocal(nativeClient);
}

async function waitForDynamoDBLocal(client: DynamoDBClient): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await client.send(new ListTablesCommand({}));
}

async function createTable(client: DynamoDBClient, name: string): Promise<void> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" }
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" }
        ]
      })
    );
  } catch (error) {
    if (error instanceof ResourceInUseException) return;
    throw error;
  }
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: name });
}

async function deleteTable(client: DynamoDBClient, name: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: name }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return;
    throw error;
  }
}
