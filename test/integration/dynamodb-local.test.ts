import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  ResourceNotFoundException,
  waitUntilTableExists
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { DynamoDBConflictError, UnsupportedQueryError, dynamoDBAdapter } from "../../src/index.js";
import type { BetterAuthDynamoDBOptions } from "../../src/index.js";
import { entitySk, indexPk, indexSk, modelPk, uniquePk, valueSk } from "../../src/keys.js";
import { REVISION_ATTRIBUTE } from "../../src/serialize.js";

const IMAGE = "amazon/dynamodb-local:2.6.1";
const REGION = "us-east-1";
const PORT = 8000;

type TestAdapter = ReturnType<ReturnType<typeof dynamoDBAdapter>>;
type Where = { field: string; value: string | number | boolean | null; operator: "eq" | "contains"; connector: "AND"; mode: "sensitive" };

let container: StartedTestContainer;
let endpoint: string;
let nativeClient: DynamoDBClient;
let docClient: DynamoDBDocumentClient;
let tableName: string;

const eq = (field: string, value: string | number | boolean | null): Where => ({ field, value, operator: "eq", connector: "AND", mode: "sensitive" });
const contains = (field: string, value: string): Where => ({ field, value, operator: "contains", connector: "AND", mode: "sensitive" });

describe("DynamoDB Local adapter integration", () => {
  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withExposedPorts(PORT)
      .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb", "-disableTelemetry"])
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}`;
    nativeClient = new DynamoDBClient({ region: REGION, endpoint, credentials: { accessKeyId: "fake", secretAccessKey: "fake" } });
    docClient = DynamoDBDocumentClient.from(nativeClient, { marshallOptions: { removeUndefinedValues: true } });
    await waitForDynamoDBLocal(nativeClient);
  });

  afterAll(async () => {
    await nativeClient?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    tableName = `betterauth_dynamodb_it_${randomUUID().replaceAll("-", "")}`;
    await createTable(nativeClient, tableName);
  });

  afterEach(async () => {
    await deleteTable(nativeClient, tableName);
  });

  it("creates and reads by id through an injected DynamoDBDocumentClient", async () => {
    const adapter = adapterFor({ client: docClient });

    await expect(create(adapter, "user", { id: "u1", email: "a@example.com", name: "Ada" })).resolves.toMatchObject({ id: "u1", email: "a@example.com", name: "Ada" });
    await expect(adapter.findOne({ model: "user", where: [eq("id", "u1")] })).resolves.toMatchObject({ id: "u1", email: "a@example.com", name: "Ada" });

    await expect(rawRow(modelPk("user"), entitySk("u1"))).resolves.toMatchObject({ model: "user", entity: { id: "u1", email: "a@example.com" } });
  });

  it("maintains multiple scalar plugin-like equality sidecars in one table", async () => {
    const adapter = adapterFor({ client: docClient });
    await create(adapter, "member", { id: "m1", organizationId: "org#1", role: "admin", active: true });
    await create(adapter, "member", { id: "m2", organizationId: "org#1", role: "viewer", active: false });

    await expect(adapter.findMany({ model: "member", where: [eq("organizationId", "org#1")], limit: 10 })).resolves.toHaveLength(2);
    await expect(adapter.findMany({ model: "member", where: [eq("active", true)], limit: 10 })).resolves.toEqual([{ id: "m1", organizationId: "org#1", role: "admin", active: true }]);
    await expect(rawRowsByModel("_index_member")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ indexField: "organizationId" }), expect.objectContaining({ indexField: "role" }), expect.objectContaining({ indexField: "active" })]));
  });

  it("enforces transactional uniqueness conflicts", async () => {
    const adapter = adapterFor({ client: docClient, uniqueFields: { user: ["email"] } });
    await create(adapter, "user", { id: "u1", email: "same@example.com", name: "Ada" });

    await expect(create(adapter, "user", { id: "u2", email: "same@example.com", name: "Grace" })).rejects.toBeInstanceOf(DynamoDBConflictError);
    await expect(rawRow(uniquePk("user", "email"), valueSk("same@example.com", ""))).resolves.toMatchObject({ ownerSk: entitySk("u1") });
  });

  it("replaces sidecars and unique locks on update", async () => {
    const adapter = adapterFor({ client: docClient, uniqueFields: { user: ["email"] } });
    await create(adapter, "user", { id: "u1", email: "old@example.com", name: "Ada", org: "old" });

    await expect(adapter.update({ model: "user", where: [eq("id", "u1")], update: { email: "new@example.com", org: "new" } })).resolves.toMatchObject({ id: "u1", email: "new@example.com", org: "new" });

    await expect(adapter.findOne({ model: "user", where: [eq("email", "old@example.com")] })).resolves.toBeNull();
    await expect(adapter.findOne({ model: "user", where: [eq("email", "new@example.com")] })).resolves.toMatchObject({ id: "u1" });
    await expect(rawRow(uniquePk("user", "email"), valueSk("old@example.com", ""))).resolves.toBeUndefined();
    await expect(rawRow(uniquePk("user", "email"), valueSk("new@example.com", ""))).resolves.toMatchObject({ ownerSk: entitySk("u1") });
  });

  it("cleans up entity rows, sidecars, and locks for delete and consumeOne", async () => {
    const adapter = adapterFor({ client: docClient, uniqueFields: { verification: ["token"], session: ["token"] } });
    await create(adapter, "verification", { id: "v1", token: "tok", identifier: "email", value: "tok", expiresAt: "2030-01-01T00:00:00.000Z" });
    await expect(adapter.consumeOne({ model: "verification", where: [eq("id", "v1"), eq("token", "tok")] })).resolves.toMatchObject({ id: "v1", token: "tok" });
    await expect(rawRow(modelPk("verification"), entitySk("v1"))).resolves.toBeUndefined();
    await expect(rawRowsByModel("_index_verification")).resolves.toHaveLength(0);

    await create(adapter, "session", { id: "s1", token: "st", userId: "u1", expiresAt: "2030-01-01T00:00:00.000Z" });
    await adapter.delete({ model: "session", where: [eq("id", "s1")] });
    await expect(rawRow(modelPk("session"), entitySk("s1"))).resolves.toBeUndefined();
    await expect(rawRowsByModel("_unique_session")).resolves.toHaveLength(0);
  });

  it("increments using a fresh revision and rejects concurrent stale revision mutations", async () => {
    const adapter = adapterFor({ client: docClient });
    await create(adapter, "rateLimit", { id: "r1", key: "ip", count: 1 });
    const before = await rawRow(modelPk("rateLimit"), entitySk("r1"));

    await expect(adapter.incrementOne({ model: "rateLimit", where: [eq("id", "r1")], increment: { count: 2 }, set: { lastRequest: 123 } })).resolves.toMatchObject({ id: "r1", count: 3, lastRequest: 123 });
    const after = await rawRow(modelPk("rateLimit"), entitySk("r1"));
    expect(after?.[REVISION_ATTRIBUTE]).not.toBe(before?.[REVISION_ATTRIBUTE]);

    const staleReadBarrier = new ReadBarrier(2);
    const concurrentAdapter = adapterFor({ client: clientWithReadBarrier(staleReadBarrier, modelPk("rateLimit"), entitySk("r1")) });
    const concurrent = await Promise.allSettled([
      concurrentAdapter.update({ model: "rateLimit", where: [eq("id", "r1")], update: { lastRequest: 456 } }),
      concurrentAdapter.update({ model: "rateLimit", where: [eq("id", "r1")], update: { lastRequest: 789 } })
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it.each([undefined, false] as const)("keeps numeric ttl fields visible and unexpired when adapter TTL is %s", async (ttl) => {
    const adapter = adapterFor({ client: docClient, ...(ttl === false ? { ttl } : {}) });
    await create(adapter, "plugin", { id: "p1", externalId: "ext-ttl", kind: "ttl", ttl: 1, name: "ordinary" });

    await expect(adapter.findOne({ model: "plugin", where: [eq("id", "p1")] })).resolves.toMatchObject({ id: "p1", ttl: 1, name: "ordinary" });
    await expect(adapter.findMany({ model: "plugin", where: [eq("ttl", 1)], limit: 10 })).resolves.toEqual([expect.objectContaining({ id: "p1", ttl: 1, name: "ordinary" })]);
    await expect(rawRow(modelPk("plugin"), entitySk("p1"))).resolves.toMatchObject({ ttl: 1, entity: { ttl: 1 } });
  });

  it("hides logically expired TTL rows before physical DynamoDB deletion", async () => {
    const adapter = adapterFor({ client: docClient, ttl: { fields: { session: "expiresAt" } } });
    await create(adapter, "session", { id: "expired", token: "expired-token", userId: "u1", expiresAt: "2000-01-01T00:00:00.000Z" });

    await expect(rawRow(modelPk("session"), entitySk("expired"))).resolves.toMatchObject({ ttl: 946684800 });
    await expect(adapter.findOne({ model: "session", where: [eq("id", "expired")] })).resolves.toBeNull();
    await expect(adapter.findMany({ model: "session", where: [eq("userId", "u1")], limit: 10 })).resolves.toEqual([]);
  });

  it("keeps configured future TTL rows visible while storing physical TTL metadata", async () => {
    const adapter = adapterFor({ client: docClient, ttl: { attributeName: "expiresAtTtl", fields: { plugin: "expiresAt" } } });
    await create(adapter, "plugin", { id: "active", externalId: "ext-active", kind: "ttl", ttl: 1, name: "ordinary", expiresAt: "2030-01-01T00:00:00.000Z" });

    await expect(rawRow(modelPk("plugin"), entitySk("active"))).resolves.toMatchObject({ ttl: 1, expiresAtTtl: 1893456000, entity: { ttl: 1 } });
    await expect(adapter.findOne({ model: "plugin", where: [eq("id", "active")] })).resolves.toMatchObject({ id: "active", ttl: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
  });

  it("uses real DynamoDB Query and Scan pagination with small page sizes", async () => {
    const adapter = adapterFor({ client: docClient, unsafeAllowScan: true, pageSize: 1, maxPages: 30 });
    await create(adapter, "user", { id: "u1", name: "C", org: "o1", email: "c@example.com" });
    await create(adapter, "user", { id: "u2", name: "A", org: "o1", email: "a@example.com" });
    await create(adapter, "user", { id: "u3", name: "B", org: "o1", email: "b@example.com" });

    await expect(adapter.findMany({ model: "user", where: [eq("org", "o1")], limit: 3, sortBy: { field: "email", direction: "asc" } })).resolves.toEqual([
      expect.objectContaining({ id: "u2" }),
      expect.objectContaining({ id: "u3" }),
      expect.objectContaining({ id: "u1" })
    ]);
    await expect(adapter.count({ model: "user", where: [contains("email", "@example.com")] })).resolves.toBe(3);
  });

  it("rejects hidden scans and accepts long delimiter-containing values", async () => {
    const adapter = adapterFor({ client: docClient, uniqueFields: { plugin: ["externalId"] } });
    const longValue = `tenant#${"x".repeat(2048)}#value`;
    await create(adapter, "plugin", { id: "id#with:delimiters", externalId: longValue, kind: "sso#oidc" });

    await expect(adapter.findMany({ model: "plugin", where: [contains("kind", "oidc")], limit: 10 })).rejects.toBeInstanceOf(UnsupportedQueryError);
    await expect(adapter.findOne({ model: "plugin", where: [eq("externalId", longValue)] })).resolves.toMatchObject({ id: "id#with:delimiters", externalId: longValue });
    await expect(rawRow(indexPk("plugin", "externalId", longValue), indexSk("id#with:delimiters"))).resolves.toMatchObject({ ownerSk: entitySk("id#with:delimiters") });
  });
});

