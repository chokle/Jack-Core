// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InstallJack } from "./InstallJack";

afterEach(cleanup);

it("keeps an early install offer until the signed-in action mounts", async () => {
  const openBrowserPrompt = vi.fn().mockResolvedValue(undefined);
  const offer = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: openBrowserPrompt,
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });

  window.dispatchEvent(offer);
  render(<InstallJack />);
  const button = screen.getByRole("button", {
    name: "Install Jack on your phone",
  });
  expect(button.parentElement?.className).toContain("md:hidden");
  fireEvent.click(button);
  await waitFor(() => expect(openBrowserPrompt).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: "Install Jack on your phone" })).not.toBeNull();

  window.dispatchEvent(new Event("appinstalled"));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Install Jack on your phone" })).toBeNull(),
  );
});
