import { createAdapterFactory } from "better-auth/adapters";
import { DynamoDBStore } from "./dynamodb-adapter.js";
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
    adapter: ({ schema }) => {
      const store = new DynamoDBStore({ ...adapterOptions, uniqueFields: mergeUniqueFields(collectUniqueFields(schema), adapterOptions.uniqueFields) });
      const adapter: any = {
        create: <T extends Record<string, unknown>>(data: { model: string; data: T }) => store.create(data.model, data.data),
        findOne: <T>(data: { model: string; where: any[] }) => store.findOne<T>(data.model, data.where),
        findMany: <T>(data: { model: string; where?: any[]; limit: number; offset?: number; sortBy?: { field: string; direction: "asc" | "desc" } }) =>
          store.findMany<T>(data.model, data.where, data.limit, data.offset, data.sortBy),
        count: (data: { model: string; where?: any[] }) => store.count(data.model, data.where),
        update: <T>(data: { model: string; where: any[]; update: Record<string, unknown> }) => store.update<T>(data.model, data.where, data.update),
        updateMany: (data: { model: string; where: any[]; update: Record<string, unknown> }) => store.updateMany(data.model, data.where, data.update),
        delete: (data: { model: string; where: any[] }) => store.delete(data.model, data.where),
        deleteMany: (data: { model: string; where: any[] }) => store.deleteMany(data.model, data.where),
        consumeOne: <T>(data: { model: string; where: any[] }) => store.consumeOne<T>(data.model, data.where),
        incrementOne: <T>(data: { model: string; where: any[]; increment: Record<string, number>; set?: Record<string, unknown> }) =>
          store.incrementOne<T>(data.model, data.where, data.increment, data.set),
        transaction: <R>(callback: (trx: any) => Promise<R>) => callback(adapter),
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

function collectUniqueFields(schema: Record<string, { fields: Record<string, { unique?: boolean | undefined }> }>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(schema).map(uniqueFieldEntry).filter(hasUniqueFields));
}

function uniqueFieldEntry(entry: [string, { fields: Record<string, { unique?: boolean | undefined }> }]): [string, string[]] {
  return [entry[0], Object.entries(entry[1].fields).filter((field) => field[1].unique).map((field) => field[0])];
}

function hasUniqueFields(entry: [string, string[]]): boolean {
  return entry[1].length > 0;
}
