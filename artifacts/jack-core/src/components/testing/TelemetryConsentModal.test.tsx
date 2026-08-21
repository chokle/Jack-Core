// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TelemetryConsentModal } from "./TelemetryConsentModal";

describe("TelemetryConsentModal", () => {
  it("removes telemetry opt-out and requires core telemetry before saving", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(<TelemetryConsentModal open onSave={onSave} onClose={onClose} />);

    expect(
      screen.queryByRole("button", { name: /Continue without telemetry/i }),
    ).toBeNull();

    const saveChoices = screen.getByRole("button", {
      name: /Save choices/i,
    }) as HTMLButtonElement;
    const telemetryCheckbox = screen.getByRole("checkbox", {
      name: /Allow minimized activity telemetry/i,
    }) as HTMLInputElement;

    expect(saveChoices.disabled).toBe(true);

    fireEvent.click(telemetryCheckbox);
    expect(saveChoices.disabled).toBe(false);

    const screenCheckbox = screen.getByRole("checkbox", {
      name: /Allow optional screen recording/i,
    }) as HTMLInputElement;
    const microphoneCheckbox = screen.getByRole("checkbox", {
      name: /Allow optional microphone recording/i,
    }) as HTMLInputElement;

    expect(screenCheckbox.disabled).toBe(false);
    expect(microphoneCheckbox.disabled).toBe(true);
    fireEvent.click(screenCheckbox);
    expect(microphoneCheckbox.disabled).toBe(false);

    fireEvent.click(saveChoices);
    expect(onSave).toHaveBeenCalledWith({
      telemetry: "granted",
      screen: "granted",
      microphone: "declined",
    });
  });

  it("supports a close action without saving consent", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(<TelemetryConsentModal open onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
