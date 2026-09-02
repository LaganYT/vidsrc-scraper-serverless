import { handleRequest } from "./worker.js";

const PLAYER_ORIGIN = "https://cloudorchestranova.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};
const tokenCache = new Map();

function reply(body, init = {}) {
  const headers = new Headers(init.headers);
  Object.entries(CORS).forEach(([key, value]) => headers.set(key, value));
  return new Response(body, { ...init, headers });
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveUrl(uri, base) {
  try { return new URL(uri, base).toString(); }
  catch { return uri; }
}

function isVidSrcPlaylist(url) {
  return /\/pl\/[A-Za-z0-9+/=._-]{40,}\//.test(url);
}

function isVidSrcSegment(url) {
  try {
    return /^\/content\/[a-f0-9]{32}\/[a-f0-9]{32}\/page-\d+\.html$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function parseToken(value) {
  const text = (value || "").trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const data = JSON.parse(text);
      if (typeof data === "string") return data;
      return data?.token || data?.data || data?.string || data?.result || "";
    } catch {
      return "";
    }
  }
  return text;
}

function tokenExpiry(token) {
  try {
    const part = token.split(".")[1];
    if (!part) return 0;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    return Number(JSON.parse(atob(padded)).exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function playerHeaders(extra = {}) {
  return {
    Accept: "*/*",
    Referer: `${PLAYER_ORIGIN}/`,
    Origin: PLAYER_ORIGIN,
    "User-Agent": USER_AGENT,
    ...extra,
  };
}

async function getVidSrcToken(origin, tokenUrl, headers) {
  const cached = tokenCache.get(origin);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const endpoints = new Set();
  if (tokenUrl) endpoints.add(tokenUrl);
  endpoints.add(`${origin}/generate.php`);

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: playerHeaders(headers),
        redirect: "follow",
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!response.ok) {
        console.warn(`[cf-hls] token endpoint ${response.status}: ${new URL(endpoint).hostname}`);
        continue;
      }
      const token = parseToken(await response.text());
      if (!token) continue;
      const expiresAt = tokenExpiry(token) || Date.now() + 50 * 60 * 1000;
      tokenCache.set(origin, { token, expiresAt });
      return token;
    } catch (error) {
      console.warn(`[cf-hls] token endpoint failed: ${message(error)}`);
    }
  }
  return "";
}

function rewriteM3U8(content, baseUrl, proxyBase, headersParam, tokenUrl) {
  const headersSuffix = headersParam ? `&h=${encodeURIComponent(headersParam)}` : "";
  const tokenParam = tokenUrl ? `&t=${encodeURIComponent(tokenUrl)}` : "";
  return content.split(/\r?\n/).map((line) => {
    if (line.startsWith("#") && line.includes("URI=")) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const absolute = resolveUrl(uri, baseUrl);
        return `URI="${proxyBase}?url=${encodeURIComponent(absolute)}${headersSuffix}${tokenParam}"`;
      });
    }
    if (line && !line.startsWith("#")) {
      const absolute = resolveUrl(line.trim(), baseUrl);
      return `${proxyBase}?url=${encodeURIComponent(absolute)}${headersSuffix}${tokenParam}`;
    }
    return line;
  }).join("\n");
}

async function cloudflareHlsProxy(request) {
  const pageUrl = new URL(request.url);
  const targetUrl = pageUrl.searchParams.get("url");
  const headersParam = pageUrl.searchParams.get("h");
  const tokenUrl = pageUrl.searchParams.get("t");
  if (!targetUrl) return reply("Missing url parameter", { status: 400 });

  let target;
  try {
    target = new URL(targetUrl);
    if (target.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
  } catch (error) {
    return reply(message(error), { status: 400 });
  }

  let forwarded = {};
  if (headersParam) {
    try {
      const parsed = JSON.parse(atob(headersParam));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      forwarded = parsed;
    } catch {
      return reply("Invalid h parameter; request a fresh hls_url from /extract", { status: 400 });
    }
  }

  // Vercel normally receives these headers from /extract. Supply the same player
  // context on Workers when a raw /watch?url=... or manually built proxy URL omits h.
  const headers = playerHeaders(forwarded);
  const range = request.headers.get("Range");
  if (range) headers.Range = range;

  if (isVidSrcPlaylist(target.toString()) && !target.searchParams.has("token")) {
    let validatedTokenUrl = "";
    try {
      if (tokenUrl) {
        const parsed = new URL(tokenUrl);
        if (parsed.protocol === "https:") validatedTokenUrl = parsed.toString();
      }
    } catch {}

    const token = await getVidSrcToken(target.origin, validatedTokenUrl, forwarded);
    if (!token) {
      return reply("Unable to obtain a VidSrc token from Cloudflare egress", {
        status: 502,
        headers: { "X-HLS-Proxy": "cloudflare-token-failed" },
      });
    }
    target.searchParams.set("token", token);
  }

  console.log(`[cf-hls] ${target.hostname}${target.pathname.slice(0, 80)} headers=${Object.keys(headers).join(",")}`);

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers,
      redirect: "follow",
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch (error) {
    return reply(`Proxy fetch failed: ${message(error)}`, {
      status: 502,
      headers: { "X-HLS-Proxy": "cloudflare-fetch-failed" },
    });
  }

  if (!upstream.ok) {
    console.error(`[cf-hls] upstream ${upstream.status} ${target.hostname}${target.pathname}`);
    return reply(`Upstream error (${upstream.status})`, {
      status: 502,
      headers: {
        "X-HLS-Proxy": "cloudflare-upstream-error",
        "X-HLS-Upstream-Status": String(upstream.status),
      },
    });
  }

  const contentType = upstream.headers.get("Content-Type") || "";
  if (target.pathname.endsWith(".m3u8") || contentType.includes("mpegurl") || contentType.includes("m3u8")) {
    const text = await upstream.text();
    return reply(rewriteM3U8(text, target.toString(), `${pageUrl.origin}/hls-proxy`, headersParam, tokenUrl), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
        "X-HLS-Proxy": "cloudflare",
      },
    });
  }

  const responseHeaders = new Headers(upstream.headers);
  if (isVidSrcSegment(target.toString())) {
    responseHeaders.set("Content-Type", "video/mp2t");
    responseHeaders.delete("X-Content-Type-Options");
  }
  responseHeaders.set("X-HLS-Proxy", "cloudflare");
  Object.entries(CORS).forEach(([key, value]) => responseHeaders.set(key, value));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/hls-proxy") {
    if (request.method === "OPTIONS") return reply(null, { status: 204 });
    if (request.method !== "GET") return reply("Method not allowed", { status: 405, headers: { Allow: "GET, OPTIONS" } });
    return cloudflareHlsProxy(request);
  }
  return handleRequest(request, env, ctx);
}

export default { fetch };
