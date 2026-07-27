import { Router } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { supabase } from "../lib/supabase.js";
import { removeGraphSafe } from "../lib/jobs.js";
import { withdrawMentor } from "../lib/memory-graph.js";
import { removeVideoAssets } from "../lib/video-storage.js";

const router = Router();
const RECORDING_DELETE_BATCH_SIZE = 500;

async function deleteAccountRecordings(userId: string): Promise<void> {
  while (true) {
    const { data: recordings, error: recordingReadError } = await supabase
      .from("test_recordings")
      .select("id,storage_path")
      .eq("tester_user_id", userId)
      .limit(RECORDING_DELETE_BATCH_SIZE);
    if (recordingReadError) throw recordingReadError;
    if (!recordings || recordings.length === 0) return;

    const paths = recordings
      .map((row) => (row as Record<string, unknown>)["storage_path"])
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    if (paths.length > 0) {
      const { error } = await supabase.storage.from("jack-test-recordings").remove(paths);
      if (error) throw error;
    }

    const ids = recordings
      .map((row) => (row as Record<string, unknown>)["id"])
      .filter((id): id is string => typeof id === "string");
    if (ids.length === 0) {
      throw new Error("Recording rows are missing identifiers required for safe deletion.");
    }
    const { error: recordingDeleteError } = await supabase
      .from("test_recordings")
      .delete()
      .in("id", ids);
    if (recordingDeleteError) throw recordingDeleteError;
  }
}

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
      .select("id, video_url, thumbnail_url")
      .eq("uploader_user_id", userId);
    if (videoReadError) throw videoReadError;
    for (const row of videos ?? []) {
      const id = (row as Record<string, unknown>)["id"];
      if (typeof id === "string") await removeGraphSafe(id);
    }
    await removeVideoAssets((videos ?? []) as Array<Record<string, unknown>>);
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

    await deleteAccountRecordings(userId);
    const { error: feedbackDeleteError } = await supabase.from("test_feedback").delete().eq("tester_user_id", userId);
    if (feedbackDeleteError) throw feedbackDeleteError;

    // Pilot activity is first-party account data. Delete attributable raw
    // events, failures, sessions, consent history, memberships, and report
    // requests before removing the Clerk identity. Aggregate snapshots contain
    // no participant identity and may remain only in genuinely de-identified form.
    const attributableDeletes = [
      supabase.from("activity_ingest_failures").delete().eq("actor_user_id", userId),
      supabase.from("test_events").delete().eq("actor_user_id", userId),
      supabase.from("activity_report_runs").delete().eq("requested_by_user_id", userId),
      supabase.from("admin_access_audit").delete().eq("actor_user_id", userId),
      supabase.from("admin_access_audit").delete().eq("target_user_id", userId),
    ];
    for (const pending of attributableDeletes) {
      const { error } = await pending;
      if (error) throw error;
    }
    const { error: sessionDeleteError } = await supabase
      .from("test_sessions")
      .delete()
      .eq("actor_user_id", userId);
    if (sessionDeleteError) throw sessionDeleteError;
    const { error: consentDeleteError } = await supabase
      .from("telemetry_consents")
      .delete()
      .eq("actor_user_id", userId);
    if (consentDeleteError) throw consentDeleteError;
    const { error: membershipDeleteError } = await supabase
      .from("pilot_memberships")
      .delete()
      .eq("user_id", userId);
    if (membershipDeleteError) throw membershipDeleteError;
    const { error: platformRoleDeleteError } = await supabase
      .from("platform_roles")
      .delete()
      .eq("user_id", userId);
    if (platformRoleDeleteError) throw platformRoleDeleteError;

    await clerkClient.users.deleteUser(userId);
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "deleteAccount error");
    return res.status(500).json({ error: "Couldn't delete your account. Nothing was removed from your sign-in until cleanup completes." });
  }
});

export default router;
