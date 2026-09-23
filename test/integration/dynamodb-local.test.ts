import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  ResourceNotFoundException,
  waitUntilTableExists
} from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { betterAuth } from "better-auth";
import { oauthProvider } from "@better-auth/oauth-provider";
import { DynamoDBAdapterError, DynamoDBConflictError, UnsupportedQueryError, dynamoDBAdapter, initializeDynamoDBTransactions, recoverDynamoDBTransactions, runDynamoDBRecoveryWorker } from "../../src/index.js";
import { DynamoDBStore } from "../../src/dynamodb-adapter.js";
import { INTENT } from "../../src/transactions/format.js";
import type { BetterAuthDynamoDBOptions } from "../../src/index.js";
import { compoundUniqueIndexName, compoundUniquePk, compoundUniqueSk, entitySk, indexPk, indexSk, modelPk, uniquePk, valueSk } from "../../src/keys.js";
import { REVISION_ATTRIBUTE } from "../../src/serialize.js";
import { enterpriseContract } from "../helpers/enterprise-contract.js";
import { ssoContract, ssoGuardContract } from "../helpers/sso-contract.js";

const IMAGE = "amazon/dynamodb-local:2.6.1";
const REGION = "us-east-1";
const PORT = 8000;

type TestAdapter = ReturnType<ReturnType<typeof dynamoDBAdapter>>;
type Where = { field: string; value: string | number | boolean | string[] | number[] | null; operator: "eq" | "in" | "contains"; connector: "AND"; mode: "sensitive" | "insensitive" };

let container: StartedTestContainer;
let endpoint: string;
let nativeClient: DynamoDBClient;
let docClient: DynamoDBDocumentClient;
let tableName: string;

