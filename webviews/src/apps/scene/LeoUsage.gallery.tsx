// l10n-allow-file: gallery fixture text, not shipped UI.
// The example extension examples/extensions/leo-usage (source: "demo") in each design variant:
// its sidebar section (left, sidebar width) and its pane (right), drawn by the web scene renderer
// from the exact op batches its renderSection / renderPane exports emitted in the reference fake
// host (scripts/apps/record-leo-usage.ts writes fixtures/leo-usage-traces.json). One recorded batch
// is applied per second, as the app's 1 s demo clock would push them; the springs, pulse, glow,
// gradient and embers are the renderer's.
import { useEffect, useState } from "react";
import { componentEntry } from "../../gallery/format";
import type { Play } from "../../gallery/play";
import traces from "./fixtures/leo-usage-traces.json";
import { SceneRenderer } from "./SceneRenderer";
import { SceneStore, type SceneOp } from "./store";

type Variant = "rings" | "bars" | "neon";
type Trace = { initial: SceneOp[]; steps: SceneOp[][] };
const TRACES = traces as unknown as Record<string, Trace>;

function usePlayback(key: string): SceneStore {
  const [store] = useState(() => {
    const s = new SceneStore();
    s.apply(TRACES[key]!.initial, true);
    return s;
  });
  useEffect(() => {
    const { steps } = TRACES[key]!;
    let step = 0;
    const timer = window.setInterval(() => {
      if (step < steps.length) store.apply(steps[step++]!);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [key, store]);
  return store;
}

function LeoUsage({ variant = "rings" }: { variant?: Variant }) {
  const section = usePlayback(`${variant}-section`);
  const pane = usePlayback(`${variant}-pane`);
  return (
    <div style={{ display: "flex", gap: 16, padding: 12, alignItems: "flex-start" }}>
      <div
        data-surface="section"
        style={{ width: 280, flex: "none", padding: 8, borderRadius: 10, background: "rgba(127,127,127,0.08)" }}
      >
        <SceneRenderer store={section} dispatch={() => {}} />
      </div>
      <div data-surface="pane" style={{ flex: 1, minWidth: 0 }}>
        <SceneRenderer store={pane} dispatch={() => {}} />
      </div>
    </div>
  );
}

const ready: Play = async (ctx) => {
  await ctx.waitFor(() => ctx.document.querySelectorAll(".cmux-app-scene-root").length === 2);
};

export default componentEntry<{ variant?: Variant }>({
  id: "apps.leo-usage",
  title: "Usage meter (example extension)",
  area: "Apps",
  pane: true,
  height: 520,
  widths: { narrow: 760, normal: 900 },
  keywords: ["usage", "tokens", "limits", "extension", "motion", "cmux.watch"],
  covers: ["apps/scene/SceneRenderer.tsx", "apps/scene/SceneParticles.tsx", "apps/scene/motionProps.ts"],
  load: async () => LeoUsage,
  variants: {
    rings: {
      note: "Chosen default: 5-hour (outer) and weekly (inner) rings trimmed from 12 o'clock that spring to each reading, a counter that ticks up, a pace badge that pulses near a limit.",
      props: { variant: "rings" },
      play: ready,
    },
    bars: {
      note: "The same readings as capsule bars whose fill width springs, for a denser sidebar.",
      props: { variant: "bars" },
      play: ready,
    },
    neon: {
      note: "Rings with a glow in each window's tone over a violet gradient with embers that burn faster while agents work.",
      props: { variant: "neon" },
      play: ready,
    },
  },
});
