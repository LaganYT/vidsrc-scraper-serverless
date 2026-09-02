function html(body, nonce) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'nonce-${nonce}'; media-src https: blob:; connect-src https:; img-src data:; worker-src blob: https://cdn.jsdelivr.net`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function sourceFrom(request) {
  const pageUrl = new URL(request.url);
  const raw = pageUrl.searchParams.get("url");
  if (!raw) throw new Error("Missing url query parameter");
  const source = new URL(raw);
  if (source.protocol !== "https:") throw new Error("Only HTTPS media URLs are allowed");
  if (source.origin === pageUrl.origin && source.pathname === "/hls-proxy") {
    for (const name of ["h", "t"]) {
      if (!source.searchParams.has(name) && pageUrl.searchParams.has(name)) {
        source.searchParams.set(name, pageUrl.searchParams.get(name));
      }
    }
  }
  return source.toString();
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const STYLE = `
  :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0b1020; color: #f5f7ff; }
  body { max-width: 960px; margin: 0 auto; padding: 32px 18px; }
  h1 { margin: 0 0 8px; font-size: 1.7rem; }
  p { color: #aeb8d4; line-height: 1.5; }
  video { width: 100%; max-height: 72vh; margin-top: 18px; background: #000; border-radius: 12px; }
  button, a.download { display: inline-block; border: 0; border-radius: 9px; padding: 11px 16px; background: #6d5dfc; color: white; font: inherit; text-decoration: none; cursor: pointer; }
  button:disabled { opacity: .55; cursor: wait; }
  progress { width: 100%; height: 16px; margin: 16px 0 8px; }
  #status { min-height: 1.5em; overflow-wrap: anywhere; }
  .warning { padding: 12px; border: 1px solid #714f1d; border-radius: 9px; background: #241b0c; color: #f3d49e; }
`;

