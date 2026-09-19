import { describe, expect, it } from "vitest";
import { collectSchemaUniqueIndexes } from "../src/index.js";

const model = (name: string) => name === "user" ? "app_user" : name;
const field = ({ field }: { model: string; field: string }) => field === "email" ? "email_address" : field;

describe("Better Auth schema unique indexes", () => {
  it("validates and remaps unique index definitions, ignoring non-unique indexes and tables without indexes", () => {
    const indexes = collectSchemaUniqueIndexes({
      user: { fields: { email: { type: "string", required: true }, provider: { type: "string", required: true } }, indexes: [{ fields: ["email", "provider"], unique: true }, { fields: ["provider"] }] },
      account: { fields: { provider: { type: "string", required: true }, role: { type: ["admin", "user"], required: true } }, indexes: [{ name: "provider_key", fields: ["provider", "role"], unique: true }] },
      session: { fields: { token: { type: "string", required: true } } }
    } as never, model, field);
    expect(indexes).toEqual([
      { model: "app_user", name: "s13:email_address#s8:provider", fields: ["email_address", "provider"] },
      { model: "account", name: "provider_key", fields: ["provider", "role"] }
    ]);
  });

  it("derives stable delimiter-safe names for unnamed indexes and preserves explicit names", () => {
    const collect = (indexes: unknown) => collectSchemaUniqueIndexes({ user: { fields: { email: { type: "string", required: true }, provider: { type: "string", required: true }, tenant: { type: "string", required: true } }, indexes } } as never, model, field);
    const first = collect([{ fields: ["email", "provider"], unique: true }, { fields: ["tenant"], unique: true }]);
    const reordered = collect([{ fields: ["tenant"], unique: true }, { fields: ["email", "provider"], unique: true }]);
    expect(first[0]!.name).toBe(reordered[1]!.name);
    expect(first[0]!.name).not.toBe(first[1]!.name);
    expect(collect([{ name: "stable_custom", fields: ["email", "provider"], unique: true }])[0]!.name).toBe("stable_custom");
  });

  it.each<any>([
    [{ value: { type: "string", required: false } }, /optional or unknown/],
    [{ value: { type: "json", required: true } }, /non-scalar/],
    [{ value: { type: "string[]", required: true } }, /non-scalar/],
    [{ value: { type: "string", required: true }, fields: Array.from({ length: 17 }, (_, i) => `f${i}`) }, /1-16/]
  ])("rejects invalid unique components", ({ value, fields }: { value: { type: string; required: boolean }; fields?: string[] }, expected: RegExp) => {
    const names = fields ?? ["value"];
    const fieldsMap = Object.fromEntries(names.map((name) => [name, name === "value" ? value : { type: "string", required: true }]));
    expect(() => collectSchemaUniqueIndexes({ user: { fields: fieldsMap, indexes: [{ fields: names, unique: true }] } } as never, model, field)).toThrow(expected);
  });

  it("rejects duplicate fields in a unique index", () => {
    expect(() => collectSchemaUniqueIndexes({ user: { fields: { email: { type: "string", required: true } }, indexes: [{ fields: ["email", "email"], unique: true }] } } as never, model, field)).toThrow(/same field more than once/);
  });
});
