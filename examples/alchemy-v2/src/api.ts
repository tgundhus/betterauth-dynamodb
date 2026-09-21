import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { dynamoDBAdapter } from "@bjorntech/betterauth-dynamodb";
import * as AWS from "alchemy/AWS";
import { betterAuth } from "better-auth";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class Api extends AWS.Lambda.Function<Api>()(
  "Api",
  { main: import.meta.url, url: true },
  Effect.gen(function* () {
    const table = yield* AWS.DynamoDB.Table("BetterAuthTable", {
      partitionKey: "pk",
      sortKey: "sk",
      attributes: {
        pk: "S",
        sk: "S"
      },
      timeToLiveSpecification: {
        Enabled: true,
        AttributeName: "ttl"
      }
    });

    yield* AWS.DynamoDB.GetItem(table);
    yield* AWS.DynamoDB.BatchGetItem(table);
    yield* AWS.DynamoDB.Query(table);
    yield* AWS.DynamoDB.TransactWriteItems(table);
    const authSecret = yield* Config.redacted("BETTER_AUTH_SECRET");

    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true }
    });

    const auth = betterAuth({
      secret: Redacted.value(authSecret),
      database: dynamoDBAdapter({
        tableName: String(table.tableName),
        client: dynamo,
        ttl: { fields: { session: "expiresAt", verification: "expiresAt" } }
      }),
      verification: { disableCleanup: true },
      emailAndPassword: { enabled: true }
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* toWebRequest(request);
        const response = yield* Effect.promise(() => auth.handler(webRequest));
        return yield* toAlchemyResponse(response);
      }).pipe(Effect.orDie)
    };
  })
) {}

function toWebRequest(request: HttpServerRequest.HttpServerRequest): Effect.Effect<Request, unknown> {
  return Effect.gen(function* () {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) headers.set(name, value);
    const init: RequestInit = {
      method: request.method,
      headers
    };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = yield* request.text;
    return new Request(request.url, init);
  });
}

function toAlchemyResponse(response: Response): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.succeed(HttpServerResponse.fromWeb(response));
}
