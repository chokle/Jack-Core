import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { GetVideosByCompetencyParams } from "@workspace/api-zod";

const router = Router();

router.get("/competencies", async (req, res) => {
  try {
    const { data: competencies, error } = await supabase
      .from("competencies")
      .select("*")
      .order("trade")
      .order("code");

    if (error) throw error;

    const { data: videos } = await supabase
      .from("videos")
      .select("competency_codes")
      .eq("status", "completed");

    const countByCode: Record<string, number> = {};
    for (const v of videos ?? []) {
      for (const code of (v.competency_codes ?? []) as string[]) {
        countByCode[code] = (countByCode[code] ?? 0) + 1;
      }
    }

    return res.json(
      (competencies ?? []).map((c: Record<string, unknown>) => ({
        code: c["code"],
        name: c["name"],
        trade: c["trade"],
        description: c["description"] ?? null,
        videoCount: countByCode[c["code"] as string] ?? 0,
      }))
    );
  } catch (err) {
    req.log.error({ err }, "listCompetencies error");
    return res.status(500).json({ error: "Failed to list competencies" });
  }
});

router.get("/competencies/:code/videos", async (req, res) => {
  try {
    const parsed = GetVideosByCompetencyParams.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid code" });

    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .contains("competency_codes", [parsed.data.code])
      .order("created_at", { ascending: false });

    if (error) throw error;
    return res.json(data ?? []);
  } catch (err) {
    req.log.error({ err }, "getVideosByCompetency error");
    return res.status(500).json({ error: "Failed to get videos by competency" });
  }
});

export default router;
