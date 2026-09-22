# Better Auth DynamoDB

A DynamoDB adapter for Better Auth, with transactional uniqueness, guarded concurrent writes, and explicit control over read costs.

This branch contains the unpublished **2.0 transaction preview**. It implements callback transactions backed entirely by DynamoDB, with durable commit decisions, rollback, and recovery across native transaction batches. Published SCIM and advanced SSO workflows pass the integration tests. Larger groups and `/Bulk` also require the companion SCIM source changes described in [enterprise compatibility](./docs/enterprise-transactions.md). Production load, recovery, and migration validation remain release gates. See [transaction storage and migration](./docs/transaction-storage.md).

This project is an independently maintained continuation of [BjornTech's Better Auth DynamoDB adapter](https://github.com/bjorntech/betterauth-dynamodb), based on their `v1.1.0` release. Development of this continuation takes place in [tgundhus/betterauth-dynamodb](https://github.com/tgundhus/betterauth-dynamodb).

BjornTech built the original adapter and its correctness guarantees. Our stable 1.2 continuation adds performance improvements and stability fixes while preserving its API and storage contract. The separate 2.0 preview introduces an opt-in transaction protocol that requires a coordinated migration.

## What this continuation adds

Version `1.2.0` focuses on reducing unnecessary DynamoDB requests and handling read edge cases reliably:

- Model-partition queries replace table scans for explicitly enabled fallback reads.
- Batched reads load records for `id IN` queries and indexed lookups, with stable ordering and retries for unprocessed keys.
- Bounded concurrency speeds up independent scalar-field `IN` queries.
- Unsorted, limited equality and model queries stop reading pages once enough live, matching records are available.
- Strongly consistent reads remain the default, with an explicit option for eventual consistency.
- Query planning and TTL fixes cover case-insensitive ID filters, ordinary fields named `ttl`, and records that expire during pagination.

The 2.0 preview adds `transactions: true`, storage initialization, and a recovery API. A [scheduled Lambda worker](./examples/aws-lambda/README.md) checkpoints bounded recovery across invocations. It uses Better Auth's official `createAdapterFactory` API and requires Better Auth `^1.7.5`. Unit tests, DynamoDB Local integration tests, and Better Auth's adapter conformance suites cover the implementation. See the [changelog](./CHANGELOG.md) for release details.

String sorting in the preview uses ordinal JavaScript string comparisons, consistent with its range filters. This fixes skipped records in cursor pagination over mixed-case IDs. Applications that depended on locale-aware ordering should apply their presentation collation separately.

Callback queries journal returned records and mutation targets after filtering and pagination, avoiding dependencies on discarded candidates. Point-read absence remains protected. Query predicates do not acquire serializable range locks; see [transaction isolation](./docs/transaction-storage.md#commit-and-recovery).

## Installation

This continuation is currently distributed from this repository. The package still uses the name `@bjorntech/betterauth-dynamodb` for compatibility, so installing that name from npm retrieves BjornTech's published package rather than this continuation.

To use this version, build and package the source with Bun and npm installed:

```sh
git clone https://github.com/tgundhus/betterauth-dynamodb.git
cd betterauth-dynamodb
git checkout feat/enterprise-transactions
bun install --frozen-lockfile
bun run build
npm pack --ignore-scripts
```

This produces `bjorntech-betterauth-dynamodb-2.0.0-alpha.0.tgz`. From your application directory, install the generated archive and Better Auth, replacing the archive path with its actual location:

```sh
npm install /path/to/bjorntech-betterauth-dynamodb-2.0.0-alpha.0.tgz better-auth@1.7.5
```

The import path remains `@bjorntech/betterauth-dynamodb`. AWS SDK DynamoDB packages are runtime dependencies of the adapter. For reproducible deployments, build from a pinned commit and retain the generated archive.

## Basic usage

Prefer injecting a `DynamoDBDocumentClient` so your application owns AWS configuration, credentials, middleware, tracing, and marshalling behavior:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { betterAuth } from "better-auth";
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const auth = betterAuth({
  database: dynamoDBAdapter({
    tableName: "better-auth",
    client: dynamo,
    ttl: { fields: { session: "expiresAt", verification: "expiresAt" } },
  }),
  verification: { disableCleanup: true },
  emailAndPassword: { enabled: true },
});
```

When the `verification` model uses adapter-managed TTL, disable Better Auth's verification cleanup as shown above. Otherwise Better Auth can issue a range-only `deleteMany` such as `expiresAt < now`, which this adapter rejects by default because it would require a hidden table/model scan.

For local development you may pass `region`, `endpoint`, and/or `dynamoDBClientConfig` instead of `client`. Production deployments should usually inject the client.

See [examples](./examples/) for standalone deployment examples that use local path dependencies.

## Upgrading from BjornTech 1.1.0

Version `1.2.0` requires no storage migration from upstream `1.1.0`. Entity keys, scalar indexes, uniqueness locks, revision metadata, and TTL formats stay compatible.

Before deploying, add `dynamodb:BatchGetItem` to the application role for the adapter table. Existing `GetItem` permission does not cover batch reads. Opt-in model fallbacks use `Query` instead of `Scan`, so make sure the role permits `Query` too.

Read consistency remains strong by default. Set `consistentRead: false` only when your application can accept delayed visibility of writes.

For the earlier `1.0.1` to `1.1.0` upgrade, no migration is needed while `enforceSchemaUniqueIndexes` stays at its default `false`. Enabling schema unique constraints on existing records requires stopping writes, auditing and repairing duplicates, and backfilling locks before compatible writers restart. New empty models need no backfill. No migration utility is supplied.

Experimental tables using older generic `gsi1`/`idx_<field>_*`, pre-length-prefixed, pre-hash, or pre-revision formats need to be recreated or migrated. Pre-revision rows remain readable but fail clearly if mutated.

## API

```ts
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";
```

`dynamoDBAdapter(options)` accepts:

- `tableName: string` - required DynamoDB table name.
- `transactions?: boolean` - 2.0 preview; enables callback transactions only after explicit storage initialization. Requires compatible readers and writers, strongly consistent reads, and a recovery worker. Defaults to `false`. See [transaction storage](./docs/transaction-storage.md) before enabling it on existing data.
- `client?: DynamoDBDocumentClient` - preferred production integration path.
- `region?: string`, `endpoint?: string`, `dynamoDBClientConfig?: DynamoDBClientConfig` - used only when this package creates the AWS client.
- `ttl?: false | { attributeName?: string; fields?: Record<string, string>; defaultField?: string }` - derives a DynamoDB TTL epoch-seconds attribute from Better Auth date fields. When omitted or `false`, logical TTL filtering is inactive and a user/plugin field named `ttl` remains ordinary visible data.
- `consistentRead?: boolean` - defaults to `true`; set to `false` only when lower read cost is more important than immediate read-after-write visibility. The setting applies uniformly to entity gets, sidecar/model queries, and owner batch gets. Transaction mode always forces strong reads.
- `unsafeAllowScan?: boolean` - defaults to `false`; must be explicitly enabled for scan-shaped query/update/delete/count operations. Despite the compatibility-oriented option name, these fallbacks now issue a keyed `Query` against the model partition rather than a table-wide DynamoDB `Scan`.
- `maxPages?: number` - positive safe integer maximum DynamoDB Query pages drained for sidecar equality lookups and explicit model-partition fallbacks; defaults to `25` without transaction mode. Transaction mode removes that default cap; an explicit value still applies. The adapter throws at this cap if more pages are needed to complete the result. Unsorted limited equality/model reads can finish earlier once enough live, matching rows satisfy offset and limit.
- `pageSize?: number` - optional positive safe integer DynamoDB `Limit` for each Query request. This controls request sizing and does not change the final logical result. Unsorted limited equality/model reads stop after enough matches; sorted reads, counts, mutations, and `IN` reads still drain their candidates up to `maxPages`. It is mainly useful for testing pagination and tightly bounded local workloads; leave unset in normal production use unless you have measured the throughput/latency trade-off.
- `uniqueFields?: Record<string, string[]>` - optional manual unique-field configuration merged with Better Auth schema unique fields. Keys and fields must use the exact DynamoDB/storage names the adapter receives after Better Auth `modelName`/`fieldName` mapping (for example `{ app_user: ["email_address"] }`, not `{ user: ["email"] }`, when those mappings are configured). Each listed field is an independent single-field unique constraint; composite uniqueness is not supported by this option.
- `enforceSchemaUniqueIndexes?: boolean` - opt-in enforcement of unique Better Auth schema `indexes`; defaults to `false`. Unique index fields follow Better Auth's own rules: 1–16 distinct required fields, excluding `json`, `string[]`, and `number[]` types (enum-literal string types are allowed). Existing rows are not backfilled automatically and pre-existing records receive no retroactive locks; activate only after an application-owned duplicate audit and compatible lock backfill.
- `maxBulkConcurrency?: number` - positive safe integer concurrency cap for independent `updateMany`/`deleteMany` transactions, scalar-field `IN` queries, and chunked `BatchGet` reads; defaults to `8`. Outside a callback transaction, a mutation failure can follow successful mutations, so bulk writes are not aggregate-atomic and must not be blindly retried.

The schema-index option consumes Better Auth's actual table-level `indexes` array (`DBTableIndex[]`) and only acts on entries with `unique: true`; it does not add an alternative schema-definition option. On a new empty table it can be enabled directly. For a populated table, use a maintenance window with writes stopped: audit duplicates, repair them, and complete an application-owned lock backfill before restarting all writers with compatible code and enforcement enabled. This package provides no migration or backfill utility; do not enable it on unbackfilled rows or allow old/incompatible writers to continue. The `UNIQUE2` namespace is stable only while the index name (explicit or derived), ordered field list, and model/field mapping remain unchanged; changing any of those requires backfilling the new namespace, and pre-existing records do not acquire locks automatically. Rollback requires an explicit plan for versioned locks and writers that may have observed the constraint; disabling the option alone does not undo backfill or repair duplicates.

The package also exports `BetterAuthDynamoDBOptions`, `TtlOptions`, `DynamoDBAdapterError`, `DynamoDBConflictError`, and `UnsupportedQueryError`.

## Deployment notes

Keep table ownership in your application infrastructure and inject a `DynamoDBDocumentClient` into the adapter. Provision a DynamoDB table with `pk` as the partition key, `sk` as the sort key, and DynamoDB TTL enabled on the adapter TTL attribute when you configure adapter-managed TTL. No GSIs are required for the current sidecar-index design.

For email OTP sign-in or other flows where verification rows expire through DynamoDB TTL, keep `verification.disableCleanup: true` in the Better Auth config. Without it, Better Auth attempts to clean verification rows with a range-only `deleteMany(expiresAt < now)`, and the adapter rejects that no-key access pattern under its no-hidden-scan policy.

Better Auth database-backed rate limiting has the same DynamoDB trade-off. The rate-limit `key` field is schema-unique and works well for exact-key increments, but Better Auth cleanup can require range-only predicates such as old `lastRequest` values. Leave `unsafeAllowScan` disabled for production unless you have a tightly bounded table and have accepted the cost/consistency profile. Prefer Better Auth's non-database/in-memory limiter for single-instance local development, an edge/API-gateway/WAF limiter, or an application-owned DynamoDB rate-limit table with access patterns designed for your cleanup needs.

A query needs a supported keyed predicate: case-sensitive equality or scalar `IN` on an ID or indexed field. Without one, the adapter throws unless `unsafeAllowScan: true` is set. `OR` predicates always require that opt-in because they can match rows outside a single keyed branch. Case-insensitive equality and `IN` can use a separate safe keyed predicate as an anchor, then run as residual filters; without that anchor, they also require the fallback opt-in. The fallback reads the model partition with `Query` and evaluates the expression in memory. No native GSI is required or configured.

## Table and key model

- Table primary key: `pk = MODEL#s<byteLength>:<model>`, `sk = ID#s<byteLength>:<id>`. Model, field, and id components use deterministic length prefixes so embedded delimiters such as `#` cannot collide across entity, sidecar, or unique-lock rows.
- The Better Auth-visible record is stored in `entity` and scalar fields are duplicated at top level for conditional checks and fallback model-query filtering.
- Before writes, `undefined` values are removed from plain object records and arrays because DynamoDB has no undefined value type. Array entries containing `undefined` are omitted, which compacts arrays. Non-plain values such as `Date`, binary values, sets, and class instances are preserved unchanged; if a preserved custom instance is not marshalable by your injected AWS SDK client, normalize it to a plain supported value before passing it to Better Auth.
- Scalar equality sidecars are stored in the same table: `pk = INDEX#s<byteLength>:<model>#FIELD#s<byteLength>:<field>#VALUE#<sha256(typed-value)>`, `sk = OWNER#s<byteLength>:<id>`. The typed value encoding (before hashing) preserves distinctions such as string `"1"`, number `1`, boolean `true`, dates, and `null`, and supports arbitrary Better Auth/plugin scalar fields without one GSI per field. Owner rows are always re-read and checked against the original typed predicate, so the hash is only a bounded DynamoDB key component.
- Unique fields declared by Better Auth schema, or by `uniqueFields`, create transactional lock rows: `pk = UNIQUE#s<byteLength>:<model>#s<byteLength>:<field>`, `sk = VALUE#<sha256(typed-value)>#s0:`.
- When `enforceSchemaUniqueIndexes` is enabled, each unique Better Auth schema index adds a `UNIQUE2` compound lock row (a storage-format addition; existing entity, scalar-sidecar, and single-field unique-lock rows are unchanged): `pk = UNIQUE2#s<byteLength>:<model>#s<byteLength>:<index-namespace>`, `sk = TUPLE#<sha256(type-prefixed tuple)>`. Components use delimiter-safe length prefixes, and tuple values are type-prefixed before hashing. An explicit index `name` is the namespace. Without one, the namespace is the ordered, model-remapped field list encoded as `s<UTF-8 byte length>:<field>` components joined by `#`, then length-prefixed again by `compoundUniquePk`; declared field order is preserved. For example, fields `email`, `tenantId` and values `"alice@example.com"`, `"acme"` produce `pk = UNIQUE2#s4:user#s20:s5:email#s8:tenantId` and `sk = TUPLE#7a2e1d8fc9815968b003de5dfc1ce4e013de254c811f4566bfaef8dc444963fa`. A `null` or `undefined` tuple component skips the lock; an empty string is a real value. Renaming an index or changing its field list or order changes its namespace, so existing locks must be re-backfilled; pre-existing records receive no retroactive locks.
- Do not bypass this adapter with direct DynamoDB writes for Better Auth records. Entity rows, scalar sidecars, unique locks, TTL attributes, and hidden revision metadata must be created, replaced, and deleted together; out-of-band writes can break uniqueness, query results, logical expiration, or optimistic mutation guards.
- Entity rows include a reserved top-level `__betterAuthDynamoDBRevision` UUID. It is generated on create and refreshed on each replacement/update/increment, used only for optimistic write guards, and never returned as Better Auth-visible metadata.
- DynamoDB partition keys are validated against the 2048-byte UTF-8 limit and sort keys against the 1024-byte UTF-8 limit. Long scalar field values are hashed in sidecar and unique-lock keys to avoid partition/sort key overflow; long model, field, or id components fail with an actionable error.
- TTL is derived from configured date fields into a DynamoDB TTL attribute (default `ttl`) and is not added to the Better Auth-visible `entity`. Entity, scalar sidecar, and unique-lock rows receive compatible TTL metadata when available. Reads treat configured TTL as logical expiration: an owner row at or before the current epoch second is hidden for id, sidecar, and explicit model-query paths even if DynamoDB has not physically deleted it. Sidecars/locks may therefore expire with their owner; stale sidecars still cannot be returned because the owner entity must exist, be unexpired, and match the requested typed value. When `ttl` is omitted or `false`, this logical expiration path is completely disabled; use `attributeName` if you configure TTL and also need a user/plugin field named `ttl` at top level.
- Expired compound locks are logically ignored for reads, but reuse can still wait for DynamoDB's physical TTL deletion. Do not treat logical expiration as immediate physical lock removal.

## Concurrency guarantees and limitations

### SCIM and advanced SSO compatibility

The stable 1.2 adapter is incompatible with SCIM, SSO `resolveUser`, and SSO `guardProviderMutation` because it does not implement callback transactions. The 2.0 preview supplies that transaction capability when explicitly initialized and enabled. Validation uses the published `@better-auth/scim` and `@better-auth/sso` packages at `1.7.5`.

| Feature | Validation in the 2.0 preview |
| --- | --- |
| SCIM provisioning | HTTP lifecycle, group membership, transactional role projection, rollback, and deletion pass against DynamoDB Local. |
| SSO `resolveUser` | OIDC sign-in links a SCIM identity; a rejected resolver rolls back its writes; deactivation revokes the session and blocks sign-in. |
| SSO `guardProviderMutation` | Rejected updates/deletes roll back guard writes; accepted mutations commit. |
| Groups above 1,000 members and `/Bulk` | With the companion SCIM changes, 1,051 Bulk-created users and a 1,051-member group pass the DynamoDB Local lifecycle test, including role projection. These features are absent from the published 1.7.5 plugin. See the enterprise validation notes. |
| Asynchronous provisioning on Lambda | The companion SCIM fork adds opt-in durable Bulk jobs, idempotent submission, connection-scoped polling, a scheduled-worker API, and bounded cleanup. Standard SCIM requests retain their synchronous responses. See the [job guide](https://github.com/tgundhus/better-auth/blob/feat/large-groups-and-bulk/docs/content/docs/plugins/scim/bulk-jobs.mdx). |
| Complete production compatibility | Still requires the documented load, concurrent authentication, recovery, and migration release gates. |

The preview stages callback writes, prepares durable versions in batches, and publishes them through one conditional commit decision. All participating readers and writers understand that decision. See the [SCIM transaction requirements](https://better-auth.com/docs/plugins/scim#enable-database-transactions), [SSO user resolution requirements](https://better-auth.com/docs/plugins/sso#resolve-sso-users), and [storage protocol](./docs/transaction-storage.md).

Callback transactions have no fixed total item-count cap. The adapter handles native request limits internally. This adds storage and request costs and requires an application-owned recovery worker. Individual DynamoDB item limits, deployment deadlines, and advertised SCIM HTTP limits still apply. A Bulk envelope commits each resource operation independently, as required by its protocol.

### Current guarantees

The native operation behavior below applies outside callback transactions. Inside a callback, mutations are staged and commit together through the preview protocol; native increment and consume behavior is implemented through guarded staged records. Transaction mode also removes the default 1,000-value IN cap.

- `create` transactionally writes the entity row, scalar equality sidecars, and configured uniqueness locks with conditional non-existence checks.
- `update`, `updateMany`, `delete`, and `deleteMany` transactionally maintain sidecars and uniqueness locks. After the adapter reads and matches a target, the write uses an optimistic condition on the hidden per-entity revision rather than trying to translate arbitrary Better Auth operators into DynamoDB transaction conditions. This rejects stale ABA-shaped writes even if record contents changed away and back between read and mutation.
- `consumeOne` transactionally deletes the matched entity, sidecars, and uniqueness locks with the same revision guard. Exactly one concurrent caller can consume a row; normal stale/lost consume races resolve to `null` as Better Auth expects, while non-conditional AWS failures still throw.
- `incrementOne` uses a DynamoDB transactional `Update` with native numeric `ADD` for numeric/missing counter attributes plus the same revision guard, while maintaining scalar sidecars and uniqueness locks in the same `TransactWriteItems` request. Signed and zero finite deltas are supported; existing non-number counter values follow Better Auth's fallback semantics and are treated as zero with a guarded `SET` instead of invalid DynamoDB `ADD`. The returned row is the updated Better Auth-visible entity computed from the guarded snapshot; if the target guard no longer matches, the operation returns `null`. Unique-lock conflicts or non-conditional AWS failures still throw.
- Transactional writes include a fresh AWS `ClientRequestToken` per command construction. This gives AWS SDK/internal network retries of that single send a stable token, but it is not cross-invocation or application-level idempotency.
- DynamoDB `TransactWriteItems` is limited to 100 actions. The adapter de-duplicates configured unique-field lists, validates that a transaction contains at most one action per item key, rejects serialized transaction requests over approximately 4 MB, and fails early with an actionable error if entity + sidecars + unique locks for a mutation would exceed either limit.
- Without the 2.0 preview's explicit `transactions: true` option and storage initialization, the adapter reports `transaction: false`. Native DynamoDB `TransactWriteItems` is single-shot and is used internally for single-record atomic operations. The preview implements callbacks using its separate durable transaction protocol.
- Queries without a supported keyed equality or scalar `IN` predicate require `unsafeAllowScan: true`; this avoids accidental model-partition draining. Queries containing `OR` predicates, or case-insensitive equality/`IN` without a separate safe keyed predicate, also require the explicit fallback opt-in. `updateMany`, `deleteMany`, and `count` obey the same guard.
- Base entity gets, sidecar/model queries, and owner batch gets request `ConsistentRead: true` by default. Setting `consistentRead: false` lowers read cost but may briefly miss a newly written entity or sidecar, or observe an owner version that does not match its sidecar; owner predicates are still verified, so inconsistent pairs are omitted rather than returned incorrectly. Use the default for authentication-critical read-after-write paths. DynamoDB does not provide a whole-operation snapshot even with strong reads, so paginated queries can observe changes between pages.
- Scalar equality queries use paginated base-table `Query` calls on the sidecar partition, then retrieve owner entity rows in `BatchGet` requests of at most 100 keys using the configured consistency and apply residual `where`, sorting, offset, limit, and count in memory. Unprocessed batch keys are retried with jittered exponential backoff. The adapter fails after eight consecutive responses make no progress; size-limited responses that reduce the pending key set reset that budget. Explicit unsafe fallbacks query only the relevant model partition. For unsorted `findOne`/`findMany` equality and model queries, each page is checked for logical TTL and all residual predicates before counting toward offset plus limit; pagination stops once that window is complete. Sorted reads, counts, mutation target reads, and `IN` reads still load complete candidate sets. Keep high-cardinality equality partitions and fallback-enabled workloads bounded, and tune `maxPages` for your data shape; if the page cap is reached while more rows are needed, the adapter throws instead of returning a partial result. `pageSize` can force smaller Query pages when you intentionally want more, smaller requests.
- Scalar `IN` predicates on `id` use `BatchGet` requests of at most 100 keys with the configured consistency. Scalar-field `IN` uses one sidecar `Query` per distinct candidate value with concurrency bounded by `maxBulkConcurrency`, after which owner rows are batch-loaded. Empty lists are no-ops; duplicate values are removed; with transaction mode disabled, more than 1,000 distinct values are rejected before reads. Concurrent sidecar queries share one global `maxPages` budget, and exceeding it fails the complete operation rather than returning partial results. Residual filters run before global sorting, offset, and limit windowing. Case-insensitive `IN` cannot use exact-case indexes as a complete access path: it requires an independent safe equality anchor or explicit `unsafeAllowScan: true`; with an anchor it is evaluated as a residual predicate. Case-insensitive `IN`/`not_in` comparisons normalize array members.
- `updateMany` and `deleteMany` use bounded concurrency (controlled by `maxBulkConcurrency`, default `8`) and one revision-protected transaction per matched record. On failure they stop claiming new records and wait for started workers; earlier commits are not rolled back. They return numeric affected counts and are not aggregate-atomic or safe for blind retries. Each transaction has a 100-action and approximate JSON/practical byte-size preflight; AWS remains the ultimate size authority.
- Joins use Better Auth's fallback behavior by default: Better Auth performs separate `findOne`/`findMany` calls, which remain subject to this adapter's no-hidden-scan policy. Better Auth's native-join path (`advanced.database.joins` on 1.7.x, `experimental.joins` on 1.6.x) is not supported because DynamoDB cannot honestly join arbitrary Better Auth models without explicit access-pattern design; if enabled and Better Auth passes a native join to the adapter, the adapter throws `UnsupportedQueryError` with instructions to disable the option.
- The local integration suite uses AWS's official `amazon/dynamodb-local:2.6.1` image through Testcontainers. It proves command behavior against a real DynamoDB API surface for table keys, conditional transactions, sidecar/unique-lock persistence, logical TTL filtering, pagination tokens, and injected clients. The separate `test/integration/betterauth-conformance.test.ts` also runs Better Auth's adapter conformance suites and enables `unsafeAllowScan` because the canonical suites intentionally exercise scan-shaped predicates; production defaults still reject those shapes unless explicitly opted in. These tests do not prove IAM, global tables, streams, PITR/backups, encryption, adaptive capacity, throttling behavior, CloudWatch metrics, real service TTL deletion timing, or every production transaction-conflict edge; validate those in AWS for production-critical rollouts.

## Verification, coverage, and CRAP policy

```sh
bun run verify
bun run test:integration:local
```

`bun run verify` runs typecheck, ESLint, coverage tests, CRAP check, and build. The preview is tested against Better Auth 1.7.5 and requires Better Auth `^1.7.5` as a peer dependency. `bun run test:integration:local` starts DynamoDB Local in Docker using a random mapped port, fake credentials, in-memory shared DB mode, telemetry disabled, and isolated tables for the local integration and separate adapter conformance suites.

Provider coverage uses the published `@better-auth/oauth-provider` 1.7.5 plugin schema and direct query-shape tests, plus ordinary Better Auth HTTP authentication flows. It does not include the provider's full OAuth endpoint surface.

Coverage thresholds are enforced for production `src` code (excluding pure types). CRAP is computed per production function as:

```txt
CRAP = complexity^2 * (1 - lineCoverage)^3 + complexity
```

The verification command fails if any implementation function has CRAP `> 6`. Do not lower coverage thresholds or exclude production implementation files to bypass this gate.

## Scripts

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run test:coverage`
- `bun run test:integration:local`
- `bun run quality:crap`
- `bun run build`
- `bun run smoke:dist-import`
- `bun run verify`
- `bun run verify:integration`

## Contributing to this continuation

Open pull requests against [this repository](https://github.com/tgundhus/betterauth-dynamodb/pulls). We favor small, tested improvements that preserve atomic correctness, avoid hidden scans, and keep client injection and stored data compatible. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow and quality gates.

## License

Released under the [MIT license](./LICENSE). The original adapter is copyright © 2026 BjornTech AB. This continuation retains the original license and attribution.
