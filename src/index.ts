import { createAdapterFactory } from "better-auth/adapters";
import { DynamoDBStore } from "./dynamodb-adapter.js";
import { UnsupportedQueryError } from "./errors.js";
import type { BetterAuthDynamoDBOptions } from "./types.js";

export type { BetterAuthDynamoDBOptions, TtlOptions } from "./types.js";
export { DynamoDBAdapterError, DynamoDBConflictError, UnsupportedQueryError } from "./errors.js";

export function dynamoDBAdapter(adapterOptions: BetterAuthDynamoDBOptions) {
  return createAdapterFactory({
    config: {
      adapterId: "betterauth-dynamodb",
      adapterName: "Better Auth DynamoDB",
      supportsDates: false,
      supportsBooleans: true,
      supportsJSON: true,
      supportsArrays: true,
      supportsNumericIds: false,
      transaction: false
    },
    adapter: ({ schema, getModelName, getFieldName }) => {
      const schemaUniqueFields = collectUniqueFields(schema, getModelName, getFieldName);
      const store = new DynamoDBStore({ ...adapterOptions, uniqueFields: mergeUniqueFields(schemaUniqueFields, adapterOptions.uniqueFields) });
      const adapter: any = {
        create: <T extends Record<string, unknown>>(data: { model: string; data: T }) => store.create(data.model, data.data),
        findOne: <T>(data: { model: string; where: any[]; select?: string[]; join?: Record<string, unknown> }) => {
          assertNoNativeJoin(data.join);
          return store.findOne<T>(data.model, data.where, storageSelect(data.model, data.select, schema, getModelName, getFieldName));
        },
        findMany: <T>(data: { model: string; where?: any[]; limit: number; offset?: number; sortBy?: { field: string; direction: "asc" | "desc" }; select?: string[]; join?: Record<string, unknown> }) => {
          assertNoNativeJoin(data.join);
          return store.findMany<T>(data.model, data.where, data.limit, data.offset, data.sortBy, storageSelect(data.model, data.select, schema, getModelName, getFieldName));
        },
        count: (data: { model: string; where?: any[] }) => store.count(data.model, data.where),
        update: <T>(data: { model: string; where: any[]; update: Record<string, unknown> }) => store.update<T>(data.model, data.where, data.update),
        updateMany: (data: { model: string; where: any[]; update: Record<string, unknown> }) => store.updateMany(data.model, data.where, data.update),
        delete: (data: { model: string; where: any[] }) => store.delete(data.model, data.where),
        deleteMany: (data: { model: string; where: any[] }) => store.deleteMany(data.model, data.where),
        consumeOne: <T>(data: { model: string; where: any[] }) => store.consumeOne<T>(data.model, data.where),
        incrementOne: <T>(data: { model: string; where: any[]; increment: Record<string, number>; set?: Record<string, unknown> }) =>
          store.incrementOne<T>(data.model, data.where, data.increment, data.set),
        options: { tableName: adapterOptions.tableName }
      };
      return adapter;
    }
  });
}

function mergeUniqueFields(...sources: (Record<string, string[]> | undefined)[]): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of sources) {
    for (const [model, fields] of Object.entries(source ?? {})) merged[model] = [...new Set([...(merged[model] ?? []), ...fields])];
  }
  return merged;
}

type AdapterSchema = Record<string, { fields: Record<string, { unique?: boolean | undefined }> }>;
type ModelNameResolver = (model: string) => string;
type FieldNameResolver = (input: { model: string; field: string }) => string;

function collectUniqueFields(schema: AdapterSchema, getModelName: ModelNameResolver, getFieldName: FieldNameResolver): Record<string, string[]> {
  return mergeUniqueEntries(Object.entries(schema).map((entry) => uniqueFieldEntry(entry, getModelName, getFieldName)).filter(hasUniqueFields));
}

function mergeUniqueEntries(entries: [string, string[]][]): Record<string, string[]> {
  return mergeUniqueFields(...entries.map(([model, fields]) => ({ [model]: fields })));
}

function uniqueFieldEntry(entry: [string, AdapterSchema[string]], getModelName: ModelNameResolver, getFieldName: FieldNameResolver): [string, string[]] {
  const [model, table] = entry;
  return [getModelName(model), Object.entries(table.fields).filter((field) => field[1].unique).map((field) => getFieldName({ model, field: field[0] }))];
}

function hasUniqueFields(entry: [string, string[]]): boolean {
  return entry[1].length > 0;
}

function storageSelect(model: string, select: string[] | undefined, schema: AdapterSchema, getModelName: ModelNameResolver, getFieldName: FieldNameResolver): string[] | undefined {
  if (!select) return undefined;
  const defaultModel = defaultModelName(model, schema, getModelName);
  return select.map((field) => getFieldName({ model: defaultModel, field }));
}

function defaultModelName(model: string, schema: AdapterSchema, getModelName: ModelNameResolver): string {
  return Object.keys(schema).find((key) => getModelName(key) === model) ?? model;
}

function assertNoNativeJoin(join: Record<string, unknown> | undefined): void {
  if (!join || Object.keys(join).length === 0) return;
  throw new UnsupportedQueryError("Better Auth experimental native joins are not supported by the DynamoDB adapter. Disable experimental.joins so Better Auth can use its fallback join queries.");
}