const eq = (field: string, value: string | number | boolean | null): Where => ({ field, value, operator: "eq", connector: "AND", mode: "sensitive" });
const inValues = (field: string, value: string[]): Where => ({ field, value, operator: "in", connector: "AND", mode: "sensitive" });
const insensitiveInValues = (field: string, value: string[]): Where => ({ field, value, operator: "in", connector: "AND", mode: "insensitive" });
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

  it("keeps ordinary authentication reads and writes correct beside a SCIM callback", async () => {
    let pauseCleanup = true;
    const client = { config: docClient.config, send: async (command: any) => {
      if (pauseCleanup && command instanceof TransactWriteCommand && command.input.TransactItems?.some((action) => action.Put?.ConditionExpression?.includes("#intent.#id"))) throw new Error("cleanup paused");
      return docClient.send(command);
    } } as unknown as DynamoDBDocumentClient;
    const options = { tableName, client, transactions: true };
    await initializeDynamoDBTransactions(options);
    const scim = new DynamoDBStore(options);
    const auth = new DynamoDBStore({ ...options, transactions: false, transactionStorage: true });
    await auth.create("user", { id: "u", email: "old@example.test" });
    await scim.transaction(async (trx) => {
      await trx.update("user", [eq("id", "u")], { email: "new@example.test" });
      await trx.create("session", { id: "s", userId: "u" });
      expect(await auth.findOne("user", [eq("id", "u")])).toMatchObject({ email: "old@example.test" });
      expect(await auth.findOne("session", [eq("id", "s")])).toBeNull();
    });
    expect((await rawRow(modelPk("user"), entitySk("u")))?.[INTENT]).toBeDefined();
    expect(await auth.findOne("user", [eq("id", "u")])).toMatchObject({ email: "new@example.test" });
    expect(await auth.findOne("session", [eq("id", "s")])).toMatchObject({ userId: "u" });
    pauseCleanup = false;
    await auth.update("user", [eq("id", "u")], { name: "ordinary write" });
    expect(await scim.findOne("user", [eq("id", "u")])).toMatchObject({ name: "ordinary write" });
  });

  it("resumes bounded recovery through durable Lambda checkpoints on native DynamoDB", async () => {
    let interrupt = true;
    const broken = { config: docClient.config, send: async (command: any) => {
      if (interrupt && command instanceof TransactWriteCommand && command.input.TransactItems?.some((action) => action.Put?.ConditionExpression?.includes("#intent.#id"))) throw new Error("cleanup interrupted");
      return docClient.send(command);
    } } as unknown as DynamoDBDocumentClient;
    const options = { tableName, client: broken, transactions: true };
    await initializeDynamoDBTransactions(options);
    const store = new DynamoDBStore(options);
    await store.transaction(async (trx) => {
      for (let index = 0; index < 55; index++) await trx.create("member", { id: `bounded-${index}`, groupId: "g" });
    });
    expect((await rawRow(modelPk("member"), entitySk("bounded-0")))?.[INTENT]).toBeDefined();
    interrupt = false;
    let recovered = 0;
    for (let invocation = 0; invocation < 100 && recovered === 0; invocation++) {
      const result = await runDynamoDBRecoveryWorker(options, { maxCalls: 2, maxBatchesPerTransaction: 1 });
      recovered += result.recovered;
      expect(result.failures).toEqual([]);
    }
    expect(recovered).toBe(1);
    expect(await store.count("member", [eq("groupId", "g")])).toBe(55);
    expect((await rawRow(modelPk("member"), entitySk("bounded-0")))?.[INTENT]).toBeUndefined();
    expect(await rawRow("BETTERAUTH#MAINTENANCE", "transactions")).toHaveProperty("revision");
  });

  it("atomically commits a callback spanning more than 1,000 physical items", async () => {
    const options = { tableName, client: docClient, transactions: true, uniqueFields: { member: ["membershipKey"] } };
    await initializeDynamoDBTransactions(options);
    const store = new DynamoDBStore(options);
    await store.transaction(async (trx) => {
      for (let index = 0; index < 145; index++) await trx.create("member", { id: `member-${index}`, connectionId: "c", groupId: "g", scimUserId: `user-${index}`, membershipKey: `membership-${index}`, createdAt: "2026-01-01T00:00:00.000Z" });
      expect(await trx.count("member", [eq("groupId", "g")])).toBe(145);
      expect(await store.count("member", [eq("groupId", "g")])).toBe(0);
    });
    expect(await store.count("member", [eq("groupId", "g")])).toBe(145);
    expect(await recoverDynamoDBTransactions(options)).toMatchObject({ examined: 0 });
    expect((await rawRow(modelPk("member"), entitySk("member-0")))?.[INTENT]).toBeUndefined();
  });

  it("journals only selected query records while retaining conflicts on selected records", async () => {
    const manifests: number[] = [];
    const client = { config: docClient.config, send: async (command: any) => {
      if (command instanceof TransactWriteCommand) {
        for (const action of command.input.TransactItems ?? []) {
          if (action.Put?.Item?.state === "PREPARING") manifests.push(Number(action.Put.Item.count));
        }
      }
      return docClient.send(command);
    } } as unknown as DynamoDBDocumentClient;
    const options = { tableName, client, transactions: true, pageSize: 2, unsafeAllowScan: true };
    await initializeDynamoDBTransactions(options);
    const store = new DynamoDBStore(options);
    for (const key of ["a", "b", "c", "d"]) await store.create("user", { id: key, team: "x" });
    for (const where of [[eq("team", "x")], [inValues("team", ["x"])], []]) {
      await store.transaction(async (trx) => {
        expect(await trx.findMany("user", where, 1, 1, { field: "id", direction: "asc" }, ["id"])).toEqual([{ id: "b" }]);
        await store.update("user", [eq("id", "c")], { name: randomUUID() });
      });
      expect(manifests.at(-1)).toBe(1);
    }
    await expect(store.transaction(async (trx) => {
      await trx.findMany("user", [eq("team", "x")], 1, 1, { field: "id", direction: "asc" });
      await store.update("user", [eq("id", "b")], { name: "concurrent" });
    })).rejects.toThrow();
    expect(await store.findOne("user", [eq("id", "b")])).toMatchObject({ name: "concurrent" });
  });

  it("restores every prepared item when a later callback prepare batch fails", async () => {
    const broken = { send: async (command: any) => {
      if (command instanceof TransactWriteCommand && command.input.TransactItems?.some((action) => action.Update?.ExpressionAttributeValues?.[":before"] === 99)) throw new Error("injected prepare failure");
      return docClient.send(command);
    } } as unknown as DynamoDBDocumentClient;
    const options = { tableName, client: broken, transactions: true };
    await initializeDynamoDBTransactions(options);
    const store = new DynamoDBStore(options);
    await expect(store.transaction(async (trx) => {
      for (let index = 0; index < 55; index++) await trx.create("member", { id: `member-${index}`, groupId: "g" });
    })).rejects.toThrow("injected prepare failure");
    expect(await store.count("member", [eq("groupId", "g")])).toBe(0);
    expect(await recoverDynamoDBTransactions(options)).toMatchObject({ examined: 0 });
  });

  it("creates and reads by id through an injected DynamoDBDocumentClient", async () => {
    const adapter = adapterFor({ client: docClient });

    await expect(create(adapter, "user", { id: "u1", email: "a@example.com", name: "Ada" })).resolves.toMatchObject({ id: "u1", email: "a@example.com", name: "Ada" });
    await expect(adapter.findOne({ model: "user", where: [eq("id", "u1")] })).resolves.toMatchObject({ id: "u1", email: "a@example.com", name: "Ada" });

    await expect(rawRow(modelPk("user"), entitySk("u1"))).resolves.toMatchObject({ model: "user", entity: { id: "u1", email: "a@example.com" } });
  });

  it("runs published SCIM provisioning and projection rollback entirely on DynamoDB", async () => {
    await enterpriseContract({ tableName, client: docClient });
  });

  it("runs SSO resolution, rollback and SCIM session revocation entirely on DynamoDB", async () => {
    await ssoContract({ tableName, client: docClient });
  });

  it("rolls back rejected provider guards and commits allowed provider mutations on DynamoDB", async () => {
    await ssoGuardContract({ tableName, client: docClient });
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

  it("enforces schema-derived uniqueness after Better Auth model and field remapping", async () => {
    const adapter = dynamoDBAdapter({ tableName, client: docClient })({ secret: "test-secret", emailAndPassword: { enabled: true }, user: { modelName: "app_user", fields: { email: "email_address" } } } as never) as TestAdapter;
    await create(adapter, "user", { id: "u1", email: "same@example.com", name: "Ada" });

    await expect(create(adapter, "user", { id: "u2", email: "same@example.com", name: "Grace" })).rejects.toBeInstanceOf(DynamoDBConflictError);
    await expect(rawRow(uniquePk("app_user", "email_address"), valueSk("same@example.com", ""))).resolves.toMatchObject({ ownerSk: entitySk("u1") });
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

  it("allows exactly one concurrent consumeOne winner and one null loser", async () => {
    const adapter = adapterFor({ client: docClient, uniqueFields: { verification: ["token"] } });
    await create(adapter, "verification", { id: "v1", token: "tok", identifier: "email" });
    const barrier = new ReadBarrier(2);
    const concurrentAdapter = adapterFor({ client: clientWithReadBarrier(barrier, modelPk("verification"), entitySk("v1")), uniqueFields: { verification: ["token"] } });

    const results = await Promise.all([
      concurrentAdapter.consumeOne({ model: "verification", where: [eq("id", "v1"), eq("token", "tok")] }),
      concurrentAdapter.consumeOne({ model: "verification", where: [eq("id", "v1"), eq("token", "tok")] })
    ]);

    expect(results.filter(Boolean)).toEqual([expect.objectContaining({ id: "v1", token: "tok" })]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    await expect(rawRow(modelPk("verification"), entitySk("v1"))).resolves.toBeUndefined();
    await expect(rawRowsByModel("_index_verification")).resolves.toHaveLength(0);
    await expect(rawRowsByModel("_unique_verification")).resolves.toHaveLength(0);
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

  it("uses atomic ADD for concurrent incrementOne, signed deltas, guard nulls, and sidecars", async () => {
    const adapter = adapterFor({ client: docClient });
    await create(adapter, "rateLimit", { id: "r2", key: "ip2", count: 1 });
    await expect(adapter.incrementOne({ model: "rateLimit", where: [eq("id", "r2")], increment: { count: -1 } })).resolves.toMatchObject({ id: "r2", count: 0 });
    await expect(adapter.findOne({ model: "rateLimit", where: [eq("count", 1)] })).resolves.toBeNull();
    await expect(adapter.findOne({ model: "rateLimit", where: [eq("count", 0)] })).resolves.toMatchObject({ id: "r2" });

    const barrier = new ReadBarrier(2);
    const concurrentAdapter = adapterFor({ client: clientWithReadBarrier(barrier, modelPk("rateLimit"), entitySk("r2")) });
    const results = await Promise.all([
      concurrentAdapter.incrementOne({ model: "rateLimit", where: [eq("id", "r2"), eq("key", "ip2")], increment: { count: 1 } }),
      concurrentAdapter.incrementOne({ model: "rateLimit", where: [eq("id", "r2"), eq("key", "ip2")], increment: { count: 1 } })
    ]);

    expect(results.filter(Boolean)).toEqual([expect.objectContaining({ id: "r2", count: 1 })]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    await expect(adapter.findOne({ model: "rateLimit", where: [eq("id", "r2")] })).resolves.toMatchObject({ count: 1 });
    await expect(adapter.findOne({ model: "rateLimit", where: [eq("count", 0)] })).resolves.toBeNull();
    await expect(adapter.findOne({ model: "rateLimit", where: [eq("count", 1)] })).resolves.toMatchObject({ id: "r2" });
    await expect(adapter.incrementOne({ model: "rateLimit", where: [eq("id", "r2")], increment: { count: 0 } })).resolves.toMatchObject({ id: "r2", count: 1 });
    await expect(adapter.incrementOne({ model: "rateLimit", where: [eq("id", "r2"), eq("key", "other")], increment: { count: 1 } })).resolves.toBeNull();
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

  it("stores epoch-zero TTL explicitly and treats the row as logically expired", async () => {
    const adapter = adapterFor({ client: docClient, ttl: { fields: { session: "expiresAt" } } });
    await create(adapter, "session", { id: "epoch-zero", token: "epoch-zero-token", userId: "u1", expiresAt: new Date(0) });

    await expect(rawRow(modelPk("session"), entitySk("epoch-zero"))).resolves.toMatchObject({ ttl: 0 });
    await expect(adapter.findOne({ model: "session", where: [eq("id", "epoch-zero")] })).resolves.toBeNull();
  });

  it("keeps configured future TTL rows visible while storing physical TTL metadata", async () => {
    const adapter = adapterFor({ client: docClient, ttl: { attributeName: "expiresAtTtl", fields: { plugin: "expiresAt" } } });
    await create(adapter, "plugin", { id: "active", externalId: "ext-active", kind: "ttl", ttl: 1, name: "ordinary", expiresAt: "2030-01-01T00:00:00.000Z" });

    await expect(rawRow(modelPk("plugin"), entitySk("active"))).resolves.toMatchObject({ ttl: 1, expiresAtTtl: 1893456000, entity: { ttl: 1 } });
    await expect(adapter.findOne({ model: "plugin", where: [eq("id", "active")] })).resolves.toMatchObject({ id: "active", ttl: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
  });

  it("increments and sets ordinary ttl fields when TTL handling is disabled", async () => {
    for (const ttl of [undefined, false] as const) {
      const adapter = adapterFor({ client: docClient, ...(ttl === false ? { ttl } : {}) });
      const id = ttl === false ? "ttl-disabled" : "ttl-omitted";
      await create(adapter, "plugin", { id, externalId: id, kind: "counter", ttl: 2 });

      await expect(adapter.incrementOne({ model: "plugin", where: [eq("id", id)], increment: { ttl: 1 } })).resolves.toMatchObject({ id, ttl: 3 });
      await expect(adapter.incrementOne({ model: "plugin", where: [eq("id", id)], increment: {}, set: { ttl: 4 } })).resolves.toMatchObject({ id, ttl: 4 });
      await expect(adapter.findOne({ model: "plugin", where: [eq("ttl", 4), eq("externalId", id)] })).resolves.toMatchObject({ id, ttl: 4 });
    }
  });

  it("uses real DynamoDB sidecar and model Query pagination with small page sizes", async () => {
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

  it("stops complete unsorted read windows before the page cap while preserving full-read guards", async () => {
    const adapter = adapterFor({ client: docClient, unsafeAllowScan: true, pageSize: 1, maxPages: 1 });
    await create(adapter, "user", { id: "u1", name: "First", org: "o1", email: "first@example.com" });
    await create(adapter, "user", { id: "u2", name: "Second", org: "o1", email: "second@example.com" });

    await expect(adapter.findOne({ model: "user", where: [eq("org", "o1")] })).resolves.toMatchObject({ id: "u1" });
    await expect(adapter.findMany({ model: "user", where: [eq("org", "o1")], limit: 1 })).resolves.toEqual([expect.objectContaining({ id: "u1" })]);
    await expect(adapter.findMany({ model: "user", where: [], limit: 1 })).resolves.toEqual([expect.objectContaining({ id: "u1" })]);
    await expect(adapter.count({ model: "user", where: [eq("org", "o1")] })).rejects.toThrow(/maxPages/);
    await expect(adapter.count({ model: "user", where: [] })).rejects.toThrow(/maxPages/);
    await expect(adapter.findMany({ model: "user", where: [eq("org", "o1")], limit: 1, sortBy: { field: "name", direction: "desc" } })).rejects.toThrow(/maxPages/);
  });

  it("fills limited windows after expired, missing, and residual-filtered owners", async () => {
    const options = { client: docClient, pageSize: 1, ttl: { fields: { plugin: "expiresAt" } } };
    const adapter = adapterFor({ ...options, maxPages: 5 });
    for (let index = 0; index < 6; index += 1) {
      await create(adapter, "plugin", {
        id: `p${index}`, externalId: `ext-${index}`, kind: "window", name: index === 2 ? "skip" : "keep",
        expiresAt: index === 0 ? "2000-01-01T00:00:00.000Z" : "2030-01-01T00:00:00.000Z"
      });
    }
    // Leave a stale sidecar to prove it does not fill the requested result window.
    await docClient.send(new DeleteCommand({ TableName: tableName, Key: { pk: modelPk("plugin"), sk: entitySk("p1") } }));
    const where = [eq("kind", "window"), eq("name", "keep")];

    await expect(adapter.findOne({ model: "plugin", where })).resolves.toMatchObject({ id: "p3" });
    await expect(adapter.findMany({ model: "plugin", where, limit: 1, offset: 1 })).resolves.toEqual([expect.objectContaining({ id: "p4" })]);
    const capped = adapterFor({ ...options, maxPages: 4 });
    await expect(capped.findMany({ model: "plugin", where, limit: 1, offset: 1 })).rejects.toThrow(/maxPages/);
  });

  it.each([false, true])("does not skip mixed-case identifiers during cursor pagination with transactions=%s", async (transactions) => {
    const options = { tableName, client: docClient, transactions };
    if (transactions) await initializeDynamoDBTransactions(options);
    const store = new DynamoDBStore(options);
    const ids = ["a", "Z", "A", "z", "é", "e", "😀", "\uE000"];
    for (const id of ids) await store.create("member", { id, domain: "cursor-test", userId: id });
    for (const direction of ["asc", "desc"] as const) {
      const visited: unknown[] = [];
      let cursor: unknown;
      for (let page = 0; page < ids.length; page++) {
        const where = [eq("domain", "cursor-test"), ...(cursor === undefined ? [] : [{ ...eq("userId", String(cursor)), operator: direction === "asc" ? "gt" as const : "lt" as const }])];
        const batch = await store.findMany<{ userId: string }>("member", where, 2, 0, { field: "userId", direction });
        if (!batch.length) break;
        visited.push(...batch.map((row) => row.userId));
        cursor = batch.at(-1)!.userId;
      }
      const expected = [...ids].sort();
      expect(visited).toEqual(direction === "asc" ? expected : expected.reverse());
    }
  });

  it("sorts numeric fields numerically in DynamoDB-backed findMany", async () => {
    const adapter = adapterFor({ client: docClient, unsafeAllowScan: true });
    await create(adapter, "plugin", { id: "p1", externalId: "e1", kind: "score", ttl: 10 });
    await create(adapter, "plugin", { id: "p2", externalId: "e2", kind: "score", ttl: 2 });

    await expect(adapter.findMany({ model: "plugin", where: [eq("kind", "score")], limit: 2, sortBy: { field: "ttl", direction: "asc" } })).resolves.toEqual([expect.objectContaining({ id: "p2", ttl: 2 }), expect.objectContaining({ id: "p1", ttl: 10 })]);
  });

  it("rejects hidden scans and accepts long delimiter-containing values", async () => {
    const adapter = adapterFor({ client: docClient, uniqueFields: { plugin: ["externalId"] } });
    const longValue = `tenant#${"x".repeat(2048)}#value`;
    await create(adapter, "plugin", { id: "id#with:delimiters", externalId: longValue, kind: "sso#oidc" });

    await expect(adapter.findMany({ model: "plugin", where: [contains("kind", "oidc")], limit: 10 })).rejects.toBeInstanceOf(UnsupportedQueryError);
    await expect(adapter.findOne({ model: "plugin", where: [eq("externalId", longValue)] })).resolves.toMatchObject({ id: "id#with:delimiters", externalId: longValue });
    await expect(rawRow(indexPk("plugin", "externalId", longValue), indexSk("id#with:delimiters"))).resolves.toMatchObject({ ownerSk: entitySk("id#with:delimiters") });
  });

  it("keeps schema compound indexes opt-in for backwards compatibility", async () => {
    const adapter = schemaIndexAdapter(false);
    await create(adapter, "oauthClientResource", { id: "legacy-1", clientId: "client-1", resourceId: "resource-1" });
    await expect(create(adapter, "oauthClientResource", { id: "legacy-2", clientId: "client-1", resourceId: "resource-1" })).resolves.toMatchObject({ id: "legacy-2" });
  });

  it("enforces a real schema compound unique index atomically", async () => {
    const adapter = schemaIndexAdapter(true);
    const attempts = await Promise.allSettled([
      create(adapter, "oauthClientResource", { id: "compound-1", clientId: "client-1", resourceId: "resource-1" }),
      create(adapter, "oauthClientResource", { id: "compound-2", clientId: "client-1", resourceId: "resource-1" })
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    await expect(adapter.findMany({ model: "oauthClientResource", where: [eq("clientId", "client-1")], limit: 10 })).resolves.toHaveLength(1);
  });

  it("cleans compound locks across conflicting update and delete operations", async () => {
    const adapter = schemaIndexAdapter(true);
    await create(adapter, "oauthClientResource", { id: "compound-a", clientId: "client-a", resourceId: "resource-a" });
    await create(adapter, "oauthClientResource", { id: "compound-b", clientId: "client-b", resourceId: "resource-b" });

    await expect(adapter.update({ model: "oauthClientResource", where: [eq("id", "compound-b")], update: { clientId: "client-a", resourceId: "resource-a" } })).rejects.toBeInstanceOf(DynamoDBConflictError);
    await expect(adapter.delete({ model: "oauthClientResource", where: [eq("id", "compound-a")] })).resolves.toBeUndefined();
    await expect(adapter.update({ model: "oauthClientResource", where: [eq("id", "compound-b")], update: { clientId: "client-a", resourceId: "resource-a" } })).resolves.toMatchObject({ id: "compound-b", clientId: "client-a", resourceId: "resource-a" });
  });

  it("supports indexed IN reads, empty IN, pagination, and deterministic limits", async () => {
    const adapter = schemaIndexAdapter(true);
    for (let index = 0; index < 7; index += 1) {
      await create(adapter, "oauthClientResource", { id: `in-${index}`, clientId: "client-in", resourceId: `resource-${index}` });
    }

    const where = [inValues("resourceId", ["resource-1", "resource-2", "resource-3", "resource-4", "resource-5", "resource-6"])] as never;
    await expect(adapter.findMany({ model: "oauthClientResource", where, limit: 3, offset: 0 })).resolves.toHaveLength(3);
    await expect(adapter.findMany({ model: "oauthClientResource", where, limit: 3, offset: 3 })).resolves.toHaveLength(3);
    await expect(adapter.findMany({ model: "oauthClientResource", where: [inValues("resourceId", [])], limit: 10 })).resolves.toEqual([]);
  });

  it("combines case-insensitive IN with a case-sensitive indexed IN clause", async () => {
    const adapter = adapterFor({ client: docClient });
    await create(adapter, "member", { id: "mixed-mode", email: "a@example.com", role: "admin", organizationId: "org-mixed", active: true });

    await expect(adapter.findMany({ model: "member", where: [insensitiveInValues("email", ["A@EXAMPLE.COM"]), inValues("role", ["admin"])] as never, limit: 10 })).resolves.toEqual([expect.objectContaining({ id: "mixed-mode" })]);
  });

  it("evaluates case-insensitive id IN after the selected safe anchor", async () => {
    const adapter = adapterFor({ client: docClient });
    await create(adapter, "member", { id: "mixed-id", email: "a@example.com", role: "admin", organizationId: "org-mixed", active: true });
    await create(adapter, "member", { id: "other-id", email: "b@example.com", role: "admin", organizationId: "org-mixed", active: true });
    const insensitiveIds = insensitiveInValues("id", ["MIXED-ID"]);

    for (const anchor of [eq("organizationId", "org-mixed"), inValues("role", ["admin"]), inValues("id", ["mixed-id", "other-id"])]) {
      await expect(adapter.findMany({ model: "member", where: [insensitiveIds, anchor] as never, limit: 10 })).resolves.toEqual([expect.objectContaining({ id: "mixed-id" })]);
    }
  });

  it("accepts exactly 1,000 distinct indexed IN values and rejects 1,001 before reading", async () => {
    const accepted = schemaIndexAdapter(true, 1000);
    const values = Array.from({ length: 1000 }, (_, index) => `resource-${index}`);
    await expect(accepted.findMany({ model: "oauthClientResource", where: [inValues("resourceId", values)] as never, limit: 10 })).resolves.toEqual([]);

    const sends = { count: 0 };
    const rejecting = schemaIndexAdapterWithClient(true, countingClient(sends));
    const tooMany = Array.from({ length: 1001 }, (_, index) => `resource-${index}`);
    await expect(rejecting.findMany({ model: "oauthClientResource", where: [inValues("resourceId", tooMany)] as never, limit: 10 })).rejects.toBeInstanceOf(DynamoDBAdapterError);
    expect(sends.count).toBe(0);
  });

  it("rejects a transaction over 100 actions before writing", async () => {
    const sends = { count: 0 };
    const adapter = adapterFor({ client: countingClient(sends) });
    const data: Record<string, unknown> = { id: "too-many-actions" };
    for (let index = 0; index < 99; index += 1) data[`field-${index}`] = `value-${index}`;

    await expect(create(adapter, "wide", data)).rejects.toThrow("exceeding DynamoDB TransactWrite limit 100");
    expect(sends.count).toBe(0);
    await expect(rawRowsByModel("wide")).resolves.toEqual([]);
  });

  it("updates and removes more than one hundred indexed-IN entities without residual sidecars", async () => {
    const adapter = schemaIndexAdapter(true);
    for (let index = 0; index < 125; index += 1) {
      await create(adapter, "oauthClientResource", { id: `bulk-${index}`, clientId: "bulk-client", resourceId: `bulk-resource-${index}` });
    }
    const ids = Array.from({ length: 125 }, (_, index) => `bulk-${index}`);
    const where = [inValues("id", ids)] as never;

    await expect(adapter.updateMany({ model: "oauthClientResource", where, update: { clientId: "bulk-updated" } })).resolves.toBe(125);
    await expect(adapter.findMany({ model: "oauthClientResource", where: [eq("clientId", "bulk-updated")], limit: 200 })).resolves.toHaveLength(125);
    await expect(adapter.deleteMany({ model: "oauthClientResource", where })).resolves.toBe(125);
    await expect(adapter.findMany({ model: "oauthClientResource", where: [eq("clientId", "bulk-updated")], limit: 200 })).resolves.toEqual([]);
    await expect(rawRowsByModel("_index_oauthClientResource")).resolves.toHaveLength(0);
  });

  it("requires physical TTL cleanup before replacing an expired compound-index record", async () => {
    const adapter = dynamoDBAdapter({ tableName, client: docClient, ttl: { fields: { oauthClientResource: "expiresAt" } }, enforceSchemaUniqueIndexes: true } as never)(schemaAuthOptions() as never) as TestAdapter;
    await create(adapter, "oauthClientResource", { id: "expired-compound", clientId: "client-expired", resourceId: "resource-expired", expiresAt: "2000-01-01T00:00:00.000Z" });
    await expect(adapter.findMany({ model: "oauthClientResource", where: [eq("clientId", "client-expired")], limit: 10 })).resolves.toEqual([]);
    await expect(create(adapter, "oauthClientResource", { id: "blocked-compound", clientId: "client-expired", resourceId: "resource-expired" })).rejects.toBeInstanceOf(DynamoDBConflictError);
    await deleteAllRows();
    await expect(create(adapter, "oauthClientResource", { id: "fresh-compound", clientId: "client-expired", resourceId: "resource-expired" })).resolves.toMatchObject({ id: "fresh-compound" });
  });

  it("runs the real Better Auth email/password and session HTTP flow", async () => {
    const auth = betterAuth({
      secret: "test-secret-that-is-long-enough-for-better-auth",
      baseURL: "http://localhost:3000",
      database: dynamoDBAdapter({ tableName, client: docClient }),
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: false }
    });
    const signUp = await auth.handler(jsonRequest("/api/auth/sign-up/email", { email: "http@example.com", password: "password-123", name: "HTTP User" }));
    expect(signUp.status).toBe(200);
    const signIn = await auth.handler(jsonRequest("/api/auth/sign-in/email", { email: "http@example.com", password: "password-123" }));
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^better-auth\.session_token=/);
    const session = await auth.handler(new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie: cookie ?? "" } }));
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({ user: { email: "http@example.com" } });
  });

  it("uses the published OAuth provider schema for resource IN and refresh-family cleanup", async () => {
    const adapter = realProviderAdapter(true);
    await create(adapter, "oauthClientResource", { id: "provider-resource-1", clientId: "provider-client", resourceId: "resource-a" });
    await create(adapter, "oauthClientResource", { id: "provider-resource-2", clientId: "provider-client", resourceId: "resource-b" });
    await expect(create(adapter, "oauthClientResource", { id: "provider-resource-duplicate", clientId: "provider-client", resourceId: "resource-a" })).rejects.toBeInstanceOf(DynamoDBConflictError);
    await expect(adapter.findMany({ model: "oauthClientResource", where: [inValues("resourceId", ["resource-a", "resource-b"])], limit: 10 })).resolves.toHaveLength(2);

    await create(adapter, "oauthRefreshToken", { id: "refresh-family", token: "refresh-token", clientId: "provider-client", userId: "provider-user", scopes: [] });
    await create(adapter, "oauthAccessToken", { id: "access-family-1", token: "access-token-1", clientId: "provider-client", userId: "provider-user", refreshId: "refresh-family", scopes: [] });
    await create(adapter, "oauthAccessToken", { id: "access-family-2", token: "access-token-2", clientId: "provider-client", userId: "provider-user", refreshId: "refresh-family", scopes: [] });
    await expect(adapter.deleteMany({ model: "oauthAccessToken", where: [inValues("refreshId", ["refresh-family"])] })).resolves.toBe(2);
    await expect(adapter.findOne({ model: "oauthAccessToken", where: [eq("id", "access-family-1")] })).resolves.toBeNull();
  });

  it("does not let a stale scalar delete remove a replacement lock after simulated TTL cleanup", async () => {
    const pause = new TransactionPause();
    const options = { client: docClient, uniqueFields: { user: ["email"] } };
    const normal = adapterFor(options);
    const stale = adapterFor({ ...options, client: clientWithTransactionPause(pause) });
    await create(normal, "user", { id: "scalar-owner-a", email: "race@example.com" });

    const oldDelete = stale.delete({ model: "user", where: [eq("id", "scalar-owner-a")] });
    await pause.waitUntilPaused();
    await docClient.send(new DeleteCommand({ TableName: tableName, Key: { pk: uniquePk("user", "email"), sk: valueSk("race@example.com", "") } }));
    await create(normal, "user", { id: "scalar-owner-b", email: "race@example.com" });
    pause.release();
    await oldDelete.catch(() => undefined);

    await expect(rawRow(uniquePk("user", "email"), valueSk("race@example.com", ""))).resolves.toMatchObject({ ownerSk: entitySk("scalar-owner-b") });
    await expect(create(normal, "user", { id: "scalar-owner-c", email: "race@example.com" })).rejects.toBeInstanceOf(DynamoDBConflictError);
  });

  it("does not let a stale compound delete remove a replacement lock after simulated TTL cleanup", async () => {
    const pause = new TransactionPause();
    const normal = schemaIndexAdapter(true);
    const stale = schemaIndexAdapterWithClient(true, clientWithTransactionPause(pause));
    await create(normal, "oauthClientResource", { id: "compound-owner-a", clientId: "race-client", resourceId: "race-resource" });

    const oldDelete = stale.delete({ model: "oauthClientResource", where: [eq("id", "compound-owner-a")] });
    await pause.waitUntilPaused();
    await docClient.send(new DeleteCommand({ TableName: tableName, Key: { pk: compoundUniquePk("oauthClientResource", compoundUniqueIndexName(["clientId", "resourceId"])), sk: compoundUniqueSk(["race-client", "race-resource"]) } }));
    await create(normal, "oauthClientResource", { id: "compound-owner-b", clientId: "race-client", resourceId: "race-resource" });
    pause.release();
    await oldDelete.catch(() => undefined);

    await expect(rawRow(compoundUniquePk("oauthClientResource", compoundUniqueIndexName(["clientId", "resourceId"])), compoundUniqueSk(["race-client", "race-resource"]))).resolves.toMatchObject({ ownerSk: entitySk("compound-owner-b") });
    await expect(create(normal, "oauthClientResource", { id: "compound-owner-c", clientId: "race-client", resourceId: "race-resource" })).rejects.toBeInstanceOf(DynamoDBConflictError);
  });

  it("preserves replacement ownership when a stale update retains a scalar lock", async () => {
    const pause = new TransactionPause();
    const options = { client: docClient, uniqueFields: { user: ["email"] }, ttl: { fields: { user: "expiresAt" } } };
    const normal = adapterFor(options);
    const stale = adapterFor({ ...options, client: clientWithTransactionPause(pause) });
    await create(normal, "user", { id: "retained-owner-a", email: "retained@example.com", expiresAt: "2030-01-01T00:00:00.000Z" });

    const oldUpdate = stale.update({ model: "user", where: [eq("id", "retained-owner-a")], update: { expiresAt: "2031-01-01T00:00:00.000Z" } });
    await pause.waitUntilPaused();
    await docClient.send(new DeleteCommand({ TableName: tableName, Key: { pk: uniquePk("user", "email"), sk: valueSk("retained@example.com", "") } }));
    await create(normal, "user", { id: "retained-owner-b", email: "retained@example.com" });
    pause.release();
    await oldUpdate.catch(() => undefined);

    await expect(rawRow(uniquePk("user", "email"), valueSk("retained@example.com", ""))).resolves.toMatchObject({ ownerSk: entitySk("retained-owner-b") });
    await expect(create(normal, "user", { id: "retained-owner-c", email: "retained@example.com" })).rejects.toBeInstanceOf(DynamoDBConflictError);
  });

  it("allows a legitimate delete to complete when its lock was already physically removed", async () => {
    const adapter = schemaIndexAdapter(true);
    await create(adapter, "oauthClientResource", { id: "lockless-owner", clientId: "lockless-client", resourceId: "lockless-resource" });
    await docClient.send(new DeleteCommand({ TableName: tableName, Key: { pk: compoundUniquePk("oauthClientResource", compoundUniqueIndexName(["clientId", "resourceId"])), sk: compoundUniqueSk(["lockless-client", "lockless-resource"]) } }));

    await expect(adapter.delete({ model: "oauthClientResource", where: [eq("id", "lockless-owner")] })).resolves.toBeUndefined();
    await expect(adapter.findOne({ model: "oauthClientResource", where: [eq("id", "lockless-owner")] })).resolves.toBeNull();
  });

  it("stops scheduling new bulk writes after an observed transaction failure", async () => {
    let started = 0;
    const failingClient = { send: async (command: any) => {
      if (command instanceof TransactWriteCommand) {
        started += 1;
        if (started === 3) throw new Error("synthetic bulk failure");
      }
      return docClient.send(command);
    } } as unknown as DynamoDBDocumentClient;
    const normal = adapterFor({ client: docClient });
    const failing = adapterFor({ client: failingClient, maxBulkConcurrency: 2 });
    for (let index = 0; index < 12; index += 1) await create(normal, "plugin", { id: `bulk-failure-${index}`, externalId: `bulk-failure-${index}`, kind: "failure" });

    await expect(failing.updateMany({ model: "plugin", where: [inValues("id", Array.from({ length: 12 }, (_, index) => `bulk-failure-${index}`))] as never, update: { name: "partial" } })).rejects.toThrow("synthetic bulk failure");
    expect(started).toBeLessThan(12);
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
          member: { fields: { organizationId: { type: "string", required: true }, role: { type: "string", required: true }, email: { type: "string", required: true }, active: { type: "boolean", required: true } } },
          wide: { fields: Object.fromEntries(Array.from({ length: 99 }, (_, index) => [`field-${index}`, { type: "string", required: false }])) },
          plugin: { fields: { externalId: { type: "string", required: true, unique: true }, kind: { type: "string", required: true }, ttl: { type: "number", required: false }, name: { type: "string", required: false }, expiresAt: { type: "string", required: false } } }
        }
      }
    ]
  };
}

function schemaAuthOptions() {
  return {
    secret: "test-secret",
    emailAndPassword: { enabled: true },
    plugins: [
      {
        id: "oauth-provider-schema",
        schema: {
          oauthClientResource: {
            fields: {
              clientId: { type: "string", required: true },
              resourceId: { type: "string", required: true },
              expiresAt: { type: "string", required: false }
            },
            indexes: [{ fields: ["clientId", "resourceId"], unique: true }]
          }
        }
      }
    ]
  };
}

function schemaIndexAdapter(enforce: boolean, maxPages?: number): TestAdapter {
  return dynamoDBAdapter({ tableName, client: docClient, ...(maxPages ? { maxPages } : {}), ...(enforce ? { enforceSchemaUniqueIndexes: true } : {}) } as never)(schemaAuthOptions() as never) as TestAdapter;
}

function schemaIndexAdapterWithClient(enforce: boolean, client: DynamoDBDocumentClient): TestAdapter {
  return dynamoDBAdapter({ tableName, client, ...(enforce ? { enforceSchemaUniqueIndexes: true } : {}) } as never)(schemaAuthOptions() as never) as TestAdapter;
}

function realProviderAdapter(enforce: boolean): TestAdapter {
  return dynamoDBAdapter({ tableName, client: docClient, ...(enforce ? { enforceSchemaUniqueIndexes: true } : {}) } as never)({ secret: "test-secret", plugins: [oauthProvider({ loginPage: "/login", consentPage: "/consent" })] } as never) as TestAdapter;
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

class TransactionPause {
  private paused = false;
  private readonly pausedPromise: Promise<void>;
  private markPaused!: () => void;
  private releaseTransaction!: () => void;

  constructor() {
    this.pausedPromise = new Promise((resolve) => { this.markPaused = resolve; });
  }

  async waitUntilPaused(timeoutMs = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        this.pausedPromise,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for transaction pause after ${timeoutMs}ms`)), timeoutMs); })
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }

  pause(): Promise<void> {
    if (!this.paused) {
      this.paused = true;
      this.markPaused();
    }
    return new Promise((resolve) => { this.releaseTransaction = resolve; });
  }

  release(): void { this.releaseTransaction(); }
}

function clientWithTransactionPause(pause: TransactionPause): DynamoDBDocumentClient {
  return { send: async (command) => {
    if (command instanceof TransactWriteCommand) await pause.pause();
    return docClient.send(command);
  } } as DynamoDBDocumentClient;
}

function countingClient(counter: { count: number }): DynamoDBDocumentClient {
  return { send: async (command) => { counter.count += 1; return docClient.send(command); } } as DynamoDBDocumentClient;
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

async function deleteAllRows(): Promise<void> {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new ScanCommand({ TableName: tableName, ConsistentRead: true, ExclusiveStartKey }));
    for (const item of result.Items ?? []) {
      await docClient.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }));
    }
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}
