import {
  DoorOpen,
  FireExtinguisher,
  LogIn,
  MapPin,
  Plus,
  TriangleAlert,
  Users,
  Volume2,
} from "lucide-react";
import type { HudLandmark } from "../lib/site-hud";

export const siteSafetyIcons = {
  entry: LogIn,
  hazard: TriangleAlert,
  muster: Users,
  "fire-exit": DoorOpen,
  "fire-extinguisher": FireExtinguisher,
  "first-aid": Plus,
  "air-horn": Volume2,
} satisfies Record<HudLandmark["kind"], typeof Plus>;

export function siteSafetyColor(kind: HudLandmark["kind"]): string {
  if (kind === "fire-extinguisher") return "#f87171";
  if (kind === "muster" || kind === "first-aid" || kind === "fire-exit")
    return "#4ade80";
  if (kind === "hazard") return "#fbbf24";
  return "#67e8f9";
}

export function siteSafetyIcon(kind: HudLandmark["kind"]) {
  return Object.hasOwn(siteSafetyIcons, kind) ? siteSafetyIcons[kind] : MapPin;
}
