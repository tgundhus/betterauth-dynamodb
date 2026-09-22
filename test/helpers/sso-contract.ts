import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { scim, acquireActiveSCIMUserLink } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { OAuth2Server } from "oauth2-mock-server";
import { expect } from "vitest";
import { dynamoDBAdapter, initializeDynamoDBTransactions, type BetterAuthDynamoDBOptions } from "../../src/index.js";

export async function ssoContract(options: BetterAuthDynamoDBOptions) {
  await initializeDynamoDBTransactions(options);
  const idp = new OAuth2Server();
  await idp.issuer.keys.generate("RS256");
  idp.service.on("beforeTokenSigning", (token) => { Object.assign(token.payload, { sub: "directory-1", email: "idp@example.com", name: "IdP name", email_verified: true }); });
  idp.service.on("beforeUserinfo", (response) => { response.statusCode = 200; response.body = { sub: "directory-1", email: "idp@example.com", name: "IdP name", email_verified: true }; });
  await idp.start(undefined, "127.0.0.1");
  try { await exerciseSSO(options, idp); }
  finally { await idp.stop(); }
}

export async function ssoGuardContract(options: BetterAuthDynamoDBOptions) {
  await initializeDynamoDBTransactions(options);
  let reject = true;
  const auth = betterAuth({ baseURL: "http://localhost:3000", secret: "provider-guard-test-secret-at-least-32-characters", database: dynamoDBAdapter({ ...options, transactions: true }), emailAndPassword: { enabled: true }, plugins: [sso({
    async guardProviderMutation(input, context) {
      await context.database.update({ model: "ssoProvider", where: [{ field: "id", value: input.provider.id }], update: { domain: "must-rollback.example.com" } });
      if (reject) throw new Error("injected provider guard failure");
    }
  })] });
  const signUp = await auth.api.signUpEmail({ body: { email: "owner@example.com", password: "valid-test-password", name: "Owner" }, asResponse: true });
  const owner = await signUp.json() as { user: { id: string } };
  const cookies = new Map<string, string>();
  storeCookies(signUp, cookies);
  const adapter = (await auth.$context).adapter;
  const provider = await adapter.create<any, any>({ model: "ssoProvider", data: { providerId: "guarded", domain: "example.com", issuer: "https://idp.example.com", userId: owner.user.id, oidcConfig: JSON.stringify({ issuer: "https://idp.example.com", clientId: "client", clientSecret: "secret", pkce: false, discoveryEndpoint: "https://idp.example.com/.well-known/openid-configuration" }) } });
  const headers = { cookie: cookieHeader(cookies) };
  await expect(auth.api.updateSSOProvider({ headers, body: { providerId: "guarded", domain: "updated.example.com" } })).rejects.toMatchObject({ status: "CONFLICT" });
  expect(await adapter.findOne({ model: "ssoProvider", where: [{ field: "id", value: provider.id }] })).toMatchObject({ domain: "example.com" });
  reject = false;
  await auth.api.updateSSOProvider({ headers, body: { providerId: "guarded", domain: "updated.example.com" } });
  expect(await adapter.findOne({ model: "ssoProvider", where: [{ field: "id", value: provider.id }] })).toMatchObject({ domain: "updated.example.com" });
  reject = true;
  await expect(auth.api.deleteSSOProvider({ headers, body: { providerId: "guarded" } })).rejects.toMatchObject({ status: "CONFLICT" });
  expect(await adapter.findOne({ model: "ssoProvider", where: [{ field: "id", value: provider.id }] })).toMatchObject({ domain: "updated.example.com" });
  reject = false;
  await auth.api.deleteSSOProvider({ headers, body: { providerId: "guarded" } });
  expect(await adapter.findOne({ model: "ssoProvider", where: [{ field: "id", value: provider.id }] })).toBeNull();
}

