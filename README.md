# Better Auth DynamoDB

A production-oriented DynamoDB adapter for [Better Auth](https://www.better-auth.com/).

This project is an independently maintained continuation of [BjornTech's Better Auth DynamoDB adapter](https://github.com/bjorntech/betterauth-dynamodb), based on its `v1.1.0` release. BjornTech created the original adapter and its core correctness guarantees. This continuation adds performance, stability, and enterprise transaction work while preserving attribution and the MIT license.

## Project status

| Version                   | Status  | Purpose                                                                                                                    |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `1.2` on `release/1.2`    | Stable  | Backwards-compatible performance and stability improvements over BjornTech `1.1`. No storage migration is required.        |
| `2.0.0-alpha.0` on `main` | Preview | DynamoDB-backed callback transactions for SCIM and advanced SSO. A coordinated migration and recovery worker are required. |

The transaction preview has extensive unit and DynamoDB Local coverage. AWS load, recovery, migration, and rollback rehearsals remain release requirements before production adoption.

## How this differs from BjornTech's version

| Area                          | BjornTech `1.1`                                                | This continuation                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage and API               | Original entity, sidecar, unique-lock, TTL, and revision model | The stable `1.2` release preserves the `1.1` API and storage format                                                                                         |
| ID and indexed reads          | Individual owner reads                                         | `BatchGetItem` in chunks of 100, including retries for unprocessed keys                                                                                     |
| Fallback reads                | Opt-in table scans                                             | Opt-in `Query` limited to the requested model partition                                                                                                     |
| `IN` queries                  | Serial scalar-field queries                                    | Bounded concurrent queries with one shared page budget                                                                                                      |
| Limited reads                 | May drain every matching page                                  | Unsorted reads stop after finding enough live matching records                                                                                              |
| Read consistency              | Strong reads                                                   | Strong reads by default, with an explicit eventual-consistency option                                                                                       |
| Stability fixes               | `1.1` behavior                                                 | Fixes for expiring rows during pagination, case-insensitive ID filters, ordinary fields named `ttl`, and stalled batch retries                              |
| Callback transactions         | Not supported                                                  | Opt-in durable callback transaction protocol in the `2.0` preview                                                                                           |
| SCIM and advanced SSO         | Transaction-dependent paths are incompatible                   | Supported by the preview after storage initialization and coordinated migration                                                                             |
| Large SCIM groups and `/Bulk` | Not supported by the published SCIM plugin                     | Supported with the companion [SCIM fork](https://github.com/tgundhus/better-auth/tree/feat/large-groups-and-bulk), including durable asynchronous Bulk jobs |
| Recovery                      | Native single-record DynamoDB transactions only                | Scheduled recovery worker for prepared and interrupted callback transactions                                                                                |

See the [changelog](./CHANGELOG.md) for the complete release history.

## Installation

This continuation is not published to npm yet. The package retains the `@bjorntech/betterauth-dynamodb` name for source compatibility, so installing that name from npm currently installs BjornTech's package.

Build a reproducible archive from a pinned commit:

```sh
git clone https://github.com/tgundhus/betterauth-dynamodb.git
cd betterauth-dynamodb
git checkout main
bun install --frozen-lockfile
bun run build
npm pack --ignore-scripts
```

Install the generated archive with Better Auth:

```sh
npm install /path/to/bjorntech-betterauth-dynamodb-2.0.0-alpha.0.tgz better-auth@1.7.5
```

Record the checked-out commit and retain the archive with your deployment artifacts so every environment uses the same build.

## Basic usage

Inject a `DynamoDBDocumentClient` so your application owns AWS credentials, middleware, tracing, and marshalling behavior:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { betterAuth } from "better-auth";
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const auth = betterAuth({
  database: dynamoDBAdapter({
    tableName: "better-auth",
    client,
    ttl: {
      fields: {
        session: "expiresAt",
        verification: "expiresAt",
      },
    },
  }),
  verification: { disableCleanup: true },
  emailAndPassword: { enabled: true },
});
```

When the adapter manages verification TTL, keep `verification.disableCleanup: true`. Better Auth's cleanup query uses only an expiry range and has no safe keyed DynamoDB access path.

See the standalone [deployment examples](./examples/) for AWS Lambda, Alchemy, and SST configurations.

## Configuration

| Option                                       | Description                                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tableName`                                  | Required DynamoDB table name.                                                                                                                         |
| `client`                                     | Preferred production integration. Accepts an injected `DynamoDBDocumentClient`.                                                                       |
| `region`, `endpoint`, `dynamoDBClientConfig` | Used when the adapter creates the AWS client, mainly for local development.                                                                           |
| `ttl`                                        | Maps Better Auth date fields to a DynamoDB TTL attribute. Omit it to disable adapter-managed logical expiry.                                          |
| `consistentRead`                             | Defaults to `true`. Set to `false` only when delayed write visibility is acceptable.                                                                  |
| `unsafeAllowScan`                            | Enables otherwise rejected fallback query shapes. The compatibility-oriented name is retained, but the fallback now queries only the model partition. |
| `maxPages`                                   | Limits pages read by indexed and fallback queries. The adapter throws instead of returning partial data at the limit.                                 |
| `pageSize`                                   | Sets the DynamoDB page size. Leave unset unless measurements justify changing it.                                                                     |
| `maxBulkConcurrency`                         | Bounds independent bulk mutations, `IN` queries, batch reads, and supported transaction projection work. Defaults to `8`.                             |
| `uniqueFields`                               | Adds explicit single-field uniqueness rules using DynamoDB lock rows.                                                                                 |
| `enforceSchemaUniqueIndexes`                 | Enforces Better Auth compound unique indexes. Existing data requires a duplicate audit and lock backfill first.                                       |
| `transactions`                               | Enables the `2.0` callback transaction protocol. Storage initialization, compatible readers and writers, and recovery are mandatory.                  |

The package exports `BetterAuthDynamoDBOptions`, `TtlOptions`, `DynamoDBAdapterError`, `DynamoDBConflictError`, and `UnsupportedQueryError`.

## DynamoDB requirements

Create a table with:

- Partition key: `pk` as a string
- Sort key: `sk` as a string
- DynamoDB TTL enabled when using the adapter's TTL option
- No GSIs

The application role needs the DynamoDB operations used by the configured features, including `GetItem`, `BatchGetItem`, `Query`, and transactional writes. The examples contain deployable policy definitions.

Do not write Better Auth records directly to the table. The adapter maintains entity rows, scalar indexes, uniqueness locks, TTL metadata, and revision guards together.

## Query and concurrency behavior

The adapter uses keyed reads for ID equality, ID `IN`, and indexed scalar equality or `IN` predicates. Unsupported query shapes fail clearly unless `unsafeAllowScan: true` is enabled. `OR`, range-only, and unanchored case-insensitive predicates require this explicit fallback.

Single-record writes atomically maintain the entity, indexes, and uniqueness locks. Updates and deletes use revision guards to reject stale writes. `consumeOne` allows exactly one concurrent consumer, and `incrementOne` uses DynamoDB's native numeric update behavior.

Bulk updates and deletes use bounded concurrency and can make partial progress before an error. Do not blindly retry them. Native Better Auth joins are unsupported because arbitrary relational joins do not have a safe general DynamoDB access pattern.

Read the [changelog](./CHANGELOG.md) for detailed behavior and compatibility notes.

## Enterprise transactions

Better Auth's current SCIM plugin and some advanced SSO hooks require interactive callback transactions. Stable `1.2` does not provide them. The `2.0` preview implements them entirely on DynamoDB through durable preparation, one commit decision, rollback, and recovery.

The protocol has no fixed 100-item logical transaction limit. It divides physical DynamoDB work into bounded requests while preserving one atomic result. A SCIM Group operation is therefore not exposed as partially committed membership chunks.

Large groups, `/Bulk`, and asynchronous provisioning also require the companion [Better Auth SCIM changes](https://github.com/tgundhus/better-auth/tree/feat/large-groups-and-bulk).

Before enabling transactions, read:

- [Enterprise compatibility](./docs/enterprise-transactions.md)
- [Transaction storage, migration, and recovery](./docs/transaction-storage.md)
- [AWS staging validation](./docs/staging-validation.md)
- [Lambda recovery worker](./examples/aws-lambda/README.md)

All application instances and direct table consumers must understand the transaction protocol before migration. Query predicates do not provide serializable range isolation, and external callback effects still require application-owned idempotency or an outbox.

## Upgrading from BjornTech `1.1`

Upgrading to stable `1.2` requires no storage migration. Add `dynamodb:BatchGetItem` and `dynamodb:Query` to the application role before deployment. Strong reads remain the default.

Enabling compound schema uniqueness on existing data requires a maintenance window, duplicate repair, and lock backfill. The adapter does not supply an automatic migration utility.

The `2.0` transaction preview is a separate coordinated upgrade. Do not enable `transactions: true` on an existing table until every reader and writer is compatible and the recovery worker is deployed.

## Verification

```sh
bun run verify
bun run test:integration:local
```

`bun run verify` runs type checking, linting, coverage tests, the per-function CRAP limit, and a production build. Integration tests run against the official DynamoDB Local image and include Better Auth adapter conformance coverage.

Local tests do not prove IAM, AWS throttling, adaptive capacity, real TTL deletion timing, backups, or production latency. Validate those behaviors in AWS before a critical rollout.

## Contributing

Open pull requests against [this repository](https://github.com/tgundhus/betterauth-dynamodb/pulls). Keep changes small, tested, storage-aware, and explicit about DynamoDB limitations. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Released under the [MIT license](./LICENSE). The original adapter is copyright © 2026 BjornTech AB. This continuation retains the original license and attribution.
