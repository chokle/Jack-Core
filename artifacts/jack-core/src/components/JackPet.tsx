import type { CSSProperties } from "react";
import idlePose from "../assets/jack-pet-idle.png";
import listeningPose from "../assets/jack-pet-listening.png";
import listeningStrip from "../assets/jack-pet-listening-strip.png";
import thinkingPose from "../assets/jack-pet-thinking.png";
import thinkingStrip from "../assets/jack-pet-thinking-strip.png";
import alertPose from "../assets/jack-pet-alert.png";
import successPose from "../assets/jack-pet-success.png";
import speakingStrip from "../assets/jack-pet-speaking-strip.png";
import "./JackPet.css";

export type JackPetActivity =
  | "ONLINE"
  | "LISTENING"
  | "THINKING"
  | "SPEAKING"
  | "ALERT"
  | "SUCCESS"
  | "GUIDING";

const activitySprite: Record<JackPetActivity, string> = {
  ONLINE: idlePose,
  LISTENING: listeningStrip,
  THINKING: thinkingStrip,
  SPEAKING: speakingStrip,
  ALERT: alertPose,
  SUCCESS: successPose,
  GUIDING: alertPose,
};

const activityPoster: Record<JackPetActivity, string> = {
  ONLINE: idlePose,
  LISTENING: listeningPose,
  THINKING: thinkingPose,
  SPEAKING: idlePose,
  ALERT: alertPose,
  SUCCESS: successPose,
  GUIDING: alertPose,
};

export function JackPet({
  activity = "ONLINE",
  size = 48,
  label = "Jack",
  className = "",
}: {
  activity?: JackPetActivity;
  /** Width in CSS pixels. The artwork keeps its original portrait ratio. */
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <span
      aria-label={label}
      className={`jack-pet jack-pet--${activity.toLowerCase()} ${className}`.trim()}
      data-activity={activity.toLowerCase()}
      role="img"
      style={
        {
          width: `${size}px`,
          height: `${Math.round(size * 1.25)}px`,
          backgroundImage: `url("${activitySprite[activity]}")`,
          "--jack-pet-idle": `url("${activityPoster[activity]}")`,
        } as CSSProperties
      }
    />
  );
}
