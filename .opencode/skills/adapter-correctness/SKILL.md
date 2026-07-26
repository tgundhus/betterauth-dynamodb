---
name: adapter-correctness
description: Use when changing Better Auth DynamoDB adapter runtime code in src/, especially query planning, atomic operations, entity/sidecar/unique-lock serialization, injected clients, or tests for adapter semantics.
---

# Adapter correctness workflow

Use this skill for implementation changes under `src/` or behavior-focused tests under `test/`.

## Checklist

1. Read `AGENTS.md` first and identify which invariant the change touches.
2. Map the change to the owning module:
   - `src/index.ts` for Better Auth factory wiring and exported API.
   - `src/dynamodb-adapter.ts` for operation semantics and DynamoDB commands.
   - `src/where.ts` for access planning and scan guards.
   - `src/serialize.ts` and `src/keys.ts` for storage shape, delimiter-safe key components, and hidden entity revision metadata.
   - `src/client.ts` for injected-client and AWS SDK compatibility.
3. Preserve atomic command behavior for uniqueness, `consumeOne`, and `incrementOne`; stale-write guards must use the hidden per-entity revision rather than full entity equality.
4. Preserve the no-hidden-scan rule. If a query shape cannot use id equality or scalar field equality, it must throw unless `unsafeAllowScan: true` is explicit.
5. Add or update focused unit tests that assert command type, condition expressions, key/index names, returned Better Auth-visible entities, and race handling where relevant.
6. Run `bun run verify` from the repository root. Fix typecheck, lint, coverage, CRAP, and build failures rather than weakening gates.

## Documentation prompts

Update `README.md` when the change affects options, table provisioning, storage layout, concurrency guarantees, limitations, or generic SST/Lambda/serverless usage. Update `AGENTS.md` if an invariant changes.
