import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "BetterAuthDynamoDBExample",
  {
    providers: AWS.providers(),
    state: AWS.state()
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.functionUrl };
  })
);
