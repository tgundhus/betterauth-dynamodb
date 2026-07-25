# @bjorntech/betterauth-dynamodb

Production-oriented DynamoDB adapter for Better Auth `^1.6.23`, implemented with Better Auth's official `createAdapterFactory` API.

## Status

This repository is an initial package implementation prepared for restricted/private npm publication as `@bjorntech/betterauth-dynamodb@0.1.0`. It has unit coverage for command construction, adapter semantics, query planning, and Better Auth factory wiring, plus an explicit Docker-backed DynamoDB Local integration suite.

Pre-release storage note: in November 2025 the adapter design was corrected to remove the misleading generic `gsi1`/`idx_<field>_*` model. Scalar equality lookups now use transactionally maintained sidecar rows in the base table. In July 2026 key components changed to delimiter-safe length-prefixed strings, sidecar/unique-lock values use SHA-256 hashes, and entity rows gained hidden internal revision metadata for ABA-safe mutations. Existing experimental tables created with older formats should be recreated or migrated before using this version; pre-revision rows can still be read but fail clearly if mutated.

The package may not be published to a registry yet. Until restricted npm publication and your access are confirmed by the project owner, install it from this repository or a local workspace/path rather than assuming npm availability.

## Installation

If published in your environment and your npm account has access to the private/restricted package:

```sh
bun add @bjorntech/betterauth-dynamodb better-auth @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

For local development before publication, use the package manager workflow for a local path/workspace dependency, for example from a consuming app:

```sh
bun add ../betterauth-dynamodb
```

`better-auth` is a peer dependency. AWS SDK DynamoDB packages are runtime dependencies of this adapter.

## Basic usage

Prefer injecting a `DynamoDBDocumentClient` so your application owns AWS configuration, credentials, middleware, tracing, and marshalling behavior:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { betterAuth } from "better-auth";
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});

export const auth = betterAuth({
  database: dynamoDBAdapter({
    tableName: "better-auth",
    client: dynamo,
    ttl: { fields: { session: "expiresAt", verification: "expiresAt" } }
  }),
  emailAndPassword: { enabled: true }
});
```

For local development you may pass `region`, `endpoint`, and/or `dynamoDBClientConfig` instead of `client`. Production serverless apps should usually inject the client.

## API

```ts
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";
```

`dynamoDBAdapter(options)` accepts:

- `tableName: string` - required DynamoDB table name.
- `client?: DynamoDBDocumentClient` - preferred production integration path.
- `region?: string`, `endpoint?: string`, `dynamoDBClientConfig?: DynamoDBClientConfig` - used only when this package creates the AWS client.
- `ttl?: false | { attributeName?: string; fields?: Record<string, string>; defaultField?: string }` - derives a DynamoDB TTL epoch-seconds attribute from Better Auth date fields. When omitted or `false`, logical TTL filtering is inactive and a user/plugin field named `ttl` remains ordinary visible data.
- `unsafeAllowScan?: boolean` - defaults to `false`; must be explicitly enabled for scan-shaped query/update/delete/count operations.
- `maxPages?: number` - positive safe integer maximum DynamoDB Query/Scan pages drained for sidecar equality lookups and explicit unsafe scans; defaults to `25`. If DynamoDB still has more pages at this cap, the adapter throws rather than returning incomplete filtered/windowed results.
- `pageSize?: number` - optional positive safe integer DynamoDB `Limit` for each Query/Scan request. Pagination is still fully drained up to `maxPages`, so this controls request sizing and does not change the final logical result. It is mainly useful for testing pagination and tightly bounded local workloads; leave unset in normal production use unless you have measured the throughput/latency trade-off.
- `uniqueFields?: Record<string, string[]>` - optional manual unique-field configuration merged with Better Auth schema unique fields.

The package also exports `BetterAuthDynamoDBOptions`, `TtlOptions`, `DynamoDBAdapterError`, and `UnsupportedQueryError`.

## SST / Lambda integration

For SST v4 Lambda apps that use `Resource.*` links, keep table ownership in the app and inject a document client into the adapter:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { betterAuth } from "better-auth";
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";
import { Resource } from "sst";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});

