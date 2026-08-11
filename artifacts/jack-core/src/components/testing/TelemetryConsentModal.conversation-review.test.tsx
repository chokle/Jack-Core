// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TelemetryConsentModal } from "./TelemetryConsentModal";

describe("TelemetryConsentModal conversation-review addendum", () => {
  afterEach(cleanup);

  it("requires a separate explicit choice and submits it independently of telemetry", () => {
    const onSave = vi.fn();
    render(<TelemetryConsentModal open onSave={onSave} onClose={vi.fn()} />);

    expect(
      screen.getByText("Separate conversation-review addendum"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Allow scoped pilot conversation review"));
    fireEvent.click(screen.getByText("Save choices"));

    expect(onSave).toHaveBeenCalledWith({
      telemetry: "declined",
      screen: "declined",
      microphone: "declined",
      conversationReview: "granted",
    });
  });
});
