import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface BetterAuthDynamoDBOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  region?: string;
  endpoint?: string;
  dynamoDBClientConfig?: DynamoDBClientConfig;
  ttl?: false | TtlOptions;
  unsafeAllowScan?: boolean;
  maxPages?: number;
  pageSize?: number;
  uniqueFields?: Record<string, string[]>;
}

export interface TtlOptions {
  attributeName?: string;
  fields?: Record<string, string>;
  defaultField?: string;
}

export interface StoredItem extends Record<string, unknown> {
  pk: string;
  sk: string;
  model: string;
  id: string;
  entity: Record<string, unknown>;
  __betterAuthDynamoDBRevision: string;
  ttl?: number;
  createdAtSort?: string;
}

export interface SidecarItem extends Record<string, unknown> {
  pk: string;
  sk: string;
  model: string;
  id: string;
  entity: Record<string, unknown>;
  ownerPk: string;
  ownerSk: string;
  indexModel?: string;
  indexField?: string;
  indexValue?: unknown;
  ttl?: number;
}

export interface CleanedWhere {
  field: string;
  value: string | number | boolean | string[] | number[] | Date | null;
  operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "not_in" | "contains" | "starts_with" | "ends_with";
  connector?: "AND" | "OR";
  mode: "sensitive" | "insensitive";
}

export interface QueryPlan {
  kind: "byId" | "byFieldValue" | "byModel";
  where: CleanedWhere[];
}
