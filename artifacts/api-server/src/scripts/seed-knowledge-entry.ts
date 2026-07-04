import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../lib/supabase.js";
import { createEmbedding } from "../lib/openai.js";
import type { KnowledgeObjectMeta } from "../lib/knowledge-schema.js";

/**
 * Seed the sample Knowledge Entries — NON-video knowledge assets (written field
 * notes, sketches, photos) — directly into the database. For each entry it
 * (optionally) uploads an image to Supabase Storage, computes an embedding, and
 * UPSERTS the row by a stable id (so re-running is idempotent, not duplicative).
 *
 * This is the "created manually in the database" path: there is no ingestion UI
 * yet. The APP side (retrieval in chat.ts, rendering in StructuredAnswer.tsx) is
 * generic and table-driven — nothing here is hardcoded into the app. To add
 * another entry, append to ENTRIES (and drop its image in attached_assets) and
 * re-run; the app needs no change.
 *
 * Run: pnpm --filter @workspace/api-server run seed:knowledge
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface EntryImage {
  /** Absolute path to the source image file. */
  path: string;
  contentType: string;
  caption: string;
}

interface Entry {
  /** Stable id so re-seeding updates in place instead of duplicating. */
  id: string;
  title: string;
  /** Must be a seeded Red Seal trade label (Welder, Electrician, Plumber, Carpenter, HVAC/R Technician). */
  trade: string;
  category: string;
  tags: string[];
  description: string;
  body: string;
  /** Optional — an entry with no image renders as a text-only field note. */
  image?: EntryImage;
  /**
   * Bookkeeping keys (origin, entryNumber, …) plus any of the richer OPTIONAL
   * Knowledge Object fields (scenario, rootCause, safetyNote, confidence, …).
   * Every richer field is optional, so existing entries need no change.
   * See `../lib/knowledge-schema.ts` for the full schema.
   */
  metadata: KnowledgeObjectMeta;
}

