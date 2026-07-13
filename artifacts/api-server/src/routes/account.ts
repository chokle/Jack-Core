import { Router } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { supabase } from "../lib/supabase.js";
import { removeGraphSafe } from "../lib/jobs.js";
import { withdrawMentor } from "../lib/memory-graph.js";

const router = Router();

/**
 * Permanently removes the authenticated customer's account and personally
 * attributable app data. Clerk is deliberately last: if a data cleanup step
 * fails, the account remains available so the customer can retry safely.
 */
router.delete("/account", async (req, res) => {
  try {
    let userId: string | null | undefined;
    try {
      userId = getAuth(req)?.userId;
    } catch {
      userId = null;
    }
    if (!userId) return res.status(401).json({ error: "Sign in is required to delete an account." });

    const { data: videos, error: videoReadError } = await supabase
      .from("videos")
      .select("id")
      .eq("uploader_user_id", userId);
    if (videoReadError) throw videoReadError;
    for (const row of videos ?? []) {
      const id = (row as Record<string, unknown>)["id"];
      if (typeof id === "string") await removeGraphSafe(id);
    }
    const { error: videoDeleteError } = await supabase.from("videos").delete().eq("uploader_user_id", userId);
    if (videoDeleteError) throw videoDeleteError;

    const { data: mentors, error: mentorReadError } = await supabase
      .from("mentor_profiles")
      .select("id")
      .eq("contributor_user_id", userId);
    if (mentorReadError) throw mentorReadError;
    for (const row of mentors ?? []) {
      const id = (row as Record<string, unknown>)["id"];
      if (typeof id === "string") await withdrawMentor(id);
    }

    const { data: chats, error: chatReadError } = await supabase
      .from("chat_messages")
      .select("session_id")
      .eq("user_id", userId);
    if (chatReadError) throw chatReadError;
    const sessionIds = [...new Set((chats ?? []).map((row) => (row as Record<string, unknown>)["session_id"]).filter((id): id is string => typeof id === "string"))];
    if (sessionIds.length > 0) {
      const { error } = await supabase.from("parked_thoughts").delete().in("chat_session_id", sessionIds);
      if (error) throw error;
    }
    const { error: chatDeleteError } = await supabase.from("chat_messages").delete().eq("user_id", userId);
    if (chatDeleteError) throw chatDeleteError;

    const { data: recordings, error: recordingReadError } = await supabase
      .from("test_recordings")
      .select("storage_path")
      .eq("tester_user_id", userId);
    if (recordingReadError) throw recordingReadError;
    const paths = (recordings ?? []).map((row) => (row as Record<string, unknown>)["storage_path"]).filter((path): path is string => typeof path === "string");
    if (paths.length > 0) {
      const { error } = await supabase.storage.from("jack-test-recordings").remove(paths);
      if (error) throw error;
    }
    const { error: recordingDeleteError } = await supabase.from("test_recordings").delete().eq("tester_user_id", userId);
    if (recordingDeleteError) throw recordingDeleteError;

    await clerkClient.users.deleteUser(userId);
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "deleteAccount error");
    return res.status(500).json({ error: "Couldn't delete your account. Nothing was removed from your sign-in until cleanup completes." });
  }
});

export default router;
