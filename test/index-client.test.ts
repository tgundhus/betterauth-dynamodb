import { describe, expect, it } from "vitest";
import { createDocumentClient, normalizeOptions } from "../src/client.js";
import { DynamoDBAdapterError, dynamoDBAdapter } from "../src/index.js";
import { REVISION_ATTRIBUTE } from "../src/serialize.js";

describe("public adapter and client helpers", () => {
  it("normalizes option defaults and builds a document client", () => {
    expect(normalizeOptions({ tableName: "auth" })).toMatchObject({ maxPages: 25, unsafeAllowScan: false });
    expect(normalizeOptions({ tableName: "auth", pageSize: 10, maxPages: 2 })).toMatchObject({ pageSize: 10, maxPages: 2 });
    expect(createDocumentClient({ tableName: "auth", region: "us-east-1", endpoint: "http://localhost:8000" })).toBeTruthy();
  });

  it.each(["maxPages", "pageSize"] as const)("rejects invalid %s values", (name) => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => normalizeOptions({ tableName: "auth", [name]: value })).toThrow(DynamoDBAdapterError);
      expect(() => normalizeOptions({ tableName: "auth", [name]: value })).toThrow(new RegExp(`${name} must be a positive safe integer`));
    }
  });

  it("creates a Better Auth adapter factory", async () => {
    const send = async (command: any) => {
      if (command.constructor.name === "GetCommand") return { Item: { pk: "MODEL#s4:user", sk: "ID#s1:u", id: "u", [REVISION_ATTRIBUTE]: "rev-1", entity: { id: "u", email: "a@example.com", emailVerified: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } };
      if (command.constructor.name === "QueryCommand") return { Items: [] };
      if (command.constructor.name === "UpdateCommand") return { Attributes: { id: "u", entity: { id: "u" } } };
      return {};
    };
    const adapter = dynamoDBAdapter({ tableName: "auth", client: { send } as never })({ secret: "x", emailAndPassword: { enabled: true } } as never);
    expect(adapter.id).toBe("betterauth-dynamodb");
    expect(adapter.options?.tableName).toBe("auth");
    await adapter.findOne({ model: "user", where: [{ field: "id", value: "u" }] });
    await adapter.findMany({ model: "user", where: [{ field: "email", value: "a@example.com" }], limit: 1 });
    await adapter.count({ model: "user", where: [{ field: "email", value: "a@example.com" }] });
    await adapter.update({ model: "user", where: [{ field: "id", value: "u" }], update: { name: "A" } });
    await adapter.delete({ model: "user", where: [{ field: "id", value: "u" }] });
    await adapter.deleteMany({ model: "user", where: [{ field: "email", value: "a@example.com" }] });
    await adapter.consumeOne({ model: "user", where: [{ field: "id", value: "u" }] });
    await adapter.transaction(async () => "ok");
  });
});
