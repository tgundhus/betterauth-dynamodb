import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { expect } from "vitest";
import { dynamoDBAdapter, initializeDynamoDBTransactions, type BetterAuthDynamoDBOptions } from "../../src/index.js";

const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
const groupSchema = "urn:ietf:params:scim:schemas:core:2.0:Group";
const patchSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** Same public HTTP contract runs against the command double and DynamoDB Local. */
export async function enterpriseContract(options: BetterAuthDynamoDBOptions) {
  await initializeDynamoDBTransactions(options);
  let rejectProjection = false;
  const auth = betterAuth({
    baseURL: "http://localhost:3000", secret: "enterprise-test-secret-with-at-least-32-characters", database: dynamoDBAdapter({ ...options, transactions: true }),
    emailAndPassword: { enabled: true }, user: { additionalFields: { enterpriseRole: { type: "string", required: false } } },
    plugins: [scim({ connections: [{ id: "workforce", credentials: [{ type: "bearer", id: "test", token: "test-token" }] }], projection: {
      roles: { map: () => ["member"], exists: ({ role }) => role === "member" },
      async reconcileUser(state, context) {
        await context.database.update({ model: "user", where: [{ field: "id", value: state.userId }], update: { enterpriseRole: state.grants[0]?.role ?? null } });
        if (rejectProjection && state.grants.length) throw new Error("injected projection failure");
      }
    } }) as unknown as BetterAuthPlugin, sso({ guardProviderMutation: async () => {}, resolveUser: async () => { throw new Error("Not used by this provisioning test"); } })]
  });
  const request = async (path: string, method: string, body?: unknown) => {
    const response = await auth.handler(new Request(`http://localhost:3000/api/auth/scim/v2${path}`, { method, headers: { authorization: "Bearer test-token", "content-type": "application/scim+json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
  };
  const users: string[] = [];
  for (let index = 0; index < 45; index++) {
    const result = await request("/Users", "POST", { schemas: [userSchema], userName: `enterprise-${index}@example.com` });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    users.push(result.body.id);
  }
  const group = await request("/Groups", "POST", { schemas: [groupSchema], displayName: "Enterprise", members: [] });
  expect(group.status, JSON.stringify(group.body)).toBe(201);
  const membershipPatch = { schemas: [patchSchema], Operations: [{ op: "add", path: "members", value: users.map((value) => ({ value })) }] };
  rejectProjection = true;
  expect((await request(`/Groups/${group.body.id}`, "PATCH", membershipPatch)).status).toBe(500);
  expect((await request(`/Groups/${group.body.id}`, "GET")).body.members).toHaveLength(0);
  rejectProjection = false;
  const added = await request(`/Groups/${group.body.id}`, "PATCH", membershipPatch);
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  expect(added.body.members).toHaveLength(users.length);
  const adapter = (await auth.$context).adapter;
  expect(await adapter.count({ model: "scimProjectionGrant", where: [{ field: "connectionId", value: "workforce" }] })).toBe(45);
  expect((await request(`/Users/${users[0]}`, "DELETE")).status).toBe(204);
  expect((await request(`/Groups/${group.body.id}`, "GET")).body.members).toHaveLength(44);
  expect((await request(`/Groups/${group.body.id}`, "DELETE")).status).toBe(204);
  expect(await adapter.count({ model: "scimGroupMember", where: [{ field: "connectionId", value: "workforce" }] })).toBe(0);
  expect(await adapter.count({ model: "scimProjectionGrant", where: [{ field: "connectionId", value: "workforce" }] })).toBe(0);
}
