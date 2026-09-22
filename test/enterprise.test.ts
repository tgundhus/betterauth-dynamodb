import { it } from "vitest";
import { MemoryDynamoDB } from "./helpers/memory-dynamodb.js";
import { enterpriseContract } from "./helpers/enterprise-contract.js";
import { ssoContract, ssoGuardContract } from "./helpers/sso-contract.js";

it("supports the published SCIM lifecycle, projection rollback and SSO transaction initialization", async () => {
  const db = new MemoryDynamoDB();
  await enterpriseContract({ tableName: "enterprise", client: db.asClient() });
}, 30_000);

it("rolls back rejected SSO resolution and revokes a provisioned user's SSO session", async () => {
  await ssoContract({ tableName: "sso", client: new MemoryDynamoDB().asClient() });
}, 30_000);

it("commits or rolls back advanced SSO provider mutation guards", async () => {
  await ssoGuardContract({ tableName: "guards", client: new MemoryDynamoDB().asClient() });
});
