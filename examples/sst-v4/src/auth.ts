import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";
import { betterAuth } from "better-auth";
import { Resource } from "sst";

type LinkedResources = typeof Resource & {
  BetterAuthSecret: { value: string };
  BetterAuthTable: { name: string };
};

const linked = Resource as LinkedResources;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});

export const auth = betterAuth({
  secret: linked.BetterAuthSecret.value,
  database: dynamoDBAdapter({
    tableName: linked.BetterAuthTable.name,
    client: dynamo,
    ttl: { fields: { session: "expiresAt", verification: "expiresAt" } }
  }),
  verification: { disableCleanup: true },
  emailAndPassword: { enabled: true }
});
