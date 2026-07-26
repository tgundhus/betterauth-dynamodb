# betterauth-dynamodb Alchemy v2 example

Standalone Alchemy v2 prerelease example that deploys a Better Auth handler on an AWS Lambda Function URL backed by DynamoDB.

Alchemy v2 is currently published on npm as a beta (`alchemy@2.0.0-beta.64`, with `effect@4.0.0-beta.101`). Expect API movement and re-typecheck this example when upgrading Alchemy.

## What it provisions

- DynamoDB table with `pk` partition key, `sk` sort key, and TTL enabled on `ttl`.
- Lambda Function URL handler that injects a `DynamoDBDocumentClient` into `@bjorntech/betterauth-dynamodb`.
- Least-privilege DynamoDB bindings for the adapter's default command paths: `GetItem`, `Query`, and `TransactWriteItems`.

This example does not grant `Scan`. Keep `unsafeAllowScan` disabled unless you intentionally add a `Scan` binding and accept that access pattern.

## Setup

From the repository root, build the local package first:

```sh
bun run build
```

Then install this example:

```sh
cd examples/alchemy-v2
bun install
cp .env.example .env
```

Edit `.env` with a long random `BETTER_AUTH_SECRET`. The local dependency is `@bjorntech/betterauth-dynamodb: file:../..`; for deployments, replace it with the published package version you intend to deploy.

Configure Alchemy's AWS credentials/profile according to the Alchemy AWS setup guide before deploying.

## Deploy

```sh
bun run deploy
```

The deploy output includes the Function URL. This example does not bind `BETTER_AUTH_URL`; Better Auth can infer the request origin from incoming requests. For production deployments that require an explicit public base URL, add a real runtime environment value that matches your known custom domain.

## Destroy

```sh
bun run destroy
```

Do not commit `.env`, `.alchemy/`, deployment output, or generated bundles.
