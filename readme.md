# Video Stream Extractor API — Cloudflare Workers or Vercel

A serverless API for Cloudflare Workers or Vercel that extracts HLS (`.m3u8`) URLs from VidSrc using ordinary HTTP requests and JavaScript. It does not launch Chromium or use Cloudflare Browser Run.

## Changes in this version

- Replaces browser automation with a request to the provider's stream-data API.
- Reads the short-lived decryptor metadata returned by that API and performs the compatible ChaCha20 operation in JavaScript, without compiling WebAssembly at runtime.
- Replaces the process-local cache with Cloudflare's Cache API (15-minute TTL).
- Replaces Node-only TV subtitle ZIP handling with Worker-compatible Web APIs and `fflate`.
- Preserves CORS, the provider-keyed extraction response, and all existing proxy/subtitle/media-page routes.

## Setup

Requirements: a Cloudflare or Vercel account, Node.js 18+, and pnpm. Browser Run is not required.

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

The `nodejs_compat` flag and compatibility date are configured in `wrangler.jsonc`.

### Deploy to Vercel

Import the repository into Vercel, select the `feat/fetch-only-extractor` branch,
and deploy with the default project settings. `vercel.json` routes every public
endpoint through the Node.js function in `api/index.js`; no build command or
output directory is required.

The extraction and proxy endpoints need no environment variables. To enable
`/movie-subtitles`, add `TMDB_API_KEY` and `OPENSUB_API_KEY` in the Vercel
project's Environment Variables settings.

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

Extraction uses regular Worker subrequests and JavaScript, so it does not consume Browser Run minutes or require runtime WebAssembly compilation. The upstream stream-data API and its decryptor metadata are provider-controlled and may change independently.

Make sure your deployment and use comply with provider terms and applicable copyright laws.
