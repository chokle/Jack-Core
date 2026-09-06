import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { resolveIdentity, type CallerIdentity } from "../lib/admin-auth.js";
import {
  authorizeAgentPermission,
  addressesInternalAgent,
} from "../lib/agent-authorization.js";
import {
  projectFieldState,
  projectCommandCentre,
  OperationalFiltersSchema,
} from "@workspace/api-zod";
import {
  operationalBus,
  resolveOperationalContext,
  OperationalAccessError,
} from "../lib/operational-bus.js";

async function caller(
  req: Request,
  res: Response,
): Promise<CallerIdentity | null> {
  res.setHeader("Cache-Control", "no-store");
  const identity = await resolveIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Sign in required." });
    return null;
  }
  if (
    identity.classification !== "resolved" ||
    identity.isPresentation ||
    identity.userId !== req.userId
  ) {
    res.status(403).json({ error: "Resolved account required." });
    return null;
  }
  return identity;
}

const router = Router();
async function readContext(
  req: Request,
  res: Response,
  identity: CallerIdentity,
  admin = false,
) {
  const parsed = OperationalFiltersSchema.safeParse(admin ? req.query : {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid operational filters." });
    return null;
  }
  try {
    return {
      context: await resolveOperationalContext(req, identity, parsed.data),
      filters: parsed.data,
    };
  } catch (error) {
    res.status(error instanceof OperationalAccessError ? 403 : 503).json({
      error: "Operational scope unavailable.",
      alerts: [{ code: "event_ingestion_failed" }],
    });
    return null;
  }
}
router.get("/operational/state", async (req, res) => {
  const identity = await caller(req, res);
  if (!identity) return;
  if (Object.keys(req.query).length) {
    res.status(400).json({ error: "Scope selectors are not supported." });
    return;
  }
  const resolved = await readContext(req, res, identity);
  if (!resolved) return;
  try {
    const snapshot = await operationalBus.read(resolved.context);
    if (snapshot.durability === "unavailable") {
      res.status(503).json({ error: "Operational history may be incomplete." });
      return;
    }
    res.json(projectFieldState(snapshot.state));
  } catch {
    res.status(503).json({ error: "Operational state unavailable." });
  }
});

router.post("/operational/voice", async (req, res) => {
  // Preserve receipt order across asynchronous identity/consent/database work.
  const occurredAt = new Date().toISOString();
  const identity = await caller(req, res);
  if (!identity) return;
  const body = req.body;
  if (
    !body ||
    Object.keys(body).length !== 1 ||
    !["voice.listening.started", "voice.listening.stopped"].includes(body.type)
  ) {
    res.status(400).json({ error: "Invalid voice observation." });
    return;
  }
  const resolved = await readContext(req, res, identity);
  if (!resolved) return;
  try {
    await operationalBus.publish(resolved.context, {
      type: body.type,
      audience: "field",
      payload: {},
      source: "voice",
      occurredAt,
    });
    const snapshot = await operationalBus.read(resolved.context);
    if (snapshot.durability === "unavailable") {
      res.status(503).json({ error: "Operational history may be incomplete." });
      return;
    }
    res.json(projectFieldState(snapshot.state));
  } catch {
    res
      .status(503)
      .json({ error: "Operational observation could not be persisted." });
  }
});

router.get("/admin/agents/state", async (req, res) => {
  const identity = await caller(req, res);
  if (!identity) return;
  if (!authorizeAgentPermission(identity, "agent.status.internal")) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const resolved = await readContext(req, res, identity, true);
  if (!resolved) return;
  try {
    const snapshot = await operationalBus.read(resolved.context);
    res.json(
      projectCommandCentre(
        snapshot.state,
        snapshot.history,
        resolved.filters,
        Date.now(),
        snapshot.durability,
      ),
    );
  } catch {
    res.status(503).json({
      error: "Operational journal unavailable.",
      alerts: [{ code: "event_ingestion_failed" }],
    });
  }
});

router.post("/admin/agents/commands", async (req, res) => {
  const identity = await caller(req, res);
  if (!identity) return;
  const permission = req.body?.permission;
  // Fail closed before parsing targets: no role, surface, or spoken text grants privilege.
  if (
    typeof permission !== "string" ||
    !authorizeAgentPermission(identity, permission)
  ) {
    res.status(403).json({ error: "Admin agent permission required." });
    return;
  }
  const { agentId, channel } = req.body;
  if (
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(agentId ?? "") ||
    !["command-centre", "voice"].includes(channel) ||
    Object.keys(req.body).some(
      (key) => !["permission", "agentId", "channel"].includes(key),
    ) ||
    permission === "agent.status.internal"
  ) {
    res.status(400).json({ error: "Invalid agent command." });
    return;
  }
  // No arbitrary shell/model endpoint. Registration of a real executor requires
  // scoped authority/consent checks and durable dispatch before it can execute.
  res.status(501).json({ error: "No internal agent executor is configured." });
});

/** Both typed and transcribed Ask Jack requests pass here before retrieval. */
export async function guardJackAgentBoundary(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.method !== "POST") {
    next();
    return;
  }
  const body = req.body;
  const structuredTarget =
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    ["agentId", "agent", "targetAgent", "permission", "modelRoute"].some(
      (key) => key in body,
    );
  if (
    !structuredTarget &&
    !(typeof body?.message === "string" && addressesInternalAgent(body.message))
  ) {
    next();
    return;
  }
  const identity = await caller(req, res);
  if (!identity) return;
  if (!authorizeAgentPermission(identity, "agent.command.address")) {
    res.status(403).json({
      error:
        "Ask Jack for help with field work. Internal agent access requires an admin.",
    });
    return;
  }
  res.status(409).json({
    error: "Use the admin Command Centre for internal agent commands.",
  });
}

export default router;
