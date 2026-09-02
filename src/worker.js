import { getTVSubtitleVTT } from "./tv-subtitles.js";
import { convertPage, watchPage } from "./media-pages.js";
import { extractStreams, extractionError } from "./http-extractor.js";

const PROVIDERS = [
  "https://vidsrc2.ru",
  "https://vidsrc.ir",
  "https://vidsrcme.ru",
  "https://vidsrcme.su",
  "https://vidsrc-me.ru",
  "https://vidsrc-me.su",
  "https://vidsrc-embed.ru",
  "https://vidsrc-embed.su",
  "https://vsrc.su",
];
const LANGUAGE_NAMES = { en: "English" };
const COMMON_LANGUAGES = new Set(Object.keys(LANGUAGE_NAMES));
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const EXTRACT_CACHE_SCHEMA = "fetch-only-v1";
const tokenCache = new Map();

function reply(body, init = {}) {
  const headers = new Headers(init.headers);
  Object.entries(CORS).forEach(([key, value]) => headers.set(key, value));
  return new Response(body, { ...init, headers });
}
function json(data, status = 200, headers = {}) {
  return reply(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
function message(error) { return error instanceof Error ? error.message : String(error); }
function resolveUrl(uri, base) {
  try { return new URL(uri, base).toString(); }
  catch { return uri; }
}

function isVidSrcCdn(url) { return /\/pl\/[A-Za-z0-9+/=._-]{40,}\//.test(url); }
function parseToken(value) {
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const data = JSON.parse(text);
      if (typeof data === "string") return data;
      return data?.token || data?.data || data?.string || data?.result || "";
    } catch { return ""; }
  }
  return text;
}
async function getVidSrcToken(origin, tokenUrl, headers) {
  const cached = tokenCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const endpoints = new Set();
  if (tokenUrl) endpoints.add(tokenUrl);
  endpoints.add(`${origin}/generate.php`);
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { headers, redirect: "follow" });
      if (!response.ok) continue;
      const token = parseToken(await response.text());
      if (!token) continue;
      tokenCache.set(origin, { token, expiresAt: Date.now() + 50 * 60 * 1000 });
      return token;
    } catch { /* Try the next token endpoint. */ }
  }
  return "";
}

function rewriteM3U8(content, baseUrl, proxyBase, headersParam, tokenUrl) {
  const h = encodeURIComponent(headersParam);
  const tokenParam = tokenUrl ? `&t=${encodeURIComponent(tokenUrl)}` : "";
  return content.split(/\r?\n/).map((line) => {
    if (line.startsWith("#") && line.includes("URI=")) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const absolute = resolveUrl(uri, baseUrl);
        return `URI="${proxyBase}?url=${encodeURIComponent(absolute)}&h=${h}${tokenParam}"`;
      });
    }
    if (line && !line.startsWith("#")) {
      const absolute = resolveUrl(line.trim(), baseUrl);
      return `${proxyBase}?url=${encodeURIComponent(absolute)}&h=${h}${tokenParam}`;
    }
    return line;
  }).join("\n");
}

