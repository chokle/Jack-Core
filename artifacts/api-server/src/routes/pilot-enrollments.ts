import { Router, type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
import { requireAdmin } from "../lib/admin-auth.js";
import { activityDb as db } from "../lib/activity-telemetry.js";

const router = Router();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_EXPIRY_SECONDS = 15 * 60;
const MIN_EXPIRY_SECONDS = 60;
const MAX_EXPIRY_SECONDS = 60 * 60;
const DEFAULT_REDIRECT_URL = "https://jack.torchlabs.ca/app";
const QR_LIBRARY_URL =
  "https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs@04f46c6a0708418cb7b96fc563eacae0fbf77674/qrcode.min.js";

interface PilotMembershipRow {
  organization_id: string;
  pilot_id: string;
  user_id: string;
  role: string;
  active: boolean;
  valid_from: string | null;
  valid_until: string | null;
}

function isActiveMembership(row: PilotMembershipRow, now = Date.now()): boolean {
  if (!row.active || row.role !== "tester") return false;
  const from = row.valid_from ? Date.parse(row.valid_from) : Number.NEGATIVE_INFINITY;
  const until = row.valid_until ? Date.parse(row.valid_until) : Number.POSITIVE_INFINITY;
  return (!Number.isFinite(from) || from <= now) && (!Number.isFinite(until) || until > now);
}

function asExpiry(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_EXPIRY_SECONDS;
  return Math.min(MAX_EXPIRY_SECONDS, Math.max(MIN_EXPIRY_SECONDS, Math.floor(parsed)));
}

function displayName(user: { firstName: string | null; lastName: string | null }): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

function primaryEmail(user: {
  primaryEmailAddress?: { emailAddress: string } | null;
  emailAddresses: Array<{ emailAddress: string }>;
}): string | null {
  return user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
}

function redirectUrl(): string {
  const configured = process.env["PILOT_ENROLLMENT_REDIRECT_URL"]?.trim();
  if (!configured) return DEFAULT_REDIRECT_URL;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:") return DEFAULT_REDIRECT_URL;
    if (parsed.hostname !== "torchlabs.ca" && !parsed.hostname.endsWith(".torchlabs.ca")) {
      return DEFAULT_REDIRECT_URL;
    }
    return parsed.toString();
  } catch {
    return DEFAULT_REDIRECT_URL;
  }
}

async function loadActivePilot(pilotId: string) {
  const pilot = await db
    .from("pilots")
    .select("id,organization_id,name,status,starts_at,ends_at")
    .eq("id", pilotId)
    .eq("status", "active")
    .maybeSingle();
  if (pilot.error) throw pilot.error;
  return pilot.data as
    | {
        id: string;
        organization_id: string;
        name: string;
        status: string;
        starts_at: string | null;
        ends_at: string | null;
      }
    | null;
}

async function loadActiveMembership(pilotId: string, userId: string): Promise<PilotMembershipRow | null> {
  const result = await db
    .from("pilot_memberships")
    .select("organization_id,pilot_id,user_id,role,active,valid_from,valid_until")
    .eq("pilot_id", pilotId)
    .eq("user_id", userId)
    .eq("role", "tester")
    .eq("active", true)
    .limit(10);
  if (result.error) throw result.error;
  return (
    ((result.data ?? []) as PilotMembershipRow[]).find((membership) =>
      isActiveMembership(membership),
    ) ?? null
  );
}

router.get("/pilot-enrollments", requireAdmin, async (req: Request, res: Response) => {
  const pilotId = typeof req.query["pilotId"] === "string" ? req.query["pilotId"] : "";
  if (!UUID_RE.test(pilotId)) {
    return res.status(400).json({ error: "A valid pilotId is required." });
  }

  try {
    const pilot = await loadActivePilot(pilotId);
    if (!pilot) return res.status(404).json({ error: "Active pilot not found." });

    const membershipsResult = await db
      .from("pilot_memberships")
      .select("organization_id,pilot_id,user_id,role,active,valid_from,valid_until")
      .eq("pilot_id", pilotId)
      .eq("role", "tester")
      .eq("active", true)
      .limit(100);
    if (membershipsResult.error) throw membershipsResult.error;
    const memberships = ((membershipsResult.data ?? []) as PilotMembershipRow[]).filter((row) =>
      isActiveMembership(row),
    );

    const [sessionsResult, eventsResult] = await Promise.all([
      db.from("test_sessions").select("actor_user_id").eq("pilot_id", pilotId).limit(10_000),
      db.from("test_events").select("actor_user_id").eq("pilot_id", pilotId).limit(50_000),
    ]);
    if (sessionsResult.error) throw sessionsResult.error;
    if (eventsResult.error) throw eventsResult.error;

    const sessionCounts = new Map<string, number>();
    for (const row of sessionsResult.data ?? []) {
      const userId = String(row.actor_user_id ?? "");
      if (userId) sessionCounts.set(userId, (sessionCounts.get(userId) ?? 0) + 1);
    }
    const eventCounts = new Map<string, number>();
    for (const row of eventsResult.data ?? []) {
      const userId = String(row.actor_user_id ?? "");
      if (userId) eventCounts.set(userId, (eventCounts.get(userId) ?? 0) + 1);
    }

    const participants = await Promise.all(
      memberships.map(async (membership) => {
        try {
          const user = await clerkClient.users.getUser(membership.user_id);
          return {
            userId: membership.user_id,
            name: displayName(user),
            email: primaryEmail(user),
            validUntil: membership.valid_until,
            activity: {
              sessions: sessionCounts.get(membership.user_id) ?? 0,
              events: eventCounts.get(membership.user_id) ?? 0,
            },
          };
        } catch (error) {
          req.log?.warn(
            { error, userId: membership.user_id },
            "failed to resolve Clerk user for pilot enrollment list",
          );
          return {
            userId: membership.user_id,
            name: null,
            email: null,
            validUntil: membership.valid_until,
            activity: {
              sessions: sessionCounts.get(membership.user_id) ?? 0,
              events: eventCounts.get(membership.user_id) ?? 0,
            },
          };
        }
      }),
    );

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.json({
      pilot: {
        id: pilot.id,
        organizationId: pilot.organization_id,
        name: pilot.name,
        startsAt: pilot.starts_at,
        endsAt: pilot.ends_at,
      },
      participants,
    });
  } catch (error) {
    req.log?.error({ error, pilotId }, "failed to list pilot enrollment participants");
    return res.status(503).json({ error: "Pilot enrollment list is temporarily unavailable." });
  }
});