const ENTRIES: Entry[] = [
  {
    id: "e1e1e1e1-0001-4001-8001-000000000001",
    title: "Vertical-Up FCAW-S (Self-Shielded) Gun Angle & Stick-Out",
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
      path: `${REPO_ROOT}attached_assets/image_1783156534339.png`,
      contentType: "image/png",
      caption: "Sketch — vertical-up FCAW-S gun angle and electrode stick-out.",
    },
    metadata: { origin: "manual-seed", entryNumber: 1 },
  },
  {
    id: "e1e1e1e1-0002-4001-8001-000000000002",
    title: "Bending EMT Conduit Offsets: Multipliers, Shrink & Marking",
    trade: "Electrician",
    category: "Wiring Methods and Installation",
    tags: [
      "EMT",
      "conduit bending",
      "offset",
      "multiplier",
      "shrink",
      "hand bender",
      "30 degree",
      "layout",
    ],
    description:
      "How to bend a two-bend offset in EMT: pick the bend angle, use the correct multiplier to find the distance between bends, add for shrink, and keep both bends in the same plane so the conduit sits flat to the box.",
    body: `An offset is two equal bends that step the conduit over to meet a box or clear an obstacle. You need three things: the offset depth (how far you're stepping over), a bend angle, and the multiplier for that angle.

Distance between the two bends = offset depth x multiplier.
Common angles and multipliers:
- 10 degrees -> multiplier 6.0
- 22.5 degrees -> multiplier 2.6
- 30 degrees -> multiplier 2.0
- 45 degrees -> multiplier 1.4
- 60 degrees -> multiplier 1.2

Example: a 3 in offset with 30 degree bends -> 3 x 2 = 6 in between the two bend marks.

Shrink (the run gets shorter as the pipe steps over) — add this so the box end still lands where you want it:
- 10 degrees -> 1/16 in per in of offset
- 22.5 degrees -> 3/16 in per in
- 30 degrees -> 1/4 in per in
- 45 degrees -> 3/8 in per in
So a 3 in offset at 30 degrees shrinks 3 x 1/4 = 3/4 in — mark your first bend 3/4 in farther down the pipe.

Technique:
- Keep BOTH bends in the same plane. Rotate the pipe 180 degrees in the bender between bends and sight down it to confirm it's flat — a twist gives you a "dog-leg" that won't sit against the wall.
- Line up the bender arrow/star at your marks and bend to the same angle both times (watch the degree marks on the bender or use an angle finder).
- Small angles (10-22.5 degrees) make shallow, clean offsets for shallow boxes; steeper angles for deep obstacles.

Common mistakes:
- Forgetting shrink -> the box knockout no longer lines up.
- Bends not in the same plane -> dog-leg.
- Overbending one side -> offset depth is off; check by laying the pipe flat on the floor.`,
    metadata: { origin: "manual-seed", entryNumber: 2 },
  },
  {
    id: "e1e1e1e1-0003-4001-8001-000000000003",
    title: "DWV Drain Slope: 1/4 Inch Per Foot — and Why Too Much Backfires",
    trade: "Plumber",
    category: "Drainage, Waste and Vent Systems",
    tags: [
      "DWV",
      "drain slope",
      "grade",
      "1/4 inch per foot",
      "fall",
      "venting",
      "trap siphon",
    ],
    description:
      "The standard fall for gravity drains is 1/4 inch per foot (about 2%). Larger pipe can run flatter, but over-sloping small pipe lets the water outrun the solids and can siphon trap seals.",
    body: `Gravity drains need enough slope (fall/grade) to carry solids, but not so much that the liquid races ahead and leaves solids behind.

Standard slope:
- Pipe 2-1/2 in and smaller: 1/4 in per foot (about 2%).
- Pipe 3 in to 6 in: 1/8 in per foot (about 1%) is commonly allowed.
- Very large sewers can go flatter still — check the code on your job.

Why steeper is NOT better:
- On small pipe, too much slope (over about 1/2 in per foot) lets the water drain faster than it can float the solids — the solids drop out and build up, causing clogs.
- Fast, plunging flow can also siphon the water out of nearby traps, breaking the seal and letting sewer gas into the building. Proper venting protects trap seals.

How to check it:
- 1/4 in per foot = drop 1 in over 4 ft, or the bubble on a 2-ft level sitting about 1/8 in past the line.
- Support the pipe so it holds a straight, consistent grade — no bellies. A sag holds water and waste and is where clogs start.

Field tips:
- Keep the slope consistent for the whole run; a flat spot or a belly is a future callback.
- Vent every trap so drains flow smoothly and traps keep their seal.
- Confirm the required grade and maximum developed length with the code that applies to your job.`,
    metadata: { origin: "manual-seed", entryNumber: 3 },
  },
  {
    id: "e1e1e1e1-0004-4001-8001-000000000004",
    title: "Laying Out Stair Stringers: Rise, Run, the 7-11 Rule & Dropping the Stringer",
    trade: "Carpenter",
    category: "Framing",
    tags: [
      "stairs",
      "stringer",
      "rise",
      "run",
      "framing square",
      "stair gauges",
      "dropping the stringer",
      "7-11 rule",
    ],
    description:
      "How to divide total rise into equal risers, pick a comfortable run, lay out the stringer with a framing square, and 'drop' the stringer by one tread thickness so the first and last steps come out equal.",
    body: `Total rise is the finished floor-to-floor height. Divide it into equal risers.

Find the risers:
- Number of risers = total rise / ~7 in, rounded to a whole number.
- Unit rise = total rise / number of risers.
Example: 42 in total rise / 7 = 6 risers. 42 / 6 = 7 in per riser.

Pick the run (tread depth):
- Typical unit run is 10-11 in.
- Comfort check (the "7-11 rule"): a riser near 7 in with a run near 11 in walks well. Other rules of thumb: rise + run is about 17-18 in; (2 x rise) + run is about 24-25 in.
- Remember there is always ONE more riser than there are treads.

Lay it out:
- Set stair gauges on a framing square at the unit rise (on the tongue) and the unit run (on the blade). Step the square down the stringer board, tracing each step.

Drop the stringer:
- After marking, cut the bottom of the stringer DOWN by the thickness of one tread. This "drop" makes the first step and the top step the same height once the tread material and finished floor are on. Skip it and your first or last step will be off by one tread thickness.

Watch for:
- Code limits — commonly a max riser around 7-3/4 in and a min tread around 10 in for residential; verify the code on your job.
- Keep every riser equal — uneven risers are a trip hazard and a common inspection failure.`,
    metadata: { origin: "manual-seed", entryNumber: 4 },
  },
  {
    id: "e1e1e1e1-0005-4001-8001-000000000005",
    title: "Charging AC/Heat Pumps: Superheat vs Subcooling (Fixed Orifice vs TXV)",
    trade: "HVAC/R Technician",
    category: "Refrigeration Systems",
    tags: [
      "superheat",
      "subcooling",
      "charging",
      "TXV",
      "fixed orifice",
      "piston",
      "manifold gauges",
      "refrigerant",
      "airflow",
    ],
    description:
      "Charge a fixed-orifice (piston) system by superheat and a TXV/EEV system by subcooling. Always confirm airflow first, then adjust refrigerant to hit the manufacturer's target.",
    body: `Superheat and subcooling tell you whether the charge is right.
- Superheat (low side) = suction line temperature - the saturation temperature for the suction pressure. It shows how much the vapor warmed past boiling. Low superheat = risk of liquid flooding back to the compressor; high superheat = undercharge / starved evaporator.
- Subcooling (high side) = the liquid-line saturation temperature - the actual liquid line temperature. It shows how much the liquid cooled below condensing. Low subcooling = undercharge; high subcooling = overcharge / liquid backing up in the condenser.

Which method to use:
- Fixed orifice / piston (no modulating metering device): charge by SUPERHEAT. Use the manufacturer's charging chart — target superheat depends on the indoor wet-bulb and outdoor dry-bulb temperatures.
- TXV / EEV (modulating metering device): the valve already controls evaporator superheat, so charge by SUBCOOLING. A typical target is about 10-12 degrees F, but use the value on the unit's data plate or chart.

Before you touch the charge:
- Confirm airflow first — roughly 400 CFM per ton. A dirty filter or coil, or the wrong blower speed, throws off every reading.
- Let the system run and stabilize (usually 10-15 min) before you trust the numbers.

Quick diagnosis:
- Undercharged: HIGH superheat AND LOW subcooling.
- Overcharged: LOW superheat AND HIGH subcooling.

Use accurate clamp thermocouples and a calibrated manifold or probes — small temperature errors move superheat and subcooling a lot.`,
    image: {
      path: `${REPO_ROOT}attached_assets/stock_images/hvac_manifold_gauges.jpg`,
      contentType: "image/jpeg",
      caption: "Outdoor condensing unit — confirm airflow, then set the charge by superheat or subcooling.",
    },
    metadata: { origin: "manual-seed", entryNumber: 5 },
  },
];

