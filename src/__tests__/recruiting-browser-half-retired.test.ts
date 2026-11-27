/**
 * 2026-11-27 — Mo retired the Mac browser half (LinkedIn) of the recruiting
 * sweep: the posting is closed and he does not want work that depends on his
 * Mac. Its ">3 days stale" watchdog had emailed him every morning since Nov 25.
 * These tests pin the retirement: the alert is refused server-side (the Console
 * system prompt still carries the old step), the kickoff prompt no longer asks
 * for it, and every other watchdog alert still goes out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRetiredBrowserHalfAlert, sendWatchdogAlert } from "../../api/recruiting-tools";
import { DEFAULT_PROMPT } from "../../api/cron/_recruiting-sweep-prompt";

afterEach(() => vi.unstubAllGlobals());

describe("browser half (LinkedIn) watchdog is retired", () => {
  it("recognises the alert the agent sent on 11/26 and 11/27", () => {
    expect(
      isRetiredBrowserHalfAlert(
        "Browser half (LinkedIn) has not run since Nov 22 — now 5 days stale; LinkedIn applicants accumulating",
        "last_run_browser = 2026-11-22T18:40:00Z.",
      ),
    ).toBe(true);
    expect(isRetiredBrowserHalfAlert("last_run_browser is 4 days old")).toBe(true);
    expect(isRetiredBrowserHalfAlert("Stale", "LinkedIn applicants waiting on the Mac")).toBe(true);
  });

  it("leaves every other watchdog reason alone", () => {
    expect(isRetiredBrowserHalfAlert("hazelequity channel unreadable: token refresh failed")).toBe(false);
    expect(isRetiredBrowserHalfAlert("Indeed channel returned an error", "HTTP 500 from Gmail")).toBe(false);
    expect(isRetiredBrowserHalfAlert("testgorilla_boundary missing from state")).toBe(false);
  });

  it("refuses the LinkedIn alert before touching state or Gmail", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("no network call expected");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const r = await sendWatchdogAlert(
      "Browser half (LinkedIn) has not run since Nov 22 — now 5 days stale",
    );
    expect(r.sent).toBe(false);
    expect(String(r.reason)).toMatch(/retired/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("kickoff prompt no longer asks for the browser-half alert", () => {
    expect(DEFAULT_PROMPT).not.toContain("if last_run_browser is more than 3 days old");
    expect(DEFAULT_PROMPT).not.toContain("waiting on his Mac");
    expect(DEFAULT_PROMPT).toContain("RETIRED");
    // the watchdog tool itself is still wired for other reasons
    expect(DEFAULT_PROMPT).toContain("send_watchdog_alert");
  });
});
