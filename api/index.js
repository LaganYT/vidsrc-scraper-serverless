import { Readable } from "node:stream";
import { handleRequest } from "../src/worker.js";

function requestUrl(request) {
  const protocol = request.headers["x-forwarded-proto"]?.split(",")[0] || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
  const url = new URL(request.url || "/", `${protocol}://${host}`);
  if (url.searchParams.has("__path")) {
    url.pathname = `/${url.searchParams.get("__path") || ""}`;
    url.searchParams.delete("__path");
  }
  return url.toString();
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function hlsProxyOrigin() {
  const raw = process.env.HLS_PROXY_ORIGIN;
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function offloadExtractHlsUrls(data, requestOrigin, proxyOrigin) {
  if (!data || typeof data !== "object" || !data.results) return data;
  for (const result of Object.values(data.results)) {
    if (!result || typeof result !== "object" || typeof result.hls_url !== "string") continue;
    try {
      const url = new URL(result.hls_url);
      if (url.origin === requestOrigin && url.pathname === "/hls-proxy") {
        result.hls_url = `${proxyOrigin}${url.pathname}${url.search}`;
      }
    } catch { /* Leave malformed or non-URL values unchanged. */ }
  }
  return data;
}

export default async function handler(request, response) {
  try {
    const resolvedUrl = new URL(requestUrl(request));
    const proxyOrigin = hlsProxyOrigin();

    // Keep large HLS payloads off Vercel Functions. When configured, even old
    // Vercel /hls-proxy URLs become tiny redirects to the Cloudflare proxy.
    if (proxyOrigin && resolvedUrl.pathname === "/hls-proxy") {
      response.statusCode = 307;
      response.setHeader("Location", `${proxyOrigin}${resolvedUrl.pathname}${resolvedUrl.search}`);
      response.setHeader("Cache-Control", "no-store");
      response.end();
      return;
    }

    const webRequest = new Request(resolvedUrl.toString(), {
      method: request.method,
      headers: requestHeaders(request),
    });
    const webResponse = await handleRequest(webRequest, process.env);

    // /extract is tiny JSON. Rewrite its HLS URLs so clients go straight to
    // Cloudflare for manifests and segments, avoiding Vercel Fast Origin Transfer.
    if (proxyOrigin && resolvedUrl.pathname === "/extract" && (webResponse.headers.get("content-type") || "").includes("application/json")) {
      const data = offloadExtractHlsUrls(await webResponse.json(), resolvedUrl.origin, proxyOrigin);
      response.statusCode = webResponse.status;
      webResponse.headers.forEach((value, name) => response.setHeader(name, value));
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(data));
      return;
    }

    response.statusCode = webResponse.status;
    webResponse.headers.forEach((value, name) => response.setHeader(name, value));
    if (!webResponse.body) {
      response.end();
      return;
    }
    Readable.fromWeb(webResponse.body).pipe(response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.statusCode = 500;
    response.end("Internal server error");
  }
}