async function hlsProxy(request) {
  const params = new URL(request.url).searchParams;
  const targetUrl = params.get("url");
  const headersParam = params.get("h");
  const tokenUrl = params.get("t");
  if (!targetUrl) return reply("Missing url parameter", { status: 400 });
  if (!headersParam && params.has("referer")) {
    return reply("Legacy proxy URL expired; request a fresh hls_url from /extract", { status: 410 });
  }

  let target;
  try {
    target = new URL(targetUrl);
    if (target.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
  } catch (error) {
    return reply(message(error), { status: 400 });
  }

  let forwardHeaders = {};
  if (headersParam) {
    try {
      const parsed = JSON.parse(atob(headersParam));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Headers must be an object");
      forwardHeaders = parsed;
    } catch {
      return reply("Invalid h parameter; request a fresh hls_url from /extract", { status: 400 });
    }
  }
  const headers = { ...forwardHeaders, "User-Agent": USER_AGENT };
  if (isVidSrcCdn(target.toString())) {
    let validatedTokenUrl = null;
    try {
      if (tokenUrl) {
        validatedTokenUrl = new URL(tokenUrl);
        if (validatedTokenUrl.protocol !== "https:") validatedTokenUrl = null;
      }
    } catch { validatedTokenUrl = null; }
    const token = await getVidSrcToken(target.origin, validatedTokenUrl?.toString(), headers);
    if (token) target.searchParams.set("token", token);
  }
  console.log(`[hls-proxy] ${target.pathname.slice(0, 60)} forwarding headers:`, Object.keys(headers).join(", "));

  try {
    const response = await fetch(target, { headers, redirect: "follow" });
    if (!response.ok) {
      console.error(`[hls-proxy] upstream ${response.status} for ${target.hostname}${target.pathname.slice(0, 60)}`);
      return reply(`Upstream error (${response.status})`, { status: 502 });
    }

    const ct = response.headers.get("content-type") || "";
    if (target.pathname.endsWith(".m3u8") || ct.includes("mpegurl") || ct.includes("m3u8")) {
      const text = await response.text();
      const proxyBase = `${new URL(request.url).origin}/hls-proxy`;
      return reply(rewriteM3U8(text, target.toString(), proxyBase, headersParam, tokenUrl), {
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" },
      });
    }

    return reply(response.body, {
      headers: { "Content-Type": ct || "application/octet-stream" },
    });
  } catch (error) {
    return reply(`Proxy error: ${message(error)}`, { status: 502 });
  }
}

async function extract(request, env, ctx) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "movie";
  const tmdbId = url.searchParams.get("tmdb_id");
  const season = url.searchParams.get("season");
  const episode = url.searchParams.get("episode");
  if (!tmdbId) return json({ success: false, error: "tmdb_id query param is required", results: {} }, 400);
  if (!["movie", "tv"].includes(type)) return json({ success: false, error: 'type must be "movie" or "tv"', results: {} }, 400);
  if (type === "tv" && (!season || !episode)) return json({ success: false, error: "season and episode query params are required for TV shows", results: {} }, 400);

  // Version the cache key whenever the shape or semantics of extracted URLs change.
  // This prevents a new deployment from serving legacy proxy URLs until TTL expiry.
  const cacheUrl = new URL(url);
  cacheUrl.searchParams.set("_schema", EXTRACT_CACHE_SCHEMA);
  const key = new Request(cacheUrl.toString());
  const cache = globalThis.caches?.default;
  const cached = cache ? await cache.match(key) : null;
  if (cached) return reply(cached.body, { status: cached.status, headers: cached.headers });

  try {
    const extracted = await extractStreams({ tmdbId, type, season, episode, userAgent: USER_AGENT });
    const results = Object.fromEntries(PROVIDERS.map((domain, index) => {
      const hlsUrl = extracted.streams[index % extracted.streams.length];
      return [domain, {
        hls_url: hlsUrl,
        hls_headers: extracted.headers,
        token_url: extracted.token_url,
        subtitles: [],
        error: null,
      }];
    }));
    const proxyBase = `${new URL(request.url).origin}/hls-proxy`;
    for (const [domain, result] of Object.entries(results)) {
      if (result.hls_url) {
        const h = btoa(JSON.stringify(result.hls_headers || {}));
        const t = result.token_url ? `&t=${encodeURIComponent(result.token_url)}` : "";
        result.hls_url = `${proxyBase}?url=${encodeURIComponent(result.hls_url)}&h=${encodeURIComponent(h)}${t}`;
      }
      delete result.hls_headers;
      delete result.token_url;
    }
    const output = json({ success: Object.values(results).some((item) => item.hls_url), results }, 200, { "Cache-Control": "public, max-age=900" });
    if (cache) ctx.waitUntil(cache.put(key, output.clone()));
    return output;
  } catch (error) {
    const results = Object.fromEntries(PROVIDERS.map((domain) => [domain, extractionError(error)]));
    return json({ success: false, error: message(error), results }, 502);
  }
}

