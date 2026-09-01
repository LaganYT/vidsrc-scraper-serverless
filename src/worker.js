import { launch } from "@cloudflare/playwright";
import { getTVSubtitleVTT } from "./tv-subtitles.js";

const PROVIDERS = ["https://vidsrc2.ru", "https://vidsrc.ir", "https://vidsrcme.ru", "https://vidsrcme.su", "https://vidsrc-me.ru", "https://vidsrc.me", "https://vidsrc.io", "https://vidsrc.tw"];
const LANGUAGE_NAMES = { en: "English" };
const COMMON_LANGUAGES = new Set(Object.keys(LANGUAGE_NAMES));
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

function reply(body, init = {}) {
  const headers = new Headers(init.headers);
  Object.entries(CORS).forEach(([key, value]) => headers.set(key, value));
  return new Response(body, { ...init, headers });
}
function json(data, status = 200, headers = {}) {
  return reply(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
function message(error) { return error instanceof Error ? error.message : String(error); }
function isSubtitle(url) { return /\.(vtt|srt)(\?.*)?$/i.test(url) || url.includes(".vtt") || url.includes(".srt"); }

async function scrapeProvider(browser, domain, target) {
  const context = await browser.newContext({ userAgent: USER_AGENT, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let hlsUrl = null;
  const subtitles = new Set();
  const inspect = (url) => {
    if (!hlsUrl && url.includes(".m3u8")) hlsUrl = url;
    if (isSubtitle(url)) subtitles.add(url);
  };

  try {
    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      inspect(requestUrl);

      // The provider mirrors intentionally navigate CDP-controlled pages to
      // about:blank from this asset, before the player iframe can be created.
      if (/\/assets\/disable-devtool(?:\.min)?\.js(?:\?|$)/i.test(requestUrl)) {
        await route.abort();
        return;
      }

      await route.continue();
    });
    page.on("request", (request) => inspect(request.url()));
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const frame = await page.waitForSelector("#the_frame", { timeout: 10_000 });
    const box = await frame.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    else await frame.click({ force: true });
    await page.waitForTimeout(7_000);
    if (!hlsUrl) await page.waitForResponse((item) => item.url().includes(".m3u8"), { timeout: 5_000 }).catch(() => undefined);
    if (subtitles.size === 0) await page.waitForTimeout(5_000);
    if (!hlsUrl) throw new Error("HLS URL not found");
    return { hls_url: hlsUrl, subtitles: [...subtitles], error: null };
  } catch (error) {
    console.error(`[${domain}] ${message(error)}`);
    return { hls_url: null, subtitles: [], error: message(error) };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function mapLimited(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) { const index = next++; results[index] = await mapper(items[index]); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
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

  const key = new Request(url.toString());
  const cached = await caches.default.match(key);
  if (cached) return reply(cached.body, { status: cached.status, headers: cached.headers });

  let browser;
  try {
    browser = await launch(env.BROWSER);
    const targets = PROVIDERS.map((domain) => [domain, type === "tv"
      ? `${domain}/embed/tv?tmdb=${encodeURIComponent(tmdbId)}&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`
      : `${domain}/embed/movie/${encodeURIComponent(tmdbId)}`]);
    const pairs = await mapLimited(targets, 2, async ([domain, target]) => [domain, await scrapeProvider(browser, domain, target)]);
    const results = Object.fromEntries(pairs);
    const output = json({ success: Object.values(results).some((item) => item.hls_url), results }, 200, { "Cache-Control": "public, max-age=900" });
    ctx.waitUntil(caches.default.put(key, output.clone()));
    return output;
  } catch (error) {
    return json({ success: false, error: message(error), results: {} }, 500);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
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

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return reply(null, { status: 204 });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET, OPTIONS" });
    switch (new URL(request.url).pathname) {
      case "/extract": return extract(request, env, ctx);
      case "/movie-subtitles": return movieSubtitles(request, env);
      case "/tv-subtitles": return tvSubtitles(request);
      case "/subtitle-proxy": return subtitleProxy(request);
      case "/": return reply("VidSrc Scraper API is running on Cloudflare Workers.");
      default: return json({ error: "Not found" }, 404);
    }
  },
};
