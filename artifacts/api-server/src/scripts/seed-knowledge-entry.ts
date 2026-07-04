import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { supabase } from "../lib/supabase.js";
import { createEmbedding } from "../lib/openai.js";

/**
 * Seed a single Knowledge Entry — a NON-video knowledge asset (written field
 * note, sketch, photo, etc.) — directly into the database. It uploads the
 * entry's image to Supabase Storage, computes its embedding, and UPSERTS the
 * row by a stable id (so re-running is idempotent, not duplicative).
 *
 * This is the "created manually in the database" path: there is no ingestion UI
 * yet. The APP side (retrieval in chat.ts, rendering in StructuredAnswer.tsx) is
 * generic and table-driven — nothing here is hardcoded into the app. To add
 * another entry, edit ENTRY (and its image) and re-run; the app needs no change.
 *
 * Run: pnpm --filter @workspace/api-server run seed:knowledge
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const ENTRY = {
  // Stable id so re-seeding updates in place instead of duplicating.
  id: "e1e1e1e1-0001-4001-8001-000000000001",
  title: "Vertical-Up FCAW-S (Self-Shielded) Gun Angle & Stick-Out",
  // Normalized Red Seal trade — the entry's trade was given as "Welding".
  trade: "Welder",
  category: "Welding Technique",
  tags: [
    "FCAW-S",
    "self-shielded",
    "flux-core",
    "vertical-up",
    "3G",
    "gun angle",
    "stick-out",
    "out-of-position",
  ],
  description:
    "Field note on running self-shielded flux-cored (FCAW-S) uphill on vertical (3G) joints: correct gun angle, electrode stick-out (ESO), and travel technique to avoid cold lap, slag inclusions, and lack of fusion.",
  body: `Process: FCAW-S (self-shielded flux-cored, e.g. E71T-8 / E71T-11). There is NO shielding gas — the flux forms the shield, so a drag (pull) technique is required. Do not push, and stay out of any breeze that would disturb the arc.

Gun angle (vertical-up / 3G):
- Travel: uphill, dragging. Point the gun up the joint with a ~5-15 degree drag angle so the wire trails the direction of travel.
- Work angle: about 90 degrees to the plate on a butt/groove; on a T-joint fillet aim ~45 degrees into the corner, biased slightly toward the bottom plate to balance the heat.
- Keep the arc on the leading edge of the puddle and let the shelf freeze below you as you climb.

Electrode stick-out (ESO, contact-tip-to-work):
- FCAW-S wants a LONGER stick-out than gas-shielded wire: roughly 3/4 in to 1 in (19-25 mm). Too short chills the arc and traps slag; too long makes the arc wander and lose penetration.

Travel technique:
- Small upside-down-U or slight side-to-side weave, pausing briefly at each toe to tie in and prevent cold lap.
- Steady, deliberate travel — vertical-up runs slower than flat. If the trailing edge sags, you are too hot or too slow.

Typical starting parameters (.072 wire, 3/8 in plate — always tune to your machine and WPS):
- ~18-20 V, ~200-230 in/min wire feed. Dial down slightly from your flat settings for vertical-up.

Common mistakes:
- Pushing the gun (gas-style) on self-shielded wire -> porosity and poor fusion. Always drag.
- Too short a stick-out -> slag inclusions and a ropey bead.
- Traveling too fast -> lack of fusion at the toes / cold lap.

Field tip: let the shelf do the work — establish the puddle, then climb onto the freezing shelf so each pass ties into the last. Chip and wire-brush all slag between passes; FCAW-S slag causes inclusions if you weld over it.`,
  image: {
    // Sketch surfaced whenever Jack cites this technique.
    path: `${REPO_ROOT}attached_assets/image_1783156534339.png`,
    contentType: "image/png",
    caption: "Sketch — vertical-up FCAW-S gun angle and electrode stick-out.",
  },
  metadata: { origin: "manual-seed", entryNumber: 1 },
};

async function main(): Promise<void> {
  // 1) Upload the image to the public storage bucket (reused from video uploads).
  const bytes = readFileSync(ENTRY.image.path);
  const storagePath = `knowledge/${ENTRY.id}/sketch.png`;
  const { error: upErr } = await supabase.storage
    .from("jack-videos")
    .upload(storagePath, bytes, { contentType: ENTRY.image.contentType, upsert: true });
  if (upErr) throw new Error(`image upload failed: ${upErr.message}`);
  const imageUrl = `${process.env["SUPABASE_URL"]}/storage/v1/object/public/jack-videos/${storagePath}`;

  // 2) Embed title + description + body so Ask Jack can retrieve it semantically.
  const embedInput = [ENTRY.title, ENTRY.description, ENTRY.body].filter(Boolean).join("\n\n");
  const embedding = await createEmbedding(embedInput, { cache: false });
  if (embedding.length === 0) throw new Error("embedding came back empty");

  // 3) Upsert the row (embedding stored JSON-serialized, like videos.embedding).
  const { error: insErr } = await supabase.from("knowledge_entries").upsert({
    id: ENTRY.id,
    title: ENTRY.title,
    description: ENTRY.description,
    trade: ENTRY.trade,
    category: ENTRY.category,
    tags: ENTRY.tags,
    body: ENTRY.body,
    images: [{ url: imageUrl, caption: ENTRY.image.caption }],
    related_video_ids: [],
    related_timestamps: [],
    attachments: [],
    metadata: ENTRY.metadata,
    embedding: JSON.stringify(embedding),
    updated_at: new Date().toISOString(),
  });
  if (insErr) throw new Error(`insert failed: ${insErr.message}`);

  console.log(`✅ Seeded knowledge entry "${ENTRY.title}"`);
  console.log(`   id:    ${ENTRY.id}`);
  console.log(`   image: ${imageUrl}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ seed:knowledge failed:", err);
    process.exit(1);
  });
