import { supabase } from "./supabase.js";

/** Library reads are shared with authenticated users. Keep this policy common
 * to the Library and Jack; resource IDs and uploader identity grant no access.
 * Mutation ownership is deliberately enforced separately by the write routes.
 */
export function readableVideos(userId: string | undefined) {
  if (!userId?.trim()) throw new Error("Authenticated Library access required");
  return supabase.from("videos");
}
