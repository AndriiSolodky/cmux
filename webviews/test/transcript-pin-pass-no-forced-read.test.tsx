// "the dream is infinite chats of infinite length with flat or no growth in cpu/memory" and "typing
// under load is not good enough" (Leo). Under load the placement pass's top self cost was
// `layoutScrollTop`: the pass wrote the follow offset (and its sub-pixel origin) and then read the
// scroller back, so each streamed token laid the whole page out again (21.9 ms per key at 1,500 rows
// with a stream). The pass takes the offset and height from what it read before it wrote and from
// what it wrote: no read of the scroller after a write, and the same offset as before.
import { afterAll, expect, test } from "bun:test";
import { JSDOM, VirtualConsole } from "jsdom";
import type { AcpmuxRow } from "../src/agent-session/acpmux/model";
import { turnView } from "../src/agent-session/acpmux/conversation/turns";
import { installJsdomScroller, scrollerEnd } from "./support/jsdomScroller";
import { settleReact } from "./support/domTeardown";

const dom = new JSDOM("<!doctype html><div id=root></div>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
});
dom.window.document.documentElement.dataset.agentMotion = "off";
const scope = globalThis as Record<string, unknown>;
const replacements: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  customElements: dom.window.customElements,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const key of Object.getOwnPropertyNames(dom.window))
  if (/^(HTML|SVG|CSS|Shadow|Document|Mutation)/.test(key) && !(key in scope))
    replacements[key] = (dom.window as unknown as Record<string, unknown>)[key];
const saved = Object.keys(replacements).map((key) => [key, key in scope, scope[key]] as const);
Object.assign(scope, replacements);

const VIEWPORT = 600;
Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 760 });
installJsdomScroller(dom.window as never, () => VIEWPORT);

// The order of the scroller's reads and of the writes to the page (a scroll offset, a style
// property that changed), cut at the end of each placement pass (`followTrace.update`, its last step).
type Step = { kind: "read" | "write"; what: string };
let log: Step[] = [];
const passes: Step[][] = [];
let scroller: HTMLElement | undefined;
const proto = dom.window.HTMLElement.prototype;
for (const name of ["scrollTop", "clientHeight", "scrollHeight"] as const) {
  const real = Object.getOwnPropertyDescriptor(proto, name)!;
  Object.defineProperty(proto, name, {
    configurable: true,
    get(this: HTMLElement) {
      if (this === scroller) log.push({ kind: "read", what: name });
      return real.get!.call(this);
    },
    set(this: HTMLElement, value: number) {
      if (this === scroller) log.push({ kind: "write", what: name });
      real.set?.call(this, value);
    },
  });
}
const style = dom.window.CSSStyleDeclaration.prototype;
const setProperty = style.setProperty;
const removeProperty = style.removeProperty;
style.setProperty = function (this: CSSStyleDeclaration, name: string, value: string | null, priority?: string) {
  const was = this.getPropertyValue(name);
  setProperty.call(this, name, value, priority ?? "");
  if (this.getPropertyValue(name) !== was) log.push({ kind: "write", what: `style ${name}` });
};
style.removeProperty = function (this: CSSStyleDeclaration, name: string) {
  const was = removeProperty.call(this, name);
  if (was) log.push({ kind: "write", what: `style -${name}` });
  return was;
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { VirtualTranscript } = await import("../src/agent-session/acpmux/App");
const { followTrace } = await import("../src/agent-session/acpmux/followTrace");
const update = followTrace.update.bind(followTrace);
followTrace.update = (...args: Parameters<typeof followTrace.update>) => {
  update(...args);
  passes.push(log);
  log = [];
};

afterAll(async () => {
  followTrace.update = update;
  await settleReact();
  dom.window.close();
  for (const [key, had, value] of saved) {
    if (had) scope[key] = value;
    else delete scope[key];
  }
});

/// The scroller's reads that come after a write in the same pass: each lays the page out again.
const readsAfterWrite = (steps: readonly Step[]) => {
  const written = steps.findIndex((step) => step.kind === "write");
  return written < 0 ? [] : steps.slice(written + 1).filter((step) => step.kind === "read");
};

const row = (id: string, kind: string, text?: string, version = 1): AcpmuxRow => ({ id, kind, text, version, at: 1 });
const TURNS = 500;
const history = Array.from({ length: TURNS }, (_, index) => [
  row(`t${index}-user`, "user", `Question ${index}`),
  row(`t${index}-answer`, "assistant", `Answer ${index}.\n\nWith a second paragraph so the turn has height.`),
  { ...row(`t${index}-end`, "turnSummary"), status: "completed", durationMs: 1_000 },
]).flat();
const streaming = (tokens: number) => [
  ...history,
  row("live-user", "user", "Stream a long reply"),
  row(
    "live-answer",
    "assistant",
    Array.from({ length: tokens + 1 }, (_, line) => `Streamed line ${line} with enough words to wrap.`).join("\n\n"),
    tokens + 1,
  ),
];

test("a streamed token's placement pass reads the scroller only before it writes, and follows the bottom", async () => {
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (tokens: number) =>
    root.render(
      <VirtualTranscript
        rows={turnView(streaming(tokens), new Set())}
        onToggleActivity={() => {}}
        expanded={new Set()}
      />,
    );
  try {
    await act(async () => render(0));
    scroller = dom.window.document.querySelector<HTMLElement>(".acpmux-scroll")!;
    expect(scroller.scrollTop).toBe(scrollerEnd(scroller));
    const TOKENS = 8;
    const forced: number[] = [];
    let wrote = 0;
    for (let token = 1; token <= TOKENS; token += 1) {
      const before = scroller.scrollTop;
      passes.length = 0;
      log = [];
      await act(async () => render(token));
      const after = passes.flatMap(readsAfterWrite);
      forced.push(after.length);
      if (passes.some((steps) => steps.some((step) => step.kind === "write"))) wrote += 1;
      // Followed: the view rests at the scroller's end, which moved down with the reply.
      expect(scroller.scrollTop).toBe(scrollerEnd(scroller));
      expect(scroller.scrollTop).toBeGreaterThan(before);
    }
    // Each token's pass wrote the new end (the case that read back), and read nothing after it.
    console.log(`pin pass: scroller reads after a write, per streamed token: ${forced.join(", ")}`);
    expect(wrote).toBe(TOKENS);
    expect(forced).toEqual(Array.from({ length: TOKENS }, () => 0));
  } finally {
    scroller = undefined;
    await act(async () => root.unmount());
  }
});
