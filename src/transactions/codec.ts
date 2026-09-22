import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { marshallOptions, unmarshallOptions } from "@aws-sdk/util-dynamodb";
import type { Item } from "./types.js";
import { itemSize } from "./item-size.js";
import { DynamoDBAdapterError } from "../errors.js";

/** AWS attribute-value JSON preserves sets, binary, and large numbers across process/runtime restarts. */
export class JournalCodec {
  constructor(private readonly marshal?: marshallOptions, private readonly unmarshal?: unmarshallOptions) {}

  validate(item: Item | null): number {
    if (!item) return 0;
    const size = itemSize(marshall(item, { ...this.marshal, convertTopLevelContainer: false }));
    if (size > 400 * 1024) throw new DynamoDBAdapterError("A transaction item exceeds DynamoDB's 400 KiB item-size budget, including adapter metadata. The transaction has not committed.");
    return size;
  }

  encode(item: Item | null): Uint8Array[] {
    if (item === null) return [];
    // DocumentClient mutates these options after its first request. The journal
    // always stores an unwrapped attribute map, independent of SDK middleware.
    const bytes = Buffer.from(JSON.stringify(marshall(item, { ...this.marshal, convertTopLevelContainer: false }), binaryReplacer));
    const size = 128 * 1024;
    return Array.from({ length: Math.ceil(bytes.length / size) }, (_, part) => bytes.subarray(part * size, (part + 1) * size));
  }

  decode(parts: Uint8Array[]): Item | null {
    if (parts.length === 0) return null;
    return unmarshall(JSON.parse(Buffer.concat(parts).toString("utf8"), binaryReviver), { ...this.unmarshal, convertWithoutMapWrapper: false });
  }
}

function binaryReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const original = this[key];
  if (ArrayBuffer.isView(original)) return Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString("base64");
  return value;
}

function binaryReviver(key: string, value: unknown): unknown {
  if (key === "B" && typeof value === "string") return Buffer.from(value, "base64");
  if (key === "BS" && Array.isArray(value)) return value.map((part: string) => Buffer.from(part, "base64"));
  return value;
}
