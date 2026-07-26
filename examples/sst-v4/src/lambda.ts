import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { auth } from "./auth.js";

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const response = await auth.handler(toRequest(event));
  return toLambdaResponse(response);
}

function toRequest(event: APIGatewayProxyEventV2): Request {
  const url = new URL(event.rawPath ?? "/", `https://${event.requestContext.domainName}`);
  const rawQuery = event.rawQueryString ?? "";
  if (rawQuery) url.search = rawQuery;

  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));

  const init: RequestInit = {
    method: event.requestContext.http.method,
    headers
  };
  if (event.body && allowsRequestBody(init.method)) init.body = decodeBody(event.body, event.isBase64Encoded);
  return new Request(url, init);
}

async function toLambdaResponse(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const cookies = getSetCookie(response.headers);
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  const body = await encodeResponseBody(response, headers);

  return {
    statusCode: response.status,
    headers: Object.fromEntries(headers.entries()),
    cookies,
    body: body.body,
    isBase64Encoded: body.isBase64Encoded
  };
}

function decodeBody(body: string, isBase64Encoded: boolean): BodyInit {
  if (!isBase64Encoded) return body;
  const bytes = Buffer.from(body, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function encodeResponseBody(
  response: Response,
  headers: Headers
): Promise<{ body?: string; isBase64Encoded?: boolean }> {
  if (!response.body) return {};
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) return {};
  if (isTextualContentType(headers.get("content-type"))) {
    return { body: new TextDecoder().decode(bytes) };
  }
  return { body: Buffer.from(bytes).toString("base64"), isBase64Encoded: true };
}

function allowsRequestBody(method: string | undefined): boolean {
  const normalized = method?.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function isTextualContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

function getSetCookie(headers: Headers): string[] | undefined {
  const maybeGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = maybeGetSetCookie.getSetCookie?.() ?? splitSetCookie(headers.get("set-cookie"));
  return cookies.length ? cookies : undefined;
}

function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,]+=)/).map((cookie) => cookie.trim());
}