async function seedEntry(entry: Entry): Promise<void> {
  // 1) Optionally upload the image to the public storage bucket (reused from
  //    video uploads). Entries with no image render as text-only field notes.
  let images: Array<{ url: string; caption: string }> = [];
  if (entry.image) {
    const bytes = readFileSync(entry.image.path);
    const ext = extname(entry.image.path).toLowerCase() || ".png";
    const storagePath = `knowledge/${entry.id}/image${ext}`;
    const { error: upErr } = await supabase.storage
      .from("jack-videos")
      .upload(storagePath, bytes, { contentType: entry.image.contentType, upsert: true });
    if (upErr) throw new Error(`[${entry.title}] image upload failed: ${upErr.message}`);
    const imageUrl = `${process.env["SUPABASE_URL"]}/storage/v1/object/public/jack-videos/${storagePath}`;
    images = [{ url: imageUrl, caption: entry.image.caption }];
  }

  // 2) Embed title + description + body so Ask Jack can retrieve it semantically.
  const embedInput = [entry.title, entry.description, entry.body].filter(Boolean).join("\n\n");
  const embedding = await createEmbedding(embedInput, { cache: false });
  if (embedding.length === 0) throw new Error(`[${entry.title}] embedding came back empty`);

  // 3) Upsert the row (embedding stored JSON-serialized, like videos.embedding).
  const { error: insErr } = await supabase.from("knowledge_entries").upsert({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    trade: entry.trade,
    category: entry.category,
    tags: entry.tags,
    body: entry.body,
    images,
    related_video_ids: [],
    related_timestamps: [],
    attachments: [],
    metadata: entry.metadata,
    embedding: JSON.stringify(embedding),
    updated_at: new Date().toISOString(),
  });
  if (insErr) throw new Error(`[${entry.title}] insert failed: ${insErr.message}`);

  console.log(`✅ Seeded "${entry.title}" (${entry.trade})${images.length ? " [image]" : ""}`);
}

async function main(): Promise<void> {
  for (const entry of ENTRIES) {
    await seedEntry(entry);
  }
  console.log(`\nDone — seeded ${ENTRIES.length} knowledge entries.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ seed:knowledge failed:", err);
    process.exit(1);
  });
