import { supabase } from "./supabase.js";

const BUCKET = "jack-videos";
const PUBLIC_PREFIX = `/storage/v1/object/public/${BUCKET}/`;

function storagePath(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const path = new URL(value).pathname;
    const index = path.indexOf(PUBLIC_PREFIX);
    return index >= 0 ? decodeURIComponent(path.slice(index + PUBLIC_PREFIX.length)) : null;
  } catch {
    return null;
  }
}

/** Remove the public media objects belonging to one or more video rows. */
export async function removeVideoAssets(rows: Array<Record<string, unknown>>): Promise<void> {
  const paths = [...new Set(rows.flatMap((row) => [storagePath(row["video_url"]), storagePath(row["thumbnail_url"])]).filter((path): path is string => Boolean(path)))];
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) throw error;
}