async function imdbId(tmdbId, type, env) {
  if (!env.TMDB_API_KEY) throw new Error("TMDB_API_KEY is not configured");
  const url = new URL(`https://api.themoviedb.org/3/${type}/${encodeURIComponent(tmdbId)}/external_ids`);
  url.searchParams.set("api_key", env.TMDB_API_KEY);
  const result = await fetch(url);
  if (!result.ok) throw new Error("Failed to fetch IMDb ID from TMDB");
  return (await result.json()).imdb_id || null;
}
async function searchSubtitles(id, env) {
  if (!env.OPENSUB_API_KEY) throw new Error("OPENSUB_API_KEY is not configured");
  const result = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${encodeURIComponent(id)}&per_page=100&page=1`, { headers: { "Api-Key": env.OPENSUB_API_KEY, "User-Agent": "Cinemi v1.0.0" } });
  if (!result.ok) return [];
  return ((await result.json()).data || []).filter((item) => item.attributes?.files?.[0]?.file_id && COMMON_LANGUAGES.has(item.attributes.language)).map((item) => ({ language: item.attributes.language, language_name: LANGUAGE_NAMES[item.attributes.language], file_id: item.attributes.files[0].file_id, downloads: item.attributes.download_count || 0 })).sort((a, b) => b.downloads - a.downloads).slice(0, 2);
}
async function downloadLink(fileId, env) {
  const result = await fetch("https://api.opensubtitles.com/api/v1/download", { method: "POST", headers: { "Content-Type": "application/json", "Api-Key": env.OPENSUB_API_KEY, "User-Agent": "Cinemi v1.0.0" }, body: JSON.stringify({ file_id: fileId }) });
  if (!result.ok) throw new Error("Subtitle download URL fetch failed");
  return (await result.json()).link;
}
async function movieSubtitles(request, env) {
  const url = new URL(request.url);
  const tmdbId = url.searchParams.get("tmdb_id");
  const type = url.searchParams.get("type") || "movie";
  if (!tmdbId) return json({ success: false, error: "tmdb_id is required" }, 400);
  if (!["movie", "tv"].includes(type)) return json({ success: false, error: "Invalid type" }, 400);
  if (!env.TMDB_API_KEY || !env.OPENSUB_API_KEY) {
    return json({
      success: false,
      error: "Movie subtitle lookup is not configured",
      required_secrets: ["TMDB_API_KEY", "OPENSUB_API_KEY"],
    }, 501);
  }
  try {
    const id = await imdbId(tmdbId, type, env);
    if (!id) return json({ success: false, error: "IMDb ID not found" }, 404);
    const subtitles = (await Promise.all((await searchSubtitles(id, env)).map(async (item) => {
      try { return { language: item.language, language_name: item.language_name, url: await downloadLink(item.file_id, env) }; }
      catch { return null; }
    }))).filter(Boolean);
    return json({ success: true, subtitles, meta: { tmdb_id: tmdbId, imdb_id: id, type } });
  } catch (error) { return json({ success: false, error: message(error) }, 500); }
}

async function tvSubtitles(request) {
  const url = new URL(request.url);
  const title = url.searchParams.get("title"), season = url.searchParams.get("season"), episode = url.searchParams.get("episode");
  if (url.searchParams.get("type") !== "tv") return reply("Invalid type provided", { status: 400 });
  if (!title || !season || !episode) return reply("title, season, and episode are required", { status: 400 });
  try {
    const vtt = await getTVSubtitleVTT(title, season, episode);
    return vtt ? reply(vtt, { headers: { "Content-Type": "text/vtt; charset=utf-8" } }) : reply("No subtitle found", { status: 404 });
  } catch (error) { console.error(message(error)); return reply("Internal server error", { status: 500 }); }
}
function toVtt(srt) { return "WEBVTT\n\n" + srt.replace(/^\uFEFF/, "").replace(/\r+/g, "").trim().replace(/(\d{2}:\d{2}:\d{2})[,.](\d{3})/g, "$1.$2"); }
async function subtitleProxy(request) {
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return reply("Missing subtitle URL", { status: 400 });
  let url;
  try { url = new URL(raw); if (url.protocol !== "https:") throw new Error("Only HTTPS subtitle URLs are allowed"); }
  catch (error) { return reply(message(error), { status: 400 }); }
  try {
    const result = await fetch(url, { redirect: "follow" });
    if (!result.ok) throw new Error(`Subtitle download failed (${result.status})`);
    return reply(toVtt(await result.text()), { headers: { "Content-Type": "text/vtt; charset=utf-8" } });
  } catch { return reply("Failed to convert subtitle", { status: 502 }); }
}

export async function handleRequest(request, env = {}, ctx = { waitUntil() {} }) {
  if (request.method === "OPTIONS") return reply(null, { status: 204 });
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET, OPTIONS" });
  switch (new URL(request.url).pathname) {
    case "/extract": return extract(request, env, ctx);
    case "/hls-proxy": return hlsProxy(request);
    case "/movie-subtitles": return movieSubtitles(request, env);
    case "/tv-subtitles": return tvSubtitles(request);
    case "/subtitle-proxy": return subtitleProxy(request);
    case "/watch": return watchPage(request);
    case "/convert": return convertPage(request);
    case "/": return json({
      name: "VidSrc Scraper API",
      endpoints: ["/extract", "/hls-proxy?url=https://…", "/watch?url=https://…", "/convert?url=https://…", "/movie-subtitles", "/tv-subtitles", "/subtitle-proxy"],
    });
    default: return json({ error: "Not found" }, 404);
  }
}

export default { fetch: handleRequest };