router.post("/pilot-enrollments", requireAdmin, async (req: Request, res: Response) => {
  const pilotId = typeof req.body?.pilotId === "string" ? req.body.pilotId.trim() : "";
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const expiresInSeconds = asExpiry(req.body?.expiresInSeconds);
  if (!UUID_RE.test(pilotId) || !USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: "Valid pilotId and userId values are required." });
  }

  try {
    const [pilot, membership] = await Promise.all([
      loadActivePilot(pilotId),
      loadActiveMembership(pilotId, userId),
    ]);
    if (!pilot || !membership || membership.organization_id !== pilot.organization_id) {
      return res.status(403).json({
        error: "That user does not have an active tester membership in this pilot.",
      });
    }

    const token = await clerkClient.signInTokens.createSignInToken({
      userId,
      expiresInSeconds,
    });
    const enrollmentUrl = new URL(token.url);
    enrollmentUrl.searchParams.set("redirect_url", redirectUrl());

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(201).json({
      pilotId,
      userId,
      url: enrollmentUrl.toString(),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
      oneTimeUse: true,
    });
  } catch (error) {
    req.log?.error({ error, pilotId, userId }, "failed to create pilot enrollment link");
    return res.status(503).json({ error: "Enrollment link could not be created." });
  }
});

router.get("/pilot-enrollments/page", requireAdmin, (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Jack Pilot QR Access</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background:#080a0d; color:#f5f7fa; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 50% 0,rgba(255,106,0,.16),transparent 36%),#080a0d; }
    main { width:min(980px,calc(100% - 28px)); margin:0 auto; padding:28px 0 64px; }
    h1 { margin:0; font-size:clamp(28px,5vw,46px); letter-spacing:-.04em; }
    p { color:#9ca5b2; line-height:1.55; }
    .panel,.card,.modal-card { border:1px solid #29303a; background:rgba(18,22,28,.94); border-radius:18px; box-shadow:0 24px 70px rgba(0,0,0,.3); }
    .panel { padding:18px; margin:22px 0; display:flex; gap:10px; flex-wrap:wrap; }
    input,button { min-height:44px; border-radius:11px; font:inherit; }
    input { flex:1 1 360px; border:1px solid #343c47; background:#0e1217; color:#fff; padding:0 13px; }
    button { border:0; background:#ff6a00; color:#090a0c; font-weight:800; padding:0 16px; cursor:pointer; }
    button.secondary { background:#252b34; color:#fff; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    #status { min-height:24px; color:#ff9b55; }
    #participants { display:grid; gap:12px; }
    .card { padding:16px; display:grid; grid-template-columns:1fr auto; gap:14px; align-items:center; }
    .identity strong { display:block; font-size:17px; }
    .identity span { color:#98a2af; font-size:13px; overflow-wrap:anywhere; }
    .metrics { margin-top:8px; display:flex; gap:8px; flex-wrap:wrap; }
    .pill { border:1px solid #343c47; border-radius:999px; padding:5px 8px; color:#b9c1cb; font-size:11px; }
    .pill.dormant { border-color:#386943; color:#9fe2aa; }
    dialog { width:min(520px,calc(100% - 24px)); border:0; padding:0; background:transparent; }
    dialog::backdrop { background:rgba(0,0,0,.78); backdrop-filter:blur(4px); }
    .modal-card { padding:22px; text-align:center; }
    #qr { background:#fff; display:inline-block; padding:14px; border-radius:14px; margin:10px auto 16px; }
    #qr img,#qr canvas { display:block; }
    #link { width:100%; min-height:72px; resize:none; border:1px solid #343c47; background:#0e1217; color:#cbd2db; border-radius:10px; padding:10px; }
    .actions { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-top:12px; }
    @media(max-width:640px){ .card{grid-template-columns:1fr}.card button{width:100%} }
  </style>
</head>
<body>
<main>
  <p style="color:#ff6a00;font-weight:900;letter-spacing:.15em">PILOT ACCESS</p>
  <h1>Scan once. Jack opens signed in.</h1>
  <p>Generate a short-lived, single-use QR code for an active pilot account. The participant scans it on their phone, Clerk creates the real assigned session, and normal pilot authorization still applies.</p>
  <div class="panel">
    <input id="pilotId" aria-label="Pilot ID" placeholder="Pilot UUID" />
    <button id="load">Load participants</button>
  </div>
  <p id="status" role="status"></p>
  <section id="participants"></section>
</main>
<dialog id="modal">
  <div class="modal-card">
    <h2 id="modalTitle">Pilot QR</h2>
    <p id="expiry"></p>
    <div id="qr"></div>
    <textarea id="link" readonly aria-label="Enrollment link"></textarea>
    <div class="actions">
      <button id="copy">Copy link</button>
      <button id="close" class="secondary">Close</button>
    </div>
  </div>
</dialog>
<script src="${QR_LIBRARY_URL}"></script>
<script>
(() => {
  const pilotInput = document.getElementById('pilotId');
  const loadButton = document.getElementById('load');
  const status = document.getElementById('status');
  const participants = document.getElementById('participants');
  const modal = document.getElementById('modal');
  const qr = document.getElementById('qr');
  const link = document.getElementById('link');
  const expiry = document.getElementById('expiry');
  const modalTitle = document.getElementById('modalTitle');
  const savedPilot = localStorage.getItem('jack.admin.pilotId');
  const queryPilot = new URLSearchParams(location.search).get('pilotId');
  pilotInput.value = queryPilot || savedPilot || '';

  const setStatus = (message) => { status.textContent = message; };
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };

  async function api(path, options) {
    const response = await fetch(path, { credentials:'same-origin', ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || ('Request failed (' + response.status + ')'));
    return body;
  }

  async function loadParticipants() {
    const pilotId = pilotInput.value.trim();
    if (!pilotId) return setStatus('Enter the pilot UUID.');
    localStorage.setItem('jack.admin.pilotId', pilotId);
    loadButton.disabled = true;
    participants.replaceChildren();
    setStatus('Loading active participants…');
    try {
      const data = await api('/api/pilot-enrollments?pilotId=' + encodeURIComponent(pilotId));
      setStatus(data.pilot.name + ' · ' + data.participants.length + ' active accounts');
      for (const person of data.participants) {
        const card = document.createElement('article');
        card.className = 'card';
        const identity = document.createElement('div');
        identity.className = 'identity';
        identity.append(text('strong', person.name || person.email || person.userId));
        identity.append(text('span', person.email || person.userId));
        const metrics = document.createElement('div');
        metrics.className = 'metrics';
        metrics.append(text('span', person.activity.sessions + ' sessions', 'pill'));
        metrics.append(text('span', person.activity.events + ' events', 'pill'));
        if (person.activity.sessions === 0 && person.activity.events === 0) {
          metrics.append(text('span', 'Dormant / reusable candidate', 'pill dormant'));
        }
        identity.append(metrics);
        const button = text('button', 'Generate one-scan QR');
        button.addEventListener('click', () => createEnrollment(data.pilot.id, person, button));
        card.append(identity, button);
        participants.append(card);
      }
    } catch (error) {
      setStatus(error.message || 'Could not load participants.');
    } finally {
      loadButton.disabled = false;
    }
  }

  async function createEnrollment(pilotId, person, button) {
    button.disabled = true;
    setStatus('Creating one-time Clerk session link…');
    try {
      const result = await api('/api/pilot-enrollments', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ pilotId, userId:person.userId, expiresInSeconds:900 }),
      });
      qr.replaceChildren();
      new QRCode(qr, { text:result.url, width:280, height:280, colorDark:'#000000', colorLight:'#ffffff', correctLevel:QRCode.CorrectLevel.M });
      link.value = result.url;
      modalTitle.textContent = person.name || person.email || 'Pilot QR';
      expiry.textContent = 'Single use · expires ' + new Date(result.expiresAt).toLocaleTimeString();
      modal.showModal();
      setStatus('QR ready. Scan it once on the participant phone.');
    } catch (error) {
      setStatus(error.message || 'Could not create QR.');
    } finally {
      button.disabled = false;
    }
  }

  loadButton.addEventListener('click', loadParticipants);
  document.getElementById('close').addEventListener('click', () => modal.close());
  document.getElementById('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link.value); setStatus('Enrollment link copied.'); }
    catch { link.select(); document.execCommand('copy'); setStatus('Enrollment link copied.'); }
  });
  if (pilotInput.value) void loadParticipants();
})();
</script>
</body>
</html>`);
});

export default router;