export function watchPage(request) {
  let source;
  try { source = sourceFrom(request); }
  catch (error) { return new Response(error.message, { status: 400 }); }
  const pageUrl = new URL(request.url);
  const headersParam = pageUrl.searchParams.get("h") || "";
  const tokenParam = pageUrl.searchParams.get("t") || "";
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stream player</title><style nonce="${nonce}">${STYLE}</style></head>
  <body><h1>Stream player</h1><p id="status">Loading stream…</p><video id="player" controls playsinline preload="metadata"></video>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
  <script nonce="${nonce}">
    const originalSource = ${safeJson(source)};
    const forwardedHeaders = ${safeJson(headersParam)};
    const suppliedTokenUrl = ${safeJson(tokenParam)};
    const video = document.querySelector('#player');
    const status = document.querySelector('#status');
    const parsed = new URL(originalSource);
    const isProxyHls = parsed.origin === location.origin && parsed.pathname === '/hls-proxy';
    const isDirectProviderHls = !isProxyHls && parsed.pathname.includes('/pl/');
    const isHls = isProxyHls || isDirectProviderHls || /\\.m3u8(?:$|[?#])/i.test(parsed.pathname + parsed.search + parsed.hash);
    const nativeHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL'));

    function localProxyFor(url) {
      const proxy = new URL('/hls-proxy', location.origin);
      proxy.searchParams.set('url', url);
      if (forwardedHeaders) proxy.searchParams.set('h', forwardedHeaders);
      proxy.searchParams.set('t', suppliedTokenUrl || new URL('/generate.php', parsed.origin).toString());
      return proxy.toString();
    }

    function useNative(url, message) {
      video.src = url;
      status.textContent = message;
      video.addEventListener('loadedmetadata', () => {
        status.textContent = 'Stream metadata loaded. Starting playback…';
      }, { once: true });
      video.addEventListener('canplay', () => {
        status.textContent = 'Stream ready.';
      }, { once: true });
      video.addEventListener('playing', () => {
        status.textContent = 'Playing stream.';
      }, { once: true });
      video.addEventListener('error', () => {
        const code = video.error ? video.error.code : 0;
        status.textContent = 'Native playback failed' + (code ? ' (media error ' + code + ')' : '') + '.';
      }, { once: true });
    }

    function useHlsJs(url, message) {
      if (!(window.Hls && Hls.isSupported())) {
        status.textContent = 'This browser cannot play HLS.';
        return;
      }
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 6,
      });
      window.__hlsPlayer = hls;
      let networkRecoveries = 0;
      let mediaRecoveries = 0;
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        status.textContent = message;
        hls.loadSource(url);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        const count = data && data.levels ? data.levels.length : 0;
        status.textContent = count > 1 ? 'HLS stream ready (' + count + ' quality levels).' : 'HLS stream ready.';
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
          networkRecoveries += 1;
          status.textContent = 'Network error; retrying stream…';
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
          mediaRecoveries += 1;
          status.textContent = 'Media error; recovering playback…';
          hls.recoverMediaError();
          return;
        }
        const detail = data.details || (data.response && data.response.code ? 'HTTP ' + data.response.code : 'unknown HLS error');
        status.textContent = 'Playback failed: ' + detail;
        hls.destroy();
      });
      video.addEventListener('playing', () => {
        status.textContent = 'Playing HLS stream.';
      }, { once: true });
    }

    if (!isHls) {
      useNative(originalSource, 'Video stream ready.');
    } else if (isDirectProviderHls && nativeHls) {
      // Safari and other browsers with real native HLS can stay browser-to-CDN.
      useNative(originalSource, 'Using direct/native HLS playback.');
    } else if (isDirectProviderHls) {
      // Chromium/Firefox hls.js uses CORS XHR/fetch for media fragments. This
      // provider rejects those requests, so use the same-origin HLS proxy.
      useHlsJs(localProxyFor(originalSource), 'Loading HLS through compatibility proxy…');
    } else if (nativeHls) {
      useNative(originalSource, 'Using native HLS playback.');
    } else {
      useHlsJs(originalSource, 'Loading HLS manifest…');
    }

    window.addEventListener('pagehide', () => {
      if (window.__hlsPlayer) window.__hlsPlayer.destroy();
    }, { once: true });
  </script></body></html>`, nonce);
}

export function convertPage(request) {
  let source;
  try { source = sourceFrom(request); }
  catch (error) { return new Response(error.message, { status: 400 }); }
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HLS to MP4</title><style nonce="${nonce}">${STYLE}</style></head>
  <body><h1>HLS to MP4</h1><p class="warning">Conversion happens entirely in this browser. It only supports finite, unencrypted VOD playlists and requires the media host to allow CORS. Large videos may exceed browser memory. Only process media you are authorized to download.</p>
  <button id="convert">Convert to MP4</button><progress id="progress" value="0" max="1"></progress><p id="status">Ready.</p><a id="download" class="download" hidden download="video.mp4">Download MP4</a>
  <script nonce="${nonce}" type="module">
    import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
    import { toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';
    const source = ${safeJson(source)};
    const button = document.querySelector('#convert'), status = document.querySelector('#status');
    const progress = document.querySelector('#progress'), download = document.querySelector('#download');
    const ffmpeg = new FFmpeg();
    const absolute = (value, base) => new URL(value, base).toString();
    async function text(url) { const r = await fetch(url); if (!r.ok) throw new Error('Fetch failed (' + r.status + '): ' + url); return r.text(); }
    async function mediaPlaylist(url) {
      const manifest = await text(url); const lines = manifest.split(/\\r?\\n/);
      if (!lines.some(line => line.startsWith('#EXT-X-STREAM-INF'))) return { url, manifest };
      let best = null;
      for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bandwidth = Number(lines[i].match(/BANDWIDTH=(\\d+)/)?.[1] || 0);
        const uri = lines.slice(i + 1).find(line => line && !line.startsWith('#'));
        if (uri && (!best || bandwidth > best.bandwidth)) best = { bandwidth, url: absolute(uri, url) };
      }
      if (!best) throw new Error('No playable variant found in master playlist.');
      return { url: best.url, manifest: await text(best.url) };
    }
    async function run() {
      button.disabled = true; download.hidden = true;
      try {
        status.textContent = 'Loading ffmpeg.wasm…';
        const core = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
        await ffmpeg.load({ coreURL: await toBlobURL(core + '/ffmpeg-core.js', 'text/javascript'), wasmURL: await toBlobURL(core + '/ffmpeg-core.wasm', 'application/wasm') });
        const selected = await mediaPlaylist(source);
        if (!selected.manifest.includes('#EXT-X-ENDLIST')) throw new Error('Live/event playlists cannot be converted; an ended VOD playlist is required.');
        if (selected.manifest.includes('#EXT-X-KEY')) throw new Error('Encrypted HLS playlists are not supported by this browser converter.');
        const lines = selected.manifest.split(/\\r?\\n/), rewritten = []; const downloads = [];
        for (const line of lines) {
          const map = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/);
          if (map) {
            const name = 'init-' + downloads.length + '.mp4'; downloads.push({ name, url: absolute(map[1], selected.url) });
            rewritten.push(line.replace(map[1], name));
          } else if (line && !line.startsWith('#')) {
            const ext = new URL(absolute(line, selected.url)).pathname.match(/\\.[a-z0-9]+$/i)?.[0] || '.ts';
            const name = 'segment-' + downloads.length + ext; downloads.push({ name, url: absolute(line, selected.url) }); rewritten.push(name);
          } else rewritten.push(line);
        }
        await ffmpeg.writeFile('input.m3u8', new TextEncoder().encode(rewritten.join('\\n')));
        for (let i = 0; i < downloads.length; i++) {
          status.textContent = 'Downloading segment ' + (i + 1) + ' of ' + downloads.length + '…'; progress.value = downloads.length ? i / downloads.length : 0;
          const response = await fetch(downloads[i].url); if (!response.ok) throw new Error('Segment download failed (' + response.status + ')');
          await ffmpeg.writeFile(downloads[i].name, new Uint8Array(await response.arrayBuffer()));
        }
        status.textContent = 'Remuxing to MP4…'; progress.removeAttribute('value');
        const code = await ffmpeg.exec(['-allowed_extensions', 'ALL', '-i', 'input.m3u8', '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
        if (code !== 0) throw new Error('FFmpeg could not remux this stream (exit ' + code + ').');
        const data = await ffmpeg.readFile('output.mp4'); download.href = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        download.hidden = false; progress.value = 1; status.textContent = 'Conversion complete.';
      } catch (error) { progress.value = 0; status.textContent = 'Conversion failed: ' + error.message; }
      finally { button.disabled = false; }
    }
    button.addEventListener('click', run);
  </script></body></html>`, nonce);
}
