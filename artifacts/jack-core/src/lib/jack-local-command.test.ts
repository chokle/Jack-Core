// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listVideos: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  listVideos: api.listVideos,
}));

import {
  resolveJackLocalCommand,
  resolveJackLocalAction,
} from "./jack-local-command";

beforeEach(() => {
  document.body.innerHTML = "";
  api.listVideos.mockReset();
  api.listVideos.mockResolvedValue({ videos: [] });
});

describe("Jack local commands", () => {
  it.each([
    ["Library", "library"],
    ["navigate to account settings", "account"],
    ["Jack, can you open my account settings?", "account"],
    ["take me to account and privacy", "account"],
    ["open settings", "account"],
    ["open the video library", "library"],
    ["go forward to Library", "library"],
    ["forward to Library", "library"],
    ["Jack, can you open the Library?", "library"],
    ["Living Memory", "graph"],
    ["navigate to the memory graph", "graph"],
    ["Interview mode", "interview"],
    ["go to Knowledge Review", "review"],
  ])("resolves %s to the app-owned %s action", (message, action) => {
    expect(resolveJackLocalCommand(message)).toMatchObject({
      kind: "app",
      action,
    });
  });

  it.each([
    "forward",
    "go forward",
    "go forward one level",
    "move forward",
    "next",
  ])("resolves bare forward navigation locally: %s", (message) => {
    expect(resolveJackLocalCommand(message)).toEqual({
      kind: "app",
      action: "forward",
      label: "the next view",
    });
  });

  it.each([
    ["go to Root Pass", "Root Pass"],
    ["go forward to Root Pass", "Root Pass"],
    ["forward to node Root Pass", "Root Pass"],
    ["navigate to the Root Pass node", "Root Pass"],
    ["go to Fit Up concept", "Fit Up"],
    ["go to node Root Pass", "Root Pass"],
    ["take me to node Root Pass", "Root Pass"],
    ["open concept Fit Up", "Fit Up"],
    ["show me branch Root Pass", "Root Pass"],
    ["go to How to Weld node", "How to Weld"],
    ["show me node How to Weld", "How to Weld"],
    ["go to Rules of Welding branch", "Rules of Welding"],
    ["show me node Rules of Welding", "Rules of Welding"],
  ])("resolves a named graph node: %s", (message, target) => {
    expect(resolveJackLocalCommand(message)).toEqual({
      kind: "node",
      target,
      label: `node ${target}`,
    });
  });

  it.each([
    "Show me the source",
    "show the original source for that.",
    "open this video",
    "play that clip",
  ])("keeps source requests local: %s", (message) => {
    expect(resolveJackLocalCommand(message)).toMatchObject({
      kind: "app",
      action: "source",
    });
  });

  it.each([
    ["open video Root Pass Demo", "Root Pass Demo"],
    ["retrieve the Root Pass Demo video from library", "Root Pass Demo"],
    ["find Root Pass Demo in the video library", "Root Pass Demo"],
    ["retrieve from library", null],
    ["Could you retrieve from the library?", null],
  ])("resolves library video phrasing: %s", (message, target) => {
    expect(resolveJackLocalCommand(message)).toMatchObject({
      kind: "video",
      target,
    });
  });

  it.each([
    "What is a root pass?",
    "Where am I?",
    "show me how to weld a root pass",
    "find the right amperage for root pass",
    "open the procedure for root pass",
    "view root pass settings",
    "show me Root Pass branch",
    "open Fit Up concept",
    "show me how to weld a branch",
    "show me how to explain this concept",
    "show me what's wrong with this branch",
    "show me the procedure for preparing this branch",
    "open the instructions for setting this branch",
    "show me the right amperage for this branch",
    "show me the correct voltage for that concept",
    "find the recommended settings for this topic",
    "show me the amperage in this branch",
    "show me the voltage of that concept",
    "show me the travel speed at this node",
    "show me defects beneath this branch",
    "find hazards around this node",
    "show me everything under this topic",
    "view details within this concept",
    "show me guidance regarding this branch",
  ])(
    "leaves content or ambiguous suffix requests for the API: %s",
    (message) => {
      expect(resolveJackLocalCommand(message)).toBeNull();
    },
  );

  it("targets a visible video by its explicit title", () => {
    const click = vi.fn();
    document.body.innerHTML = `
      <button data-jack-action="video" data-video-title="Root Pass Demo" onclick="">Root Pass Demo</button>
    `;
    const button = document.querySelector<HTMLElement>(
      "[data-jack-action='video']",
    )!;
    button.addEventListener("click", click);

    const command = resolveJackLocalCommand("open video Root Pass Demo");
    expect(command).toBeTruthy();
    const action = resolveJackLocalAction(command!);
    action?.click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(api.listVideos).not.toHaveBeenCalled();
  });

  it("resolves natural take-me-to wording against the authenticated Library before node fallback", async () => {
    api.listVideos.mockResolvedValue({
      videos: [{ id: "3g", title: "3gdemo" }],
    });
    const nodeClick = vi.fn();
    document.body.innerHTML = `
      <button data-jack-action="node" data-node-label="3G demo">3G demo node</button>
      <button data-jack-action="library">Library</button>
    `;
    document
      .querySelector<HTMLElement>("[data-jack-action='node']")!
      .addEventListener("click", nodeClick);
    const opened = vi.fn();
    window.addEventListener("jack:open-video-source", opened);

    const command = resolveJackLocalCommand("Take me to 3G demo");
    expect(command).toEqual({
      kind: "destination",
      target: "3G demo",
      label: "destination 3G demo",
    });
    resolveJackLocalAction(command!)?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.listVideos).toHaveBeenCalledWith({ limit: 200 });
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      videoId: "3g",
    });
    expect(nodeClick).not.toHaveBeenCalled();
    window.removeEventListener("jack:open-video-source", opened);
  });

  it("falls back to a rendered node when natural destination wording is not a Library title", async () => {
    const nodeClick = vi.fn();
    document.body.innerHTML = `
      <button data-jack-action="node" data-node-label="Root Pass">Root Pass</button>
      <button data-jack-action="library">Library</button>
    `;
    document
      .querySelector<HTMLElement>("[data-jack-action='node']")!
      .addEventListener("click", nodeClick);

    const command = resolveJackLocalCommand("take me to Root Pass");
    expect(command).toMatchObject({
      kind: "destination",
      target: "Root Pass",
    });
    resolveJackLocalAction(command!)?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(nodeClick).toHaveBeenCalledTimes(1);
  });

  it("targets a visible graph node by its explicit label", () => {
    const click = vi.fn();
    document.body.innerHTML = `
      <button data-jack-action="node" data-node-label="Root Pass" onclick="">
        Open Root Pass
      </button>
    `;
    const button = document.querySelector<HTMLElement>(
      "[data-jack-action='node']",
    )!;
    button.addEventListener("click", click);

    const command = resolveJackLocalCommand("go to Root Pass");
    expect(command).toMatchObject({ kind: "node", target: "Root Pass" });
    resolveJackLocalAction(command!)?.click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("routes targetless library retrieval to the Library control", () => {
    const libraryClick = vi.fn();
    const videoClick = vi.fn();
    document.body.innerHTML = `
      <button data-jack-action="library">Library</button>
      <button data-jack-action="video" data-video-title="Root Pass Demo">Root Pass Demo</button>
    `;
    document
      .querySelector<HTMLElement>("[data-jack-action='library']")!
      .addEventListener("click", libraryClick);
    document
      .querySelector<HTMLElement>("[data-jack-action='video']")!
      .addEventListener("click", videoClick);

    const command = resolveJackLocalCommand("retrieve from library");
    resolveJackLocalAction(command!)?.click();

    expect(libraryClick).toHaveBeenCalledTimes(1);
    expect(videoClick).not.toHaveBeenCalled();
  });

  it("does not open an unrelated video when a named title is missing", async () => {
    api.listVideos.mockResolvedValue({
      videos: [{ id: "root", title: "Root Pass Demo" }],
    });
    const videoClick = vi.fn();
    document.body.innerHTML = `
      <button data-jack-action="video" data-video-title="Root Pass Demo">Root Pass Demo</button>
    `;
    document
      .querySelector<HTMLElement>("[data-jack-action='video']")!
      .addEventListener("click", videoClick);

    const command = resolveJackLocalCommand("open video Cap Pass Demo");
    resolveJackLocalAction(command!)?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(videoClick).not.toHaveBeenCalled();
  });
});
