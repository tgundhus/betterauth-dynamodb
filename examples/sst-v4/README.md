# betterauth-dynamodb SST v4 example

Standalone SST v4 app that deploys a Better Auth handler on an AWS Lambda Function URL backed by DynamoDB.

## What it provisions

- DynamoDB table with `pk` partition key, `sk` sort key, and TTL enabled on `ttl`.
- Linked `BetterAuthSecret` secret.
- Lambda Function URL handler that injects a `DynamoDBDocumentClient` into `@bjorntech/betterauth-dynamodb`.

No GSI is required by the adapter.

## Setup

From the repository root, build the local package first:

```sh
bun run build
```

Then install this example:

```sh
cd examples/sst-v4
bun install
bun run generate:types
```

`bun run generate:types` runs `sst install`, which creates `.sst/platform/config.d.ts` for linked resource typing. `bun run typecheck` also runs this generation step before `tsc --noEmit`, so it works from a clean checkout after dependencies are installed.

Set the Better Auth secret before deploy or live dev:

```sh
bun sst secret set BetterAuthSecret "replace-with-a-long-random-secret"
```

The local dependency is `@bjorntech/betterauth-dynamodb: file:../..`. For deployments, replace it with the published package version you intend to deploy.

## Dev

```sh
bun run dev
```

The Function URL example is intended for same-origin use and does not configure CORS. In production, prefer a stable custom domain for the auth endpoint. If your application needs cross-origin browser requests, configure an explicit trusted origin instead of a wildcard, especially when credentials/cookies are involved.

This example does not bind `BETTER_AUTH_URL`; Better Auth can infer the request origin from the incoming Function URL request. For production deployments that require an explicit public base URL, add a real runtime binding or environment value that matches your known custom domain.

## Deploy

```sh
bun run deploy
```

## Remove

```sh
bun run remove
```

The config retains resources in a `production` stage and removes them in other stages.
