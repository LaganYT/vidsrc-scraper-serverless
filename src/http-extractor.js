const API_BASE = "https://data.vidsrcme.ru";
const PLAYER_ORIGIN = "https://cloudorchestranova.com";

const decryptorCache = new Map();

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function readUleb(bytes, cursor) {
  let value = 0;
  let shift = 0;
  while (true) {
    if (cursor.offset >= bytes.length || shift > 35) throw new Error("Invalid decryptor encoding");
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
}

function readSleb(bytes, cursor) {
  let value = 0;
  let shift = 0;
  let byte;
  do {
    if (cursor.offset >= bytes.length || shift > 35) throw new Error("Invalid decryptor encoding");
    byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && (byte & 0x40)) value -= 2 ** shift;
  return value;
}

function readOffsetExpression(bytes, cursor) {
  if (bytes[cursor.offset++] !== 0x41) throw new Error("Unsupported decryptor data offset");
  const offset = readSleb(bytes, cursor);
  if (bytes[cursor.offset++] !== 0x0b || offset < 0) throw new Error("Invalid decryptor data offset");
  return offset;
}

function readDataSegments(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("Invalid decryptor file");
  }

  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const sectionId = bytes[cursor.offset++];
    const sectionLength = readUleb(bytes, cursor);
    const sectionEnd = cursor.offset + sectionLength;
    if (sectionEnd > bytes.length) throw new Error("Invalid decryptor section");
    if (sectionId !== 11) {
      cursor.offset = sectionEnd;
      continue;
    }

    const segments = [];
    const count = readUleb(bytes, cursor);
    for (let index = 0; index < count; index++) {
      const flags = readUleb(bytes, cursor);
      let offset = null;
      if (flags === 0) {
        offset = readOffsetExpression(bytes, cursor);
      } else if (flags === 1) {
        // A passive segment cannot contain either half of the initialized key.
      } else if (flags === 2) {
        if (readUleb(bytes, cursor) !== 0) throw new Error("Unsupported decryptor memory index");
        offset = readOffsetExpression(bytes, cursor);
      } else {
        throw new Error("Unsupported decryptor data segment");
      }
      const length = readUleb(bytes, cursor);
      const end = cursor.offset + length;
      if (end > sectionEnd) throw new Error("Invalid decryptor data segment");
      if (offset !== null && length >= 32) segments.push({ offset, data: bytes.slice(cursor.offset, end) });
      cursor.offset = end;
    }
    return segments;
  }
  throw new Error("Decryptor has no data section");
}

function rotateLeft(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function quarterRound(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotateLeft(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotateLeft(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotateLeft(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotateLeft(state[b] ^ state[c], 7);
}

function readWord(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function chachaBlock(key, nonce, counter) {
  const initial = new Uint32Array(16);
  initial.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let index = 0; index < 8; index++) initial[4 + index] = readWord(key, index * 4);
  initial[12] = counter;
  for (let index = 0; index < 3; index++) initial[13 + index] = readWord(nonce, index * 4);

  const state = new Uint32Array(initial);
  for (let round = 0; round < 10; round++) {
    quarterRound(state, 0, 4, 8, 12);
    quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14);
    quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15);
    quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13);
    quarterRound(state, 3, 4, 9, 14);
  }

  const output = new Uint8Array(64);
  for (let index = 0; index < 16; index++) {
    const word = (state[index] + initial[index]) >>> 0;
    output[index * 4] = word;
    output[index * 4 + 1] = word >>> 8;
    output[index * 4 + 2] = word >>> 16;
    output[index * 4 + 3] = word >>> 24;
  }
  return output;
}

function decryptChacha(encrypted, key) {
  if (encrypted.length < 13) return new Uint8Array();
  const nonce = encrypted.subarray(0, 12);
  const ciphertext = encrypted.subarray(12);
  const plaintext = new Uint8Array(ciphertext.length);
  for (let offset = 0, counter = 0; offset < ciphertext.length; offset += 64, counter++) {
    const block = chachaBlock(key, nonce, counter);
    const length = Math.min(64, ciphertext.length - offset);
    for (let index = 0; index < length; index++) plaintext[offset + index] = ciphertext[offset + index] ^ block[index];
  }
  return plaintext;
}

function startsWithHttps(bytes) {
  const prefix = [0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f];
  return prefix.every((byte, index) => bytes[index] === byte);
}

function findDecryptorKey(wasmBytes, encrypted) {
  const segments = readDataSegments(wasmBytes);
  for (const left of segments) {
    for (const right of segments) {
      const key = new Uint8Array(32);
      for (let index = 0; index < key.length; index++) key[index] = left.data[index] ^ right.data[index];
      if (startsWithHttps(decryptChacha(encrypted.subarray(0, Math.min(encrypted.length, 44)), key))) return key;
    }
  }
  throw new Error("Decryptor key layout is unsupported");
}

async function getDecryptorKey(vs, headers, encrypted) {
  if (!vs || typeof vs.w !== "number") throw new Error("Invalid stream decryptor metadata");
  if (decryptorCache.has(vs.w)) return decryptorCache.get(vs.w);

  const pending = (async () => {
    let bytes;
    if (vs.wasm_url) {
      const response = await fetch(vs.wasm_url, { headers });
      if (!response.ok) throw new Error(`Decryptor fetch failed (${response.status})`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } else if (vs.wasm) {
      bytes = decodeBase64(vs.wasm);
    } else {
      throw new Error("Stream API did not provide a decryptor");
    }
    return findDecryptorKey(bytes, encrypted);
  })();

  decryptorCache.set(vs.w, pending);
  pending.catch(() => decryptorCache.delete(vs.w));
  return pending;
}

async function decryptStreamUrls(encrypted, vs, headers) {
  const bytes = decodeBase64(encrypted);
  const key = await getDecryptorKey(vs, headers, bytes);
  const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(decryptChacha(bytes, key));
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
