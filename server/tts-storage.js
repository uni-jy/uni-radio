import fs from "node:fs";
import { supabaseStorage } from "./supabase-storage.js";

const TTS_PREFIX = "tts";

function isSafeTtsName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mp3|m4a|wav)$/i.test(name || "");
}

function contentTypeForTtsName(name) {
  if (/\.m4a$/i.test(name)) return "audio/mp4";
  if (/\.wav$/i.test(name)) return "audio/wav";
  return "audio/mpeg";
}

async function streamToBuffer(stream) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

export function createTtsStorage({
  enabled = supabaseStorage.enabled,
  get = supabaseStorage.get,
  put = supabaseStorage.put,
} = {}) {
  async function persistTtsFile(name, file) {
    if (!enabled) return { enabled: false, stored: false };
    if (!isSafeTtsName(name)) return { enabled: true, stored: false };
    const body = fs.readFileSync(file);
    await put(`${TTS_PREFIX}/${name}`, body, {
      access: "private",
      allowOverwrite: true,
      contentType: contentTypeForTtsName(name),
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
    return { enabled: true, stored: true, bytes: body.length };
  }

  async function readTtsFile(name) {
    if (!enabled || !isSafeTtsName(name)) return null;
    const result = await get(`${TTS_PREFIX}/${name}`, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return {
      buffer: await streamToBuffer(result.stream),
      contentType: result.contentType || contentTypeForTtsName(name),
    };
  }

  return { persistTtsFile, readTtsFile };
}

const defaultStorage = createTtsStorage();

export const persistTtsFile = defaultStorage.persistTtsFile;
export const readTtsFile = defaultStorage.readTtsFile;
