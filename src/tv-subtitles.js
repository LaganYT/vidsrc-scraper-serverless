import { unzipSync } from "fflate";

const BASE = "https://www.tvsubtitles.net";
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.5" };
const clean = (value) => value.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

async function text(url, init) {
  const result = await fetch(url, init);
  if (!result.ok) throw new Error(`Request failed (${result.status}) for ${url}`);
  return result.text();
}
async function findShow(title) {
  const html = await text(`${BASE}/search.php`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ qs: title }) });
  const links = [...html.matchAll(/<a\b[^>]*href=["'](?:\/)?tvshow-(\d+)\.html["'][^>]*>([\s\S]*?)<\/a>/gi)];
  return links.find((match) => clean(match[2]).toLowerCase().includes(title.toLowerCase()))?.[1] || null;
}
async function findEpisode(showId, season, episode) {
  const html = await text(`${BASE}/tvshow-${showId}-${season}.html`, { headers: HEADERS });
  const wanted = `${Number(season)}x${Number(episode)}`;
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    if (!clean(row).includes(wanted)) continue;
    const match = row.match(/href=["'](?:\/)?episode-(\d+)\.html["']/i);
    if (match) return match[1];
  }
  return null;
}
async function subtitleMeta(episodeId) {
  const html = await text(`${BASE}/episode-${episodeId}-en.html`, { headers: HEADERS });
  const anchor = html.match(/<a\b[^>]*href=["'](?:\/)?subtitle-(\d+)\.html["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!anchor) return null;
  const heading = anchor[2].match(/<h5\b[^>]*>([\s\S]*?)<\/h5>/i)?.[1] || anchor[2];
  return { id: anchor[1], title: clean(heading) };
}
async function filename(id) {
  const html = await text(`${BASE}/subtitle-${id}.html`, { headers: HEADERS });
  const match = html.match(/<div\b[^>]*>\s*Filename:\s*<\/div>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i);
  return match ? clean(match[1]) : null;
}
function releaseFromFilename(value) {
  const parts = (value.split(" - ")[2] || "").replace(/\.en\.srt$|\.srt$/i, "").trim().split(".");
  const index = parts.findIndex((part) => /\d{3,4}p/i.test(part));
  if (index >= 0) {
    const [resolution, rip, group] = parts.slice(index);
    return group ? `${resolution} ${rip}.${group}` : [resolution, rip].filter(Boolean).join(" ");
  }
  return parts.slice(-2).join(".");
}
function zipUrl(title) {
  const value = title.replace(/[()]/g, "").trim();
  const match = value.match(/^(.+?)\s+(\d+x\d+)\s+(.+)$/);
  const name = match ? `${match[1]}_${match[2]}_${match[3]}.en.zip` : `${value.replace(/\s+/g, "_")}.en.zip`;
  return `${BASE}/files/${encodeURIComponent(name)}`;
}
async function download(url) {
  const result = await fetch(url);
  if (!result.ok) throw new Error(`Subtitle ZIP download failed (${result.status})`);
  const files = unzipSync(new Uint8Array(await result.arrayBuffer()));
  const entry = Object.entries(files).find(([name]) => name.toLowerCase().endsWith(".srt"));
  if (!entry) throw new Error("No .srt file found in ZIP");
  const srt = new TextDecoder().decode(entry[1]);
  return "WEBVTT\n\n" + srt.replace(/^\uFEFF/, "").replace(/\r+/g, "").trim().replace(/(\d{2}:\d{2}:\d{2})[,.](\d{3})/g, "$1.$2");
}

export async function getTVSubtitleVTT(title, season, episode) {
  const showId = await findShow(title);
  if (!showId) return null;
  const episodeId = await findEpisode(showId, season, episode);
  if (!episodeId) return null;
  const meta = await subtitleMeta(episodeId);
  if (!meta) return null;
  let finalTitle = meta.title;
  const actual = await filename(meta.id).catch(() => null);
  const release = actual ? releaseFromFilename(actual) : null;
  if (release && /\([^)]+\)/.test(finalTitle)) finalTitle = finalTitle.replace(/\([^)]+\)/, `(${release})`);
  return download(zipUrl(finalTitle));
}