function adapterFor(options: Omit<BetterAuthDynamoDBOptions, "tableName">): TestAdapter {
  return dynamoDBAdapter({ tableName, ...options })(authOptions() as never) as TestAdapter;
}

function authOptions() {
  return {
    secret: "test-secret",
    emailAndPassword: { enabled: true },
    rateLimit: { storage: "database" },
    user: { additionalFields: { org: { type: "string", required: false } } },
    verification: { additionalFields: { token: { type: "string", required: false } } },
    plugins: [
      {
        id: "integration-schema",
        schema: {
          member: { fields: { organizationId: { type: "string", required: true }, role: { type: "string", required: true }, active: { type: "boolean", required: true } } },
          plugin: { fields: { externalId: { type: "string", required: true, unique: true }, kind: { type: "string", required: true }, ttl: { type: "number", required: false }, name: { type: "string", required: false }, expiresAt: { type: "string", required: false } } }
        }
      }
    ]
  };
}

function create(adapter: TestAdapter, model: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return adapter.create({ model, data, forceAllowId: true }) as Promise<Record<string, unknown>>;
}

class ReadBarrier {
  private readonly waiters: (() => void)[] = [];
  private count = 0;

  constructor(private readonly target: number) {}

  wait(): Promise<void> {
    this.count += 1;
    if (this.count >= this.target) {
      this.waiters.splice(0).forEach((resolve) => resolve());
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function clientWithReadBarrier(barrier: ReadBarrier, pk: string, sk: string): DynamoDBDocumentClient {
  return { send: (command) => sendWithReadBarrier(command, barrier, pk, sk) } as DynamoDBDocumentClient;
}

async function sendWithReadBarrier(command: any, barrier: ReadBarrier, pk: string, sk: string): Promise<any> {
  const result = await docClient.send(command);
  if (command instanceof GetCommand && command.input.ConsistentRead === true && command.input.Key?.pk === pk && command.input.Key?.sk === sk) await barrier.wait();
  if (command instanceof TransactWriteCommand) return result;
  return result;
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

async function rawRow(pk: string, sk: string): Promise<Record<string, unknown> | undefined> {
  const result = await docClient.send(new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }));
  return result.Item;
}

async function rawRowsByModel(model: string): Promise<Record<string, unknown>[]> {
  const result = await docClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true, FilterExpression: "#model = :model", ExpressionAttributeNames: { "#model": "model" }, ExpressionAttributeValues: { ":model": model } }));
  return result.Items ?? [];
}
