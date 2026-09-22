import { betterAuth } from "better-auth";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { MemoryDynamoDB } from "../helpers/memory-dynamodb.js";
import { dynamoDBAdapter, initializeDynamoDBTransactions } from "../../src/index.js";

it("provisions 1,051 users through Bulk and preserves every large-group member", async () => {
  if (!process.env.SCIM_PREVIEW_MODULE) throw new Error("Set SCIM_PREVIEW_MODULE to the built enterprise SCIM module. The published 1.7.5 package does not implement Bulk.");
  const { scim } = await import(pathToFileURL(resolve(process.env.SCIM_PREVIEW_MODULE)).href);
  const database = new MemoryDynamoDB();
  const options = { tableName: "large-scim", client: database.asClient(), transactions: true };
  await initializeDynamoDBTransactions(options);
  const auth = betterAuth({ baseURL: "http://localhost:3000", secret: "large-group-test-secret-at-least-32-characters", database: dynamoDBAdapter(options), plugins: [scim({ groups: { maxMembers: null }, bulk: {}, connections: [{ id: "workforce", credentials: [{ type: "bearer", id: "test", token: "test" }] }] })] });
  const request = async (path: string, method: string, body?: unknown) => {
    const response = await auth.handler(new Request(`http://localhost:3000/api/auth/scim/v2${path}`, { method, headers: { authorization: "Bearer test", "content-type": "application/scim+json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const data = response.status === 204 ? null : await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBeLessThan(300);
    return data;
  };
  const bulk = await request("/Bulk", "POST", { schemas: ["urn:ietf:params:scim:api:messages:2.0:BulkRequest"], Operations: Array.from({ length: 1_051 }, (_, index) => ({ method: "POST", path: "/Users", bulkId: `user-${index}`, data: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `large-${index}@example.com` } })) });
  expect(bulk.Operations).toHaveLength(1_051);
  expect(new Set(bulk.Operations.map((operation: any) => operation.status))).toEqual(new Set(["201"]));
  const members = bulk.Operations.map((operation: any) => ({ value: operation.location.split("/").at(-1) }));
  const schema = "urn:ietf:params:scim:schemas:core:2.0:Group";
  const group = await request("/Groups", "POST", { schemas: [schema], displayName: "Large group", members });
  expect(group.members).toHaveLength(1_051);
  expect((await request(`/Groups/${group.id}`, "GET")).members).toHaveLength(1_051);
  expect((await request("/Groups", "GET")).Resources[0].members).toHaveLength(1_051);
  const replaced = await request(`/Groups/${group.id}`, "PUT", { schemas: [schema], displayName: "Replaced", members: members.slice(10) });
  expect(replaced.members).toHaveLength(1_041);
  const patched = await request(`/Groups/${group.id}`, "PATCH", { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "add", path: "members", value: members.slice(0, 10) }] });
  expect(patched.members).toHaveLength(1_051);
  await request(`/Groups/${group.id}`, "DELETE");
  const adapter = (await auth.$context).adapter;
  expect(await adapter.count({ model: "scimGroupMember", where: [{ field: "connectionId", value: "workforce" }] })).toBe(0);
}, 600_000);
