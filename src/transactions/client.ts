import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { DynamoDBAdapterError, isConditionalTransactionCanceled } from "../errors.js";
import { FORMAT, FORMAT_KEY, INTENT, intentOf, keyOf, PHYSICAL_VERSION, versioned } from "./format.js";
import type { TransactionEngine } from "./engine.js";
import type { Action } from "./journal.js";
import type { Item, Key } from "./types.js";

export function participatingClient(base: DynamoDBDocumentClient, engine: TransactionEngine): DynamoDBDocumentClient {
  let ready: Promise<void> | undefined;
  const send = async (command: any) => {
    ready ??= checkFormat(engine);
    await ready;
    if (command instanceof TransactWriteCommand) return guardedWrite(base, engine, command);
    return resolveResponse(engine, command, await base.send(command));
  };
  return new Proxy(base, { get: (target, property) => property === "send" ? send : Reflect.get(target, property) });
}

async function checkFormat(engine: TransactionEngine): Promise<void> {
  const marker = await engine.journal.get(FORMAT_KEY);
  if (marker?.format !== FORMAT) throw new DynamoDBAdapterError("Callback transactions require an initialized transaction storage format. Stop incompatible readers and writers, then run initializeDynamoDBTransactions before enabling transactions.");
}

async function resolveResponse(engine: TransactionEngine, command: any, response: any): Promise<any> {
  if (command instanceof GetCommand) return resolveGet(engine, command, response);
  if (command instanceof QueryCommand) return resolveQuery(engine, response);
  if (command instanceof BatchGetCommand) return resolveBatch(engine, response);
  return response;
}

async function resolveGet(engine: TransactionEngine, command: GetCommand, response: any) { return { ...response, Item: await engine.resolve(response.Item ?? null, command.input.Key as Key) ?? undefined }; }
async function resolveQuery(engine: TransactionEngine, response: any) { return { ...response, Items: await resolveItems(engine, response.Items ?? []) }; }
async function resolveBatch(engine: TransactionEngine, response: any) { return { ...response, Responses: await resolveTables(engine, response.Responses ?? {}) }; }

async function resolveItems(engine: TransactionEngine, items: Item[]): Promise<Item[]> {
  const result: Item[] = [];
  for (const item of items) {
    const value = await engine.resolve(item, keyOf(item));
    if (value) result.push(value);
  }
  return result;
}

async function resolveTables(engine: TransactionEngine, tables: Record<string, Item[]>): Promise<Record<string, Item[]>> {
  const result: Record<string, Item[]> = {};
  for (const [name, items] of Object.entries(tables)) result[name] = await resolveItems(engine, items);
  return result;
}

async function guardedWrite(base: DynamoDBDocumentClient, engine: TransactionEngine, command: TransactWriteCommand): Promise<any> {
  const actions = (command.input.TransactItems ?? []).map(guardAction);
  while (true) {
    try { return await base.send(new TransactWriteCommand({ ...command.input, ClientRequestToken: randomUUID(), TransactItems: actions })); }
    catch (error) {
      if (!isConditionalTransactionCanceled(error)) throw error;
      if (!await releaseConflicts(engine, actions)) throw error;
    }
  }
}

async function releaseConflicts(engine: TransactionEngine, actions: Action[]): Promise<boolean> {
  let found = false;
  for (const action of actions) {
    const key = actionKey(action);
    const current = await engine.journal.get(key);
    if (!intentOf(current)) continue;
    found = true;
    await engine.release(key);
  }
  return found;
}

function actionKey(action: Action): Key { return keyOf((action.Put?.Item ?? action.Update?.Key ?? action.Delete?.Key ?? action.ConditionCheck!.Key)!); }

function guardAction(action: Action): Action {
  if (action.Put) return { Put: { ...action.Put, ...intentGuard(action.Put), Item: versioned(action.Put.Item!) } };
  if (action.Delete) return { Delete: { ...action.Delete, ...intentGuard(action.Delete) } };
  if (action.Update) return { Update: versionedUpdate(action.Update) };
  return { ConditionCheck: { ...action.ConditionCheck!, ...intentGuard(action.ConditionCheck!) } };
}

function intentGuard(action: any) {
  const existing = action.ConditionExpression ? `(${action.ConditionExpression}) AND ` : "";
  return { ConditionExpression: `${existing}attribute_not_exists(#txIntent)`, ExpressionAttributeNames: { ...action.ExpressionAttributeNames, "#txIntent": INTENT }, ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const };
}

function versionedUpdate(action: NonNullable<Action["Update"]>): NonNullable<Action["Update"]> {
  return { ...action, ...intentGuard(action), UpdateExpression: addVersionSet(action.UpdateExpression!), ExpressionAttributeNames: { ...intentGuard(action).ExpressionAttributeNames, "#txVersion": PHYSICAL_VERSION }, ExpressionAttributeValues: { ...action.ExpressionAttributeValues, ":txVersion": randomUUID() } };
}

function addVersionSet(expression: string): string {
  return expression.startsWith("SET ") ? `SET #txVersion = :txVersion, ${expression.slice(4)}` : `SET #txVersion = :txVersion ${expression}`;
}
