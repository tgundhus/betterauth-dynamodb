import { randomUUID } from "node:crypto";
import { DynamoDBAdapterError } from "../errors.js";
import { REVISION_ATTRIBUTE } from "../serialize.js";
import type { Change, Intent, Item, Key } from "./types.js";

export const INTENT = "__betterAuthDynamoDBTransaction";
export const PHYSICAL_VERSION = "__betterAuthDynamoDBPhysicalRevision";
export const FORMAT = 1;
export const LEASE_MS = 30_000;
export const FORMAT_KEY = { pk: "BETTERAUTH#FORMAT", sk: "FORMAT" };

export function rootKey(id: string): Key { return { pk: dataPk(id), sk: "ROOT" }; }
export function registryKey(id: string): Key { return { pk: `BETTERAUTH#TX#${id[0]}`, sk: id }; }
export function dataPk(id: string): string { return `BETTERAUTH#TXDATA#${id}`; }
export function entryKey(id: string, index: number): Key { return { pk: dataPk(id), sk: `E#${index.toString().padStart(12, "0")}` }; }
export function blobKey(id: string, index: number, side: string, part: number): Key { return { pk: dataPk(id), sk: `B#${index}#${side}#${part}` }; }
export function keyOf(item: Item): Key { return { pk: item.pk, sk: item.sk }; }
export function keyId(key: Key): string { return JSON.stringify([key.pk, key.sk]); }
export function versioned(item: Item): Item { return { ...item, [PHYSICAL_VERSION]: randomUUID() }; }

export function intentOf(item: Item | null): Intent | undefined {
  const value = item?.[INTENT];
  if (value === undefined) return undefined;
  if (typeof value?.id !== "string" || !Number.isSafeInteger(value.entry) || value.entry < 0) throw new DynamoDBAdapterError("Invalid DynamoDB transaction intent. Restore or repair the transaction metadata before continuing.");
  return value as Intent;
}

export function placeholder(id: string, entry: number, key: Key): Item {
  return { ...key, [INTENT]: { id, entry } };
}

/** All participating writers replace this version, including writes to legacy unversioned sidecars. */
export function snapshotGuard(change: Change) {
  if (!change.before) return { ConditionExpression: "attribute_not_exists(pk)" };
  return existingGuard(change.before);
}

function existingGuard(before: Item) {
  const names = { "#physical": PHYSICAL_VERSION, "#intent": INTENT };
  const version = before[PHYSICAL_VERSION];
  if (version === undefined) return legacyGuard(before, names);
  return { ConditionExpression: "#physical = :physical AND attribute_not_exists(#intent)", ExpressionAttributeNames: names, ExpressionAttributeValues: { ":physical": version } };
}

function legacyGuard(before: Item, names: Record<string, string>) {
  const condition = "attribute_exists(pk) AND attribute_not_exists(#physical) AND attribute_not_exists(#intent)";
  const revision = before[REVISION_ATTRIBUTE];
  if (revision === undefined) return { ConditionExpression: condition, ExpressionAttributeNames: names };
  return { ConditionExpression: `${condition} AND #logical = :logical`, ExpressionAttributeNames: { ...names, "#logical": REVISION_ATTRIBUTE }, ExpressionAttributeValues: { ":logical": revision } };
}

export function ownedGuard(id: string, entry: number) {
  return { ConditionExpression: "#intent.#id = :owner AND #intent.#entry = :entry", ExpressionAttributeNames: { "#intent": INTENT, "#id": "id", "#entry": "entry" }, ExpressionAttributeValues: { ":owner": id, ":entry": entry } };
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}
