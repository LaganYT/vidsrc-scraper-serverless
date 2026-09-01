const API_BASE = "https://data.vidsrcme.ru";
const PLAYER_ORIGIN = "https://cloudorchestranova.com";

const wasmCache = new Map();

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function getWasmModule(vs, headers) {
  if (!vs || typeof vs.w !== "number") throw new Error("Invalid stream decryptor metadata");
  if (wasmCache.has(vs.w)) return wasmCache.get(vs.w);

  const pending = (async () => {
    let bytes;
    if (vs.wasm_url) {
      const response = await fetch(vs.wasm_url, { headers });
      if (!response.ok) throw new Error(`Decryptor fetch failed (${response.status})`);
      bytes = await response.arrayBuffer();
    } else if (vs.wasm) {
      bytes = decodeBase64(vs.wasm).buffer;
    } else {
      throw new Error("Stream API did not provide a decryptor");
    }
    return WebAssembly.compile(bytes);
  })();

  wasmCache.set(vs.w, pending);
  pending.catch(() => wasmCache.delete(vs.w));
  return pending;
}

async function decryptStreamUrls(encrypted, vs, headers) {
  const module = await getWasmModule(vs, headers);
  const instance = await WebAssembly.instantiate(module, {});
  const { alloc, decrypt, memory } = instance.exports;
  if (typeof alloc !== "function" || typeof decrypt !== "function" || !(memory instanceof WebAssembly.Memory)) {
    throw new Error("Decryptor has an unsupported interface");
  }

  const bytes = decodeBase64(encrypted);
  const pointer = alloc(bytes.length);
  new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
  const outputLength = decrypt(pointer, bytes.length);
  const plaintext = new TextDecoder().decode(new Uint8Array(memory.buffer, pointer + 12, outputLength));
  return plaintext.split("\n").map((value) => value.trim()).filter(Boolean);
}

function normalizeStreams(values) {
  return values.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (/\.m3u8(?:$|\?)/i.test(value) || /\.mp4(?:$|\?)/i.test(value));
    } catch {
      return false;
    }
  });
}

export async function extractStreams({ tmdbId, type, season, episode, userAgent }) {
  const params = new URLSearchParams({ type, tmdb: tmdbId });
  params.set("stream_urls", "");
  if (type === "tv") {
    params.set("season", season);
    params.set("episode", episode);
  }

  const headers = {
    Accept: "application/json",
    Referer: `${PLAYER_ORIGIN}/`,
    "User-Agent": userAgent,
  };
  const response = await fetch(`${API_BASE}/api.php?${params}`, { headers });
  if (!response.ok) throw new Error(`Stream API request failed (${response.status})`);

  const payload = await response.json();
  if (payload?.status_code !== "200" || !payload.data) {
    throw new Error(`Stream API returned status ${payload?.status_code || "unknown"}`);
  }

  let streams;
  if (Array.isArray(payload.data.stream_urls)) {
    streams = payload.data.stream_urls;
  } else if (typeof payload.data.stream_urls === "string" && payload.data.stream_urls && payload.vs) {
    streams = await decryptStreamUrls(payload.data.stream_urls, payload.vs, headers);
  } else {
    throw new Error("Stream API response did not contain stream URLs");
  }

  streams = normalizeStreams(streams);
  if (streams.length === 0) throw new Error("No supported stream URL was returned");
  return {
    streams,
    headers: {
      Referer: `${PLAYER_ORIGIN}/`,
      Origin: PLAYER_ORIGIN,
      "User-Agent": userAgent,
    },
    token_url: payload.data.gen_token_url || null,
  };
}

export function extractionError(error) {
  return { hls_url: null, subtitles: [], error: message(error) };
}