async function exerciseSSO(options: BetterAuthDynamoDBOptions, idp: OAuth2Server) {
  let reject = true;
  const auth = betterAuth({ baseURL: "http://localhost:3000", secret: "enterprise-sso-test-secret-at-least-32-characters", database: dynamoDBAdapter({ ...options, transactions: true, ttl: { fields: { session: "expiresAt", verification: "expiresAt" } } }), verification: { disableCleanup: true }, trustedOrigins: [idp.issuer.url!],
    plugins: [scim({ connections: [{ id: "workforce", credentials: [{ type: "bearer", id: "test", token: "test-token" }] }] }) as unknown as BetterAuthPlugin,
      sso({ disableImplicitSignUp: true, defaultSSO: [{ domain: "example.com", providerId: "workforce", oidcConfig: { issuer: idp.issuer.url!, clientId: "test-client", clientSecret: "test-secret", pkce: false, discoveryEndpoint: `${idp.issuer.url}/.well-known/openid-configuration` } }],
        async resolveUser(input, context) {
          const link = await acquireActiveSCIMUserLink({ connectionId: "workforce", externalId: input.accountKey.accountId }, context);
          if (!link) return { action: "reject", code: "SCIM_USER_NOT_ACTIVE" };
          if (reject) {
            await context.database.update({ model: "user", where: [{ field: "id", value: link.userId }], update: { name: "must roll back" } });
            throw new Error("injected SSO resolution failure");
          }
          return { action: "link", userId: link.userId, profile: "preserve" };
        }
      })]
  });
  const request = (path: string, method = "GET", body?: unknown, headers?: HeadersInit) => auth.handler(new Request(`http://localhost:3000/api/auth${path}`, { method, headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const scimHeaders = { authorization: "Bearer test-token" };
  const created = await request("/scim/v2/Users", "POST", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], externalId: "directory-1", userName: "provisioned@example.com", displayName: "Provisioned name" }, scimHeaders);
  expect(created.status, await created.clone().text()).toBe(201);
  const provisioned = await created.json() as { id: string };
  const adapter = (await auth.$context).adapter;
  const signIn = async () => {
    const start = await request("/sign-in/sso", "POST", { providerId: "workforce", callbackURL: "http://localhost:3000/employee" });
    expect(start.status, await start.clone().text()).toBe(200);
    const cookies = new Map<string, string>();
    storeCookies(start, cookies);
    const { url } = await start.json() as { url: string };
    const authorization = await fetch(url, { redirect: "manual" });
    const callbackURL = authorization.headers.get("location")!;
    const callback = await auth.handler(new Request(callbackURL, { headers: { cookie: cookieHeader(cookies) } }));
    storeCookies(callback, cookies);
    return { callback, cookies };
  };
  const rejected = await signIn();
  expect(rejected.callback.headers.get("location")).toContain("SSO_USER_RESOLUTION_FAILED");
  expect(await adapter.findOne({ model: "user", where: [{ field: "email", value: "provisioned@example.com" }] })).toMatchObject({ name: "Provisioned name" });
  expect(await adapter.count({ model: "account", where: [{ field: "providerId", value: "workforce" }] })).toBe(0);
  expect(await (await request("/get-session", "GET", undefined, { cookie: cookieHeader(rejected.cookies) })).json()).toBeNull();
  reject = false;
  const accepted = await signIn();
  expect(accepted.callback.headers.get("location")).toBe("http://localhost:3000/employee");
  const session = await (await request("/get-session", "GET", undefined, { cookie: cookieHeader(accepted.cookies) })).json() as any;
  expect(session?.user).toMatchObject({ email: "provisioned@example.com", name: "Provisioned name" });
  expect(await adapter.count({ model: "account", where: [{ field: "providerId", value: "workforce" }] })).toBe(1);
  const deactivated = await request(`/scim/v2/Users/${provisioned.id}`, "PATCH", { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] }, scimHeaders);
  expect(deactivated.status, await deactivated.clone().text()).toBe(200);
  expect(await (await request("/get-session", "GET", undefined, { cookie: cookieHeader(accepted.cookies) })).json()).toBeNull();
  expect(await adapter.count({ model: "session", where: [{ field: "userId", value: session.user.id }] })).toBe(0);
  const inactive = await signIn();
  expect(inactive.callback.headers.get("location")).toContain("SCIM_USER_NOT_ACTIVE");
}

function storeCookies(response: Response, cookies: Map<string, string>) {
  for (const cookie of response.headers.getSetCookie()) {
    const value = cookie.split(";", 1)[0]!;
    const index = value.indexOf("=");
    if (index > 0) cookies.set(value.slice(0, index), value.slice(index + 1));
  }
}
function cookieHeader(cookies: Map<string, string>): string { return [...cookies].map(([name, value]) => `${name}=${value}`).join("; "); }
