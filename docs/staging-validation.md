# Reproduce enterprise validation

The preview contracts exercise standard Bulk, complete large-group lifecycle and connection retirement, a group grant racing user deactivation, and asynchronous jobs across fresh Better Auth instances. Each native test creates its own randomly named `scim_preview_*` table and deletes that table during teardown. The harness does not accept an existing table name.

## Prepare the companion SCIM package

Adapter CI builds the immutable companion revision in [ci.yml](../.github/workflows/ci.yml). To reproduce that build in a separate checkout:

```sh
git clone https://github.com/tgundhus/better-auth.git scim-contract-source
cd scim-contract-source
git checkout cf1570905c3b43ca1751f6584513e740772551fa
pnpm install --frozen-lockfile --filter '@better-auth/scim...'
pnpm --filter '@better-auth/scim^...' build
pnpm --filter @better-auth/scim build
pnpm exec vitest run packages/scim/src
```

In the adapter checkout, run `bun install --frozen-lockfile`. Create `node_modules/.scim-enterprise-preview` and copy the built `packages/scim/dist/index.mjs` from the companion checkout into that directory as `index.mjs`. This keeps the built plugin's package imports anchored in the adapter's pinned dependencies. No companion source is imported by the published adapter.

## DynamoDB Local

With Docker available, run these commands from the adapter checkout in PowerShell:

```powershell
$env:SCIM_PREVIEW_MODULE = 'node_modules/.scim-enterprise-preview/index.mjs'
$env:SCIM_PREVIEW_DYNAMODB = '1'
$env:SCIM_SCALE_MEMBERS = '1051'
node node_modules/vitest/vitest.mjs run --config vitest.preview.config.ts
```

Set `SCIM_SCALE_MEMBERS` to `10000` for the larger fixture. The GitHub `ci` workflow also accepts this size through its manual `members` input. Omitting both backend variables uses the independent command double; it does not measure DynamoDB performance.

## Disposable AWS staging tables

Use a staging profile or role restricted to test resources. The following opt-in creates billable tables in the selected AWS account and region. It does not deploy Lambda or send requests to a deployed authentication service.

```powershell
$env:AWS_PROFILE = 'your-staging-profile'
$env:SCIM_PREVIEW_AWS_REGION = 'your-staging-region'
Remove-Item Env:SCIM_PREVIEW_DYNAMODB -ErrorAction SilentlyContinue
$env:SCIM_PREVIEW_MODULE = 'node_modules/.scim-enterprise-preview/index.mjs'
$env:SCIM_SCALE_MEMBERS = '1051'
node node_modules/vitest/vitest.mjs run --config vitest.preview.config.ts
```

The AWS SDK uses its normal credential provider chain. The role needs CreateTable, DescribeTable, DeleteTable, GetItem, BatchGetItem, Query, PutItem, UpdateItem, DeleteItem, and ConditionCheckItem permissions on `scim_preview_*` tables in that region. No Scan or access to the production authentication table is required. Do not set a local AWS endpoint override. The harness rejects simultaneous AWS and DynamoDB Local selections.

Table names appear in the `preview-table` log entry. If the process is killed or table creation acknowledgement is lost, inspect those exact table names and remove any leftover test tables. Teardown only deletes tables whose creation succeeded in the current test.

## Measurements and release evidence

Large-group lifecycle logs contain operation duration, SDK call counts and attempts, reported read/write capacity, unsplit capacity totals, and approximate returned JSON bytes. `capacityResponses: 0` means capacity was unavailable. A missing read/write split stays under `unclassifiedCapacityUnits`; it is not guessed. Returned JSON bytes are neither billed item bytes nor wire traffic. Error responses may omit consumed capacity, so failed-request cost is not fully captured. See [AWS ConsumedCapacity](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_ConsumedCapacity.html).

Record the adapter and SCIM commit IDs, backend, region, workload size, SDK retry configuration, and host or Lambda memory alongside each run. Repeat representative workloads to calculate operation p50/p95/p99; a single lifecycle run cannot establish those percentiles. Keep request payloads and bearer credentials out of reports.

The storage contracts can run against AWS once staging exists. Deployed Lambda and gateway testing remains separate: verify ingress and response limits, cold starts, concurrent requests, throttling, credential rotation, worker termination, alarm delivery, and recovery after termination during preparation and cleanup. Repeat with the application's real projection callbacks and largest individual Group operation. Async workers checkpoint between resource operations; one callback still has to fit the invocation deadline. See [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).

Before production release, rehearse the coordinated migration and rollback in [transaction storage](./transaction-storage.md), restore the whole table including journals from backup, and verify all grants and sessions after recovery. No AWS staging run or deployed Lambda validation has been performed during development.
