# Video Stream Extractor API — Cloudflare Workers

A serverless Cloudflare Worker that extracts HLS (`.m3u8`) and subtitle URLs from VidSrc provider pages using [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/playwright/).

## Changes in this version

- Replaces Express and local Chromium with a Worker `fetch()` handler and `@cloudflare/playwright`.
- Uses one Browser Run session per extraction and two isolated browser contexts at a time.
- Replaces the process-local cache with Cloudflare's Cache API (15-minute TTL).
- Replaces Node-only TV subtitle ZIP handling with Worker-compatible Web APIs and `fflate`.
- Preserves CORS and the extraction/subtitle routes, and adds browser-based `/watch` and `/convert` tools.
- Closes browser sessions and contexts in `finally` blocks to prevent leaked Browser Run usage.

## Setup

Requirements: a Cloudflare account with Browser Run enabled, Node.js 18+, and pnpm.

```bash
git clone https://github.com/LaganYT/vidsrc-scraper.git
cd vidsrc-scraper
pnpm install
cp .dev.vars.example .dev.vars
```

The Worker does not require any API keys for `/extract`, `/tv-subtitles`, or
`/subtitle-proxy`. To enable the optional `/movie-subtitles` endpoint, add the
keys to `.dev.vars` and create the matching production secrets:

```bash
pnpm wrangler secret put TMDB_API_KEY
pnpm wrangler secret put OPENSUB_API_KEY
```

Without these secrets, `/movie-subtitles` returns a `501` configuration response
while every other endpoint continues to work normally.

## Develop, validate, and deploy

```bash
pnpm dev
pnpm check
pnpm deploy
```

`pnpm dev` uses a remote Browser Run binding. The browser binding, `nodejs_compat` flag, and compatibility date are configured in `wrangler.jsonc`.

## API

### Extract streams

```http
GET /extract?tmdb_id=550&type=movie
GET /extract?tmdb_id=1399&type=tv&season=1&episode=1
```

Results retain the original provider-keyed response format and are cached for 15 minutes by full request URL.

### Watch an HLS or MP4 stream

```http
GET /watch?url=https%3A%2F%2Fexample.com%2Fstream.m3u8
GET /watch?url=https%3A%2F%2Fexample.com%2Fvideo.mp4
```

The player uses native MP4/HLS playback when available and falls back to
`hls.js` for HLS. The media host must allow browser playback and CORS.

### Convert HLS to MP4

```http
GET /convert?url=https%3A%2F%2Fexample.com%2Fstream.m3u8
```

This opens a page that downloads the HLS segments and remuxes them to MP4 with
`ffmpeg.wasm` in the visitor's browser. The Worker does not proxy or store the
video. The converter supports finite, unencrypted VOD playlists; live streams,
encrypted playlists, very large videos, and sources without CORS are rejected
or may fail in the browser. Use it only for media you are authorized to process.

### Movie subtitles

```http
GET /movie-subtitles?tmdb_id=550&type=movie
```

### TV subtitles

```http
GET /tv-subtitles?title=Example&type=tv&season=1&episode=1
```

### Convert SRT to VTT

```http
GET /subtitle-proxy?url=https%3A%2F%2Fexample.com%2Fsubtitle.srt
```

Only HTTPS source URLs are accepted.

## Cloudflare usage

Extraction is browser-intensive. Cloudflare's free plan has limited daily Browser Run time and browser-acquisition limits. This Worker shares one browser across provider contexts to minimize launches, but production traffic may require a paid Workers plan.

Make sure your deployment and use comply with provider terms and applicable copyright laws.
