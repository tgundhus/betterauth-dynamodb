import { betterAuth } from "better-auth";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { previewDatabase } from "./database.js";
import { dynamoDBAdapter, initializeDynamoDBTransactions } from "../../src/index.js";

it("does not commit a staged group grant after concurrent user deactivation", async ({ onTestFinished }) => {
  if (!process.env.SCIM_PREVIEW_MODULE) throw new Error("Set SCIM_PREVIEW_MODULE to the built enterprise SCIM module.");
  const { scim } = await import(pathToFileURL(resolve(process.env.SCIM_PREVIEW_MODULE)).href);
  const database = await previewDatabase();
  onTestFinished(database.close);
  await initializeDynamoDBTransactions(database.options);
  let pause = false;
  let entered!: () => void;
  const projectionEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const resume = new Promise<void>((resolve) => { release = resolve; });
  const auth = betterAuth({ baseURL: "http://localhost:3000", secret: "concurrent-scim-test-secret-at-least-32-characters", database: dynamoDBAdapter(database.options), user: { additionalFields: { enterpriseRole: { type: "string", required: false } } }, plugins: [scim({ groups: { maxMembers: null }, bulk: { jobs: true }, connections: [{ id: "workforce", credentials: [{ type: "bearer", id: "test", token: "test" }] }], projection: {
    roles: { map: () => ["member"], exists: () => true },
    reconcileUser: async (input: { userId: string; active: boolean; grants: unknown[] }, context: { database: { update: (input: unknown) => Promise<unknown> } }) => {
      await context.database.update({ model: "user", where: [{ field: "id", value: input.userId }], update: { enterpriseRole: input.active && input.grants.length ? "member" : "none" } });
      if (pause && input.active && input.grants.length) { entered(); await resume; }
    }
  } })] });
  const request = (path: string, method: string, body?: unknown) => auth.handler(new Request(`http://localhost:3000/api/auth/scim/v2${path}`, { method, headers: { authorization: "Bearer test", "content-type": "application/scim+json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const created = await request("/Users", "POST", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "race@example.com" });
  expect(created.status).toBe(201);
  const user = await created.json() as { id: string };
  const groupCreated = await request("/Groups", "POST", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Race", members: [] });
  expect(groupCreated.status).toBe(201);
  const group = await groupCreated.json() as { id: string };
  const add = { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "add", path: "members", value: [{ value: user.id }] }] };
  pause = true;
  const concurrent = request(`/Groups/${group.id}`, "PATCH", add);
  // A deadline in the test avoids hiding a broken synchronization contract.
  const timer = setTimeout(release, 20_000);
  try {
    await projectionEntered;
    const deactivated = await request(`/Users/${user.id}`, "PATCH", { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] });
    expect(deactivated.status).toBe(200);
  } finally { clearTimeout(timer); pause = false; release(); }
  expect((await concurrent).status).toBeGreaterThanOrEqual(400);
  const adapter = (await auth.$context).adapter;
  expect(await adapter.count({ model: "user", where: [{ field: "enterpriseRole", value: "member" }] })).toBe(0);
  expect(await adapter.count({ model: "scimProjectionGrant", where: [{ field: "connectionId", value: "workforce" }] })).toBe(0);
  expect(await adapter.count({ model: "scimGroupMember", where: [{ field: "groupId", value: group.id }] })).toBe(0);
  expect((await request(`/Groups/${group.id}`, "PATCH", add)).status).toBe(200);
  expect(await adapter.count({ model: "user", where: [{ field: "enterpriseRole", value: "member" }] })).toBe(0);
}, 90_000);
