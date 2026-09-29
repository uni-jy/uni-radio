import path from "node:path";

const DEFAULT_BUCKET = "unico-data";

function configFromEnv() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET;
  return { url, key, bucket, enabled: !!(url && key) };
}

function safePath(value) {
  const raw = String(value || "");
  if (!raw || raw.startsWith("/") || raw.includes("\\")) throw new Error("unsafe storage path");
  if (raw.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe storage path");
  return raw;
}

function encodePath(value) {
  return safePath(value).split("/").map(encodeURIComponent).join("/");
}

export function createSupabaseStorage({
  url = configFromEnv().url,
  key = configFromEnv().key,
  bucket = configFromEnv().bucket,
  fetcher = fetch,
} = {}) {
  const base = String(url || "").replace(/\/+$/, "");
  const enabled = !!(base && key);
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };

  async function request(endpoint, init = {}) {
    const response = await fetcher(`${base}${endpoint}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Supabase Storage ${response.status}: ${body.slice(0, 240)}`);
    }
    return response;
  }

  async function list({ prefix = "", offset = 0, limit = 1000 } = {}) {
    safePath(prefix.replace(/\/$/, "") || "root");
    const response = await request(`/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, offset, limit, sortBy: { column: "name", order: "asc" } }),
    });
    const objects = await response.json();
    return Array.isArray(objects) ? objects : [];
  }

  async function get(objectPath) {
    const response = await request(`/storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`);
    return {
      statusCode: response.status,
      stream: response.body,
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
  }

  async function put(objectPath, body, options = "application/octet-stream") {
    const contentType = typeof options === "string"
      ? options
      : (options?.contentType || "application/octet-stream");
    await request(`/storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`, {
      method: "POST",
      headers: { "Content-Type": contentType, "x-upsert": "true" },
      body,
    });
    return true;
  }

  return { enabled, bucket, list, get, put };
}

export const supabaseStorage = createSupabaseStorage();
