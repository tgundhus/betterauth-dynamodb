import { betterAuth } from "better-auth";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { previewDatabase } from "./database.js";
import { dynamoDBAdapter, initializeDynamoDBTransactions } from "../../src/index.js";

const memberCount = Number(process.env.SCIM_SCALE_MEMBERS ?? 1_051);
if (!Number.isSafeInteger(memberCount) || memberCount < 11) throw new Error("SCIM_SCALE_MEMBERS must be an integer of at least 11");

it("provisions Bulk users and preserves every large-group member through lifecycle and decommissioning", async ({ onTestFinished }) => {
  if (!process.env.SCIM_PREVIEW_MODULE) throw new Error("Set SCIM_PREVIEW_MODULE to the built enterprise SCIM module. The published 1.7.5 package does not implement Bulk.");
  const { scim } = await import(pathToFileURL(resolve(process.env.SCIM_PREVIEW_MODULE)).href);
  const database = await previewDatabase();
  onTestFinished(database.close);
  const options = database.options;
  await initializeDynamoDBTransactions(options);
  const auth = betterAuth({ baseURL: "http://localhost:3000", secret: "large-group-test-secret-at-least-32-characters", database: dynamoDBAdapter(options), user: { additionalFields: { enterpriseRole: { type: "string", required: false } } }, plugins: [scim({ groups: { maxMembers: null }, bulk: {}, connections: [{ id: "workforce", credentials: [{ type: "bearer", id: "test", token: "test" }] }], projection: {
    roles: { map: () => ["member"], exists: () => true },
    reconcileUser: async (input: { userId: string; active: boolean; grants: unknown[] }, context: { database: { update: (input: unknown) => Promise<unknown> } }) => {
      await context.database.update({ model: "user", where: [{ field: "id", value: input.userId }], update: { enterpriseRole: input.active && input.grants.length ? "member" : "none" } });
    }
  } })] });
  const adapter = (await auth.$context).adapter;
  const projectedUsers = () => adapter.count({ model: "user", where: [{ field: "enterpriseRole", value: "member" }] });
  const request = async (path: string, method: string, body?: unknown) => {
    const started = performance.now();
    const response = await auth.handler(new Request(`http://localhost:3000/api/auth/scim/v2${path}`, { method, headers: { authorization: "Bearer test", "content-type": "application/scim+json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const data = response.status === 204 ? null : await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBeLessThan(300);
    console.info(JSON.stringify({ method, resource: path.split("/")[1], members: memberCount, durationMs: Math.round(performance.now() - started) }));
    return data;
  };
  const bulk = await request("/Bulk", "POST", { schemas: ["urn:ietf:params:scim:api:messages:2.0:BulkRequest"], Operations: Array.from({ length: memberCount }, (_, index) => ({ method: "POST", path: "/Users", bulkId: `user-${index}`, data: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `large-${index}@example.com` } })) });
  expect(bulk.Operations).toHaveLength(memberCount);
  expect(new Set(bulk.Operations.map((operation: any) => operation.status))).toEqual(new Set(["201"]));
  console.info(`Bulk: ${memberCount} users committed`);
  const members = bulk.Operations.map((operation: any) => ({ value: operation.location.split("/").at(-1) }));
  const schema = "urn:ietf:params:scim:schemas:core:2.0:Group";
  const group = await request("/Groups", "POST", { schemas: [schema], displayName: "Large group", members });
  expect(group.members).toHaveLength(memberCount);
  expect(await projectedUsers()).toBe(memberCount);
  console.info(`Group: ${memberCount} members committed`);
  expect((await request(`/Groups/${group.id}`, "GET")).members).toHaveLength(memberCount);
  expect((await request("/Groups", "GET")).Resources[0].members).toHaveLength(memberCount);
  console.info("Group: complete point and collection reads verified");
  const replaced = await request(`/Groups/${group.id}`, "PUT", { schemas: [schema], displayName: "Replaced", members: members.slice(10) });
  expect(replaced.members).toHaveLength(memberCount - 10);
  expect(await projectedUsers()).toBe(memberCount - 10);
  console.info("Group: membership replacement verified");
  const patched = await request(`/Groups/${group.id}`, "PATCH", { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "add", path: "members", value: members.slice(0, 10) }] });
  expect(patched.members).toHaveLength(memberCount);
  expect(await projectedUsers()).toBe(memberCount);
  console.info("Group: membership PATCH verified");
  await request(`/Groups/${group.id}`, "DELETE");
  expect(await projectedUsers()).toBe(0);
  expect(await adapter.count({ model: "scimGroupMember", where: [{ field: "connectionId", value: "workforce" }] })).toBe(0);
  await request("/Groups", "POST", { schemas: [schema], displayName: "Retirement group", members });
  expect(await projectedUsers()).toBe(memberCount);
  const decommissionStarted = performance.now();
  const api = auth.api as unknown as { decommissionSCIMConnection(input: { body: { connectionId: string } }): Promise<{ status: string; reconciledUsers: number }> };
  const retired = await api.decommissionSCIMConnection({ body: { connectionId: "workforce" } });
  expect(retired.status).toBe("complete");
  expect(retired.reconciledUsers).toBe(memberCount);
  expect(await projectedUsers()).toBe(0);
  expect(await adapter.count({ model: "scimProjectionGrant", where: [{ field: "connectionId", value: "workforce" }] })).toBe(0);
  const rejected = await auth.handler(new Request("http://localhost:3000/api/auth/scim/v2/Users", { headers: { authorization: "Bearer test" } }));
  expect(rejected.status).toBe(401);
  console.info(JSON.stringify({ operation: "decommission", members: memberCount, durationMs: Math.round(performance.now() - decommissionStarted) }));
}, Math.max(1_200_000, memberCount * 1_000));
