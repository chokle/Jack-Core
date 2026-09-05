// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveJackLocalCommand,
  resolveJackLocalAction,
} from "./jack-local-command";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Jack local commands", () => {
  it.each([
    ["Library", "library"],
    ["open the video library", "library"],
    ["go forward to Library", "library"],
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
    ["go to Root Pass", "Root Pass"],
    ["go forward to Root Pass", "Root Pass"],
    ["navigate to the Root Pass node", "Root Pass"],
    ["open Fit Up concept", "Fit Up"],
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

  it("leaves content questions for the API", () => {
    expect(resolveJackLocalCommand("What is a root pass?")).toBeNull();
    expect(resolveJackLocalCommand("Where am I?")).toBeNull();
  });

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

  it("does not open an unrelated video when a named title is missing", () => {
    const videoClick = vi.fn();
    document.body.innerHTML = `
      <button data-jack-action="video" data-video-title="Root Pass Demo">Root Pass Demo</button>
    `;
    document
      .querySelector<HTMLElement>("[data-jack-action='video']")!
      .addEventListener("click", videoClick);

    const command = resolveJackLocalCommand("open video Cap Pass Demo");
    expect(resolveJackLocalAction(command!)).toBeNull();
    expect(videoClick).not.toHaveBeenCalled();
  });
});
