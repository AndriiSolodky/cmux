// A record batched for a frame paints in that frame (Leo, 2026-11-16: "it shuold be instant even
// under load"). The client emits a frame's snapshot from the frame callback (direct.ts
// `emitInFrame`); the pane sets it as React state there. A default-priority update from a frame
// callback renders in a scheduler task after the frame, so the record drew a frame late: 250 ms to
// 1 s on Leo's loaded NIGHTLY (4 fps). The frame is modelled as its callbacks, then the paint: what
// the document holds when the callbacks return is what that frame shows.
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { drawInFrame } from "./drawInFrame";
import { teardownDom } from "../../../test/support/domTeardown";

const scope = globalThis as Record<string, unknown>;
const keys = [
  "window",
  "document",
  "navigator",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
];
const saved = keys.map((key) => [key, key in scope, scope[key]] as const);
let root: Root | undefined;
let view: { close(): void } | undefined;

afterEach(async () => {
  root?.unmount();
  root = undefined;
  await teardownDom(saved, { window: view });
  view = undefined;
});

/// A page whose frames run only when the test says, and a chat that shows its newest record.
function page() {
  const dom = new JSDOM("<!doctype html><html><body><main id=root></main></body></html>", { url: "http://localhost/" });
  view = dom.window;
  const callbacks: (() => void)[] = [];
  Object.assign(scope, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    requestAnimationFrame: (callback: () => void) => callbacks.push(callback),
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: false,
  });
  let receive: (text: string) => void = () => {};
  function Chat() {
    const [text, setText] = useState("");
    receive = setText;
    return <p id="row">{text}</p>;
  }
  const container = dom.window.document.getElementById("root")!;
  root = createRoot(container);
  return {
    mount: async () => {
      root!.render(<Chat />);
      await tasks();
    },
    /// A record arrives: the client batches it for the next frame, as `emitInFrame` does.
    arrive: (text: string) => drawInFrame(() => receive(text)),
    /// One display frame: its callbacks, then the paint. Returns what the frame painted, then lets
    /// the tasks after the frame run.
    frame: async () => {
      for (const callback of callbacks.splice(0)) callback();
      const painted = dom.window.document.getElementById("row")!.textContent;
      await tasks();
      return painted;
    },
  };
}

const tasks = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

test("a record batched for the next frame paints in that frame, not the one after", async () => {
  const chat = page();
  await chat.mount();
  // Frames to paint for each of 20 records, each arriving between two frames.
  const frames: number[] = [];
  for (let record = 1; record <= 20; record += 1) {
    chat.arrive(`record ${record}`);
    let count = 1;
    while ((await chat.frame()) !== `record ${record}` && count < 5) count += 1;
    frames.push(count);
  }
  expect(frames).toEqual(Array.from({ length: 20 }, () => 1));
});
