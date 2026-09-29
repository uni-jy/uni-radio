import fs from "node:fs";
import path from "node:path";
import { USERS_DIR } from "./paths.js";
import { supabaseStorage } from "./supabase-storage.js";

const USER_PREFIX = "users";

function isSafeRelativePath(value) {
  if (!value || value.startsWith("/") || value.includes("\\")) return false;
  return !value.split("/").some((part) => part === ".." || part === "");
}

function userDir(uid) {
  return path.join(USERS_DIR, uid);
}

function userBlobPrefix(uid) {
  return `${USER_PREFIX}/${uid}/`;
}

async function readStorageText(objectPath, { get, fetcher, object }) {
  if (get) {
    const result = await get(objectPath, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return new Response(result.stream).text();
  }
  const response = await fetcher?.(object?.downloadUrl || object?.url);
  if (!response?.ok) throw new Error(`storage fetch failed: ${response?.status || "unknown"}`);
  return response.text();
}

function walkFiles(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkFiles(abs);
      if (!entry.isFile()) return [];
      return [abs];
    });
  } catch {
    return [];
  }
}

export function createUserStorage({
  enabled = supabaseStorage.enabled,
  list = supabaseStorage.list,
  put = supabaseStorage.put,
  get = supabaseStorage.get,
  fetcher = fetch,
} = {}) {
  async function hydrateUserFiles(uid) {
    if (!enabled) return { enabled: false, files: 0 };
    const prefix = userBlobPrefix(uid);
    let offset = 0;
    let files = 0;
    while (true) {
      const listed = await list({ prefix, offset, limit: 1000 });
      const objects = Array.isArray(listed) ? listed : (listed?.blobs || []);
      for (const object of objects) {
        const name = String(object.name || object.pathname || "");
        const objectPath = name.startsWith(prefix) ? name : `${prefix}${name}`;
        const rel = objectPath.slice(prefix.length);
        if (!isSafeRelativePath(rel)) continue;
        const text = await readStorageText(objectPath, { get, fetcher, object });
        if (text == null) continue;
        const abs = path.join(userDir(uid), rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text, "utf8");
        files += 1;
      }
      if (objects.length < 1000) break;
      offset += objects.length;
    }
    return { enabled: true, files };
  }

  async function persistUserFiles(uid) {
    if (!enabled) return { enabled: false, files: 0 };
    const dir = userDir(uid);
    const files = walkFiles(dir);
    for (const abs of files) {
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      if (!isSafeRelativePath(rel)) continue;
      await put(`${userBlobPrefix(uid)}${rel}`, fs.readFileSync(abs), {
        access: "private",
        allowOverwrite: true,
        contentType: "text/plain; charset=utf-8",
        cacheControlMaxAge: 60,
      });
    }
    return { enabled: true, files: files.length };
  }

  return { hydrateUserFiles, persistUserFiles };
}

const defaultStorage = createUserStorage();

export const hydrateUserFiles = defaultStorage.hydrateUserFiles;
export const persistUserFiles = defaultStorage.persistUserFiles;
