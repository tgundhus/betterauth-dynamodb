import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/** AWS's documented item-size accounting, with a conservative bound for variable-length numbers. */
export function itemSize(item: Record<string, AttributeValue>): number {
  return Object.entries(item).reduce((total, [name, value]) => total + bytes(name) + valueSize(value), 0);
}

function valueSize(value: AttributeValue): number {
  const [type, data] = Object.entries(value)[0]!;
  return sizes[type]!(data);
}

// A DynamoDB number has at most 38 significant digits. AWS documents its
// representation approximately, so reserve the maximum rather than undercount.
const sizes: Record<string, (value: any) => number> = {
  S: bytes,
  N: () => 21,
  B: (value: Uint8Array) => value.byteLength,
  BOOL: () => 1,
  NULL: () => 1,
  SS: (value: string[]) => value.reduce((sum, part) => sum + bytes(part), 0),
  NS: (value: string[]) => value.length * 21,
  BS: (value: Uint8Array[]) => value.reduce((sum, part) => sum + part.byteLength, 0),
  L: (value: AttributeValue[]) => 3 + value.reduce((sum, part) => sum + 1 + valueSize(part), 0),
  M: (value: Record<string, AttributeValue>) => 3 + Object.keys(value).length + itemSize(value)
};
