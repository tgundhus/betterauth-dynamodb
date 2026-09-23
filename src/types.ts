import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { CallbackContext } from "./transactions/context.js";
import type { TransactionEngine } from "./transactions/engine.js";

export interface BetterAuthDynamoDBOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  region?: string;
  endpoint?: string;
  dynamoDBClientConfig?: DynamoDBClientConfig;
  ttl?: false | TtlOptions;
  unsafeAllowScan?: boolean;
  /** Request strongly consistent reads. Defaults to true. */
  consistentRead?: boolean;
  maxPages?: number;
  pageSize?: number;
  uniqueFields?: Record<string, string[]>;
  /** Opt in to Better Auth schema `indexes` unique constraints. */
  enforceSchemaUniqueIndexes?: boolean;
  /** Maximum concurrent bulk transactions, scalar IN queries, or BatchGet chunks. */
  maxBulkConcurrency?: number;
  /** Participate in initialized transaction storage without offering callback transactions. Required for ordinary readers and writers sharing a table with transactional SCIM. */
  transactionStorage?: boolean;
  /** Offer callback transactions and participate in initialized transaction storage. */
  transactions?: boolean;
}

/** Store options: public adapter options plus schema metadata resolved and validated by the adapter factory. */
export interface DynamoDBStoreOptions extends BetterAuthDynamoDBOptions {
  schemaUniqueIndexes?: SchemaUniqueIndex[];
  transactionContext?: CallbackContext;
  transactionEngine?: TransactionEngine;
}

export interface SchemaUniqueIndex {
  model: string;
  name: string;
  fields: string[];
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
  kind: "byId" | "byIdValues" | "byFieldValue" | "byFieldValues" | "byModel";
  where: CleanedWhere[];
}
