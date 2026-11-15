// cmux-web-test-timeout: 300
// l10n-allow-file: the stand-in chat's text and assertions, not shipped UI.
// A chat with a turn open and nothing arriving paints nothing on the main thread: its running marks (the
// spinners, the live line's shimmer, the worked-for time) move on the compositor, and the transcript is never
// painted again for them (cmuxterm-hq goals/chats-flat-at-any-length.md: "A chat should cost about what an empty
// chat costs while idle"). Leo's NIGHTLY, 2026-11-15, a coordinator chat with a turn running: 1.88-2.1 GB,
// 102-118 % CPU, 455-557 frames every 5 s, 0.4-1.3 s of long tasks every 5 s.
//
// The production pane (a vite build) in Chromium, the engine of the app's agent renderer, on the papercut stand-in
// daemon: a chat of TURNS finished turns and one open turn whose two commands run. Once it settles, a CDP trace over
// WINDOW_S seconds of nothing (bench/paintWindow.ts) counts the main-thread paints, and the page lists its running
// animations and what each one animates.
// Locally: CMUX_BROWSER_TESTS=1 bun test test/agent-pane-running-idle-paint.test.ts
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { describePaintWindow, paintWindow } from "../bench/paintWindow";
import { papercutPane } from "./support/papercutChat";
import { requireBrowserLane } from "./support/requireBrowserLane";

await requireBrowserLane("agent-pane-running-idle-paint.test.ts", async () => {
  setDefaultTimeout(280_000);
  const TURNS = 60;
  const WINDOW_S = 4;
  // The live line's time ("1m 4s") changes once a second, and a shimmer sweep starts every 4 s: each is a paint of
  // its own small line. Four a second leaves room for both and for a runner's late frame, and is far below the one
  // paint a frame (60 a second) of a loop the compositor does not run.
  const MAX_PAINTS_PER_S = 4;
  let browser: Browser | undefined;
  let pane: Awaited<ReturnType<typeof papercutPane>> | undefined;
  afterAll(async () => {
    await pane?.close();
    await browser?.close();
  });

  test("an open turn's running marks animate on the compositor and paint nothing a frame", async () => {
    browser = await chromium.launch({ headless: true });
    pane = await papercutPane(() => browser!, {
      turns: TURNS,
      running: true,
      ready: ".cv-spinner[data-working]",
      production: {},
    });
    const page = await pane.open({ width: 1200, height: 800 });
    const cdp = await page.context().newCDPSession(page);
    // fixed-wait: the rows' first measures and the live line's first shimmer pass are over.
    await page.waitForTimeout(1500);
    const window = await paintWindow(page, cdp, WINDOW_S);
    console.log(describePaintWindow("running turn, idle", window));
    const shown = window.animations.filter((animation) => animation.onScreen);
    expect(shown.length).toBeGreaterThan(0);
    expect(
      shown.filter((animation) => !animation.compositable).map((a) => `${a.name} on ${a.target}: ${a.properties}`),
    ).toEqual([]);
    expect(window.notComposited).toEqual([]);
    expect(window.paintsPerS).toBeLessThanOrEqual(MAX_PAINTS_PER_S);
  });
});