export const auth = betterAuth({
  database: dynamoDBAdapter({
    tableName: Resource.BetterAuthTable.name,
    client: dynamo,
    ttl: { fields: { session: "expiresAt", verification: "expiresAt" } }
  }),
  emailAndPassword: { enabled: true }
});
```

Provision and link a DynamoDB table from your SST config. No GSIs are required for the current sidecar-index design:

```ts
const betterAuthTable = new sst.aws.Dynamo("BetterAuthTable", {
  fields: {
    pk: "string",
    sk: "string"
  },
  primaryIndex: { hashKey: "pk", rangeKey: "sk" },
  ttl: "ttl"
});
```

If a needed access pattern has no id or scalar equality predicate, the adapter throws unless `unsafeAllowScan: true` is set. A future optional native-GSI optimization may be added with descriptive API names, but there is no generic GSI option today.

## Table and key model

- Table primary key: `pk = MODEL#s<byteLength>:<model>`, `sk = ID#s<byteLength>:<id>`. Model, field, and id components use deterministic length prefixes so embedded delimiters such as `#` cannot collide across entity, sidecar, or unique-lock rows.
- The Better Auth-visible record is stored in `entity` and scalar fields are duplicated at top level for conditional checks and scan-opt-in filtering.
- Before writes, `undefined` values are removed from plain object records and arrays because DynamoDB has no undefined value type. Array entries containing `undefined` are omitted, which compacts arrays. Non-plain values such as `Date`, binary values, sets, and class instances are preserved unchanged; if a preserved custom instance is not marshalable by your injected AWS SDK client, normalize it to a plain supported value before passing it to Better Auth.
- Scalar equality sidecars are stored in the same table: `pk = INDEX#s<byteLength>:<model>#FIELD#s<byteLength>:<field>#VALUE#<sha256(typed-value)>`, `sk = OWNER#s<byteLength>:<id>`. The typed value encoding (before hashing) preserves distinctions such as string `"1"`, number `1`, boolean `true`, dates, and `null`, and supports arbitrary Better Auth/plugin scalar fields without one GSI per field. Owner rows are always re-read and checked against the original typed predicate, so the hash is only a bounded DynamoDB key component.
- Unique fields declared by Better Auth schema, or by `uniqueFields`, create transactional lock rows: `pk = UNIQUE#s<byteLength>:<model>#s<byteLength>:<field>`, `sk = VALUE#<sha256(typed-value)>#s0:`.
- Entity rows include a reserved top-level `__betterAuthDynamoDBRevision` UUID. It is generated on create and refreshed on each replacement/update/increment, used only for optimistic write guards, and never returned as Better Auth-visible metadata.
- DynamoDB partition keys are validated against the 2048-byte UTF-8 limit and sort keys against the 1024-byte UTF-8 limit. Long scalar field values are hashed in sidecar and unique-lock keys to avoid partition/sort key overflow; long model, field, or id components fail with an actionable error.
- TTL is derived from configured date fields into a DynamoDB TTL attribute (default `ttl`) and is not added to the Better Auth-visible `entity`. Entity, scalar sidecar, and unique-lock rows receive compatible TTL metadata when available. Reads treat configured TTL as logical expiration: an owner row at or before the current epoch second is hidden for id, sidecar, and explicit scan paths even if DynamoDB has not physically deleted it. Sidecars/locks may therefore expire with their owner; stale sidecars still cannot be returned because the owner entity must exist, be unexpired, and match the requested typed value. When `ttl` is omitted or `false`, this logical expiration path is completely disabled; use `attributeName` if you configure TTL and also need a user/plugin field named `ttl` at top level.

## Concurrency guarantees and limitations

- `create` transactionally writes the entity row, scalar equality sidecars, and configured uniqueness locks with conditional non-existence checks.
- `update`, `updateMany`, `delete`, `deleteMany`, and `consumeOne` transactionally maintain sidecars and uniqueness locks. After the adapter reads and matches a target, the write uses an optimistic condition on the hidden per-entity revision rather than trying to translate arbitrary Better Auth operators into DynamoDB transaction conditions. This rejects stale ABA-shaped writes even if record contents changed away and back between read and mutation.
- `incrementOne` is implemented as a guarded read/transactional replacement so indexed numeric fields remain correct. A concurrent change causes the guarded transaction to fail rather than silently corrupting indexes.
- Transactional writes include a fresh AWS `ClientRequestToken` per command construction. This gives AWS SDK/internal network retries of that single send a stable token, but it is not cross-invocation or application-level idempotency.
- DynamoDB `TransactWriteItems` is limited to 100 actions. The adapter de-duplicates configured unique-field lists, validates that a transaction contains at most one action per item key, and fails early with an actionable error if entity + sidecars + unique locks for a mutation would exceed that limit.
- Arbitrary Better Auth callback transactions are not truly supported by DynamoDB's API shape; the adapter reports `transaction: false` and callback-style transaction fallback is sequential.
- Queries without `id` equality or scalar equality require `unsafeAllowScan: true`; this avoids accidental full-table/model draining. `updateMany`, `deleteMany`, and `count` obey the same guard.
- Base entity gets, sidecar queries, owner gets, and explicit unsafe scans request `ConsistentRead: true`. Strongly consistent reads cost more RCUs than eventually consistent reads. DynamoDB still does not provide a whole-operation snapshot for a paginated scan, so explicit unsafe scans can observe changes between pages.
- Scalar equality queries use paginated base-table `Query` calls on the sidecar partition, then retrieve owner entity rows and apply residual `where`, sorting, offset, limit, and count in memory. Explicit unsafe scans are also paginated before in-memory filtering/windowing. Keep high-cardinality equality partitions and scan-enabled workloads bounded, and tune `maxPages` for your data shape; if the page cap is reached before `LastEvaluatedKey` clears, the adapter throws instead of returning a partial result. `pageSize` can force smaller Query/Scan pages when you intentionally want more, smaller requests.
- Joins use Better Auth's fallback behavior.
- The local integration suite uses AWS's official `amazon/dynamodb-local:2.6.1` image through Testcontainers. It proves command behavior against a real DynamoDB API surface for table keys, conditional transactions, sidecar/unique-lock persistence, logical TTL filtering, pagination tokens, and injected clients. It does not prove IAM, global tables, streams, PITR/backups, encryption, adaptive capacity, throttling behavior, CloudWatch metrics, real service TTL deletion timing, or every production transaction-conflict edge; validate those in AWS for production-critical rollouts.

## Verification, coverage, and CRAP policy

```sh
bun run verify
bun run test:integration:local
```

`bun run verify` runs typecheck, ESLint, coverage tests, CRAP check, and build. It intentionally excludes Docker integration tests so the unit/CRAP gate stays fast and deterministic. `bun run test:integration:local` starts DynamoDB Local in Docker using a random mapped port, fake credentials, in-memory shared DB mode, telemetry disabled, and a fresh isolated table per test.

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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Contributions should preserve atomic correctness, avoid hidden scans, maintain injected-client compatibility, and keep the CRAP <= 6 gate passing.

## License

MIT © 2026 BjornTech AB. See [LICENSE](./LICENSE).

The MIT license describes the code license; it does not imply public npm package access.
