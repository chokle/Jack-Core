// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { authenticatedFetch } from "@workspace/api-client-react";
import { DazRuntimeCheck } from "./DazRuntimeCheck";

vi.mock("@workspace/api-client-react", () => ({
  authenticatedFetch: vi.fn(),
}));

const mockedAuthenticatedFetch = vi.mocked(authenticatedFetch);

type JackReadyWindow = Window & {
  __JACK_MARK_READY__?: () => void;
};

beforeEach(() => {
  mockedAuthenticatedFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      status: {
        health: {
          ok: true,
          schema_version: 1,
          adapter: "durable-object",
          durable_object: true,
        },
        state: {
          schema_version: 1,
          identity: { id: "daz", pronouns: "they/them" },
          adapter: "durable-object",
          generation: 1,
          active: true,
          receipts: 1,
          recoveries: 0,
          authority_audit_entries: 1,
        },
      },
    }),
  } as Response);
});

afterEach(() => {
  cleanup();
  delete (window as JackReadyWindow).__JACK_MARK_READY__;
  vi.clearAllMocks();
});

describe("DazRuntimeCheck startup readiness", () => {
  it("marks Jack ready as soon as the standalone acceptance route mounts", async () => {
    const markReady = vi.fn();
    (window as JackReadyWindow).__JACK_MARK_READY__ = markReady;

    render(<DazRuntimeCheck />);

    expect(markReady).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockedAuthenticatedFetch).toHaveBeenCalledTimes(1));
  });
});
