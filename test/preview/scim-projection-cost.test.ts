import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { betterAuth } from "better-auth";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { dynamoDBAdapter, initializeDynamoDBTransactions } from "../../src/index.js";
import { indexPk } from "../../src/keys.js";
import { previewDatabase } from "./database.js";

it("anchors group projection reads on affected users without loading domain-wide candidates", async ({ onTestFinished }) => {
  if (!process.env.SCIM_PREVIEW_MODULE) throw new Error("Set SCIM_PREVIEW_MODULE to the built enterprise SCIM module.");
  const { scim } = await import(pathToFileURL(resolve(process.env.SCIM_PREVIEW_MODULE)).href);
  const database = await previewDatabase();
  onTestFinished(database.close);
  const broadPartitions = new Set([indexPk("scimUser", "provisioningDomainId", "directory"), indexPk("scimProjectionGrant", "provisioningDomainId", "directory")]);
  let measuring = false;
  let broadReads = 0;
  const client = { config: database.options.client.config, send: async (command: any) => {
    if (measuring && command instanceof QueryCommand && broadPartitions.has(command.input.ExpressionAttributeValues?.[":pk"])) broadReads++;
    return database.options.client.send(command);
  } } as unknown as DynamoDBDocumentClient;
  const options = { ...database.options, client };
  await initializeDynamoDBTransactions(options);
  const auth = betterAuth({ baseURL: "http://localhost:3000", secret: "projection-cost-test-secret-at-least-32-characters", database: dynamoDBAdapter(options), plugins: [scim({ connections: [{ id: "workforce", provisioningDomainId: "directory", credentials: [{ type: "bearer", id: "test", token: "test" }] }], projection: { roles: { map: () => ["member"], exists: () => true }, reconcileUser: () => {} } })] });
  const request = (path: string, body: unknown) => auth.handler(new Request(`http://localhost:3000/api/auth/scim/v2${path}`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/scim+json" }, body: JSON.stringify(body) }));
  const created = await request("/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "indexed@example.com" });
  expect(created.status).toBe(201);
  const user = await created.json() as { id: string };
  measuring = true;
  const group = await request("/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Indexed", members: [{ value: user.id }] });
  expect(group.status).toBe(201);
  expect(broadReads).toBe(0);
  expect(await (await auth.$context).adapter.count({ model: "scimProjectionGrant", where: [{ field: "connectionId", value: "workforce" }] })).toBe(1);
}, process.env.SCIM_PREVIEW_AWS_REGION ? 300_000 : 90_000);
