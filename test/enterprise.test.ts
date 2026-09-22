import { it } from "vitest";
import { MemoryDynamoDB } from "./helpers/memory-dynamodb.js";
import { enterpriseContract } from "./helpers/enterprise-contract.js";

it("supports the published SCIM lifecycle, projection rollback and SSO transaction initialization", async () => {
  const db = new MemoryDynamoDB();
  await enterpriseContract({ tableName: "enterprise", client: db.asClient() });
}, 30_000);
