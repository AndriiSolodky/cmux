// l10n-allow-file: gallery fixture text, not shipped UI.
// Capture-only: examples/extensions/leo-weather (setting `preview`) drawn by the web scene renderer
// from the op batches its renderSection / renderNewTab emitted in the fake host.
import { useEffect, useState } from "react";
import { componentEntry } from "../../gallery/format";
import type { Play } from "../../gallery/play";
import traces from "./fixtures/leo-weather-traces.json";
import { SceneRenderer } from "./SceneRenderer";
import { SceneStore, type SceneOp } from "./store";

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

function LeoWeather({ look = "sky", sky = "rain" }: { look?: string; sky?: string }) {
  const section = usePlayback(`${look}-${sky}-section`);
  const tab = usePlayback(`${look}-${sky}-tab`);
  return (
    <div style={{ display: "flex", gap: 16, padding: 12, alignItems: "stretch", height: 536, boxSizing: "border-box" }}>
      <div data-surface="section" style={{ width: 260, flex: "none", padding: 8, borderRadius: 10, background: "rgba(127,127,127,0.10)", alignSelf: "flex-start" }}>
        <SceneRenderer store={section} dispatch={() => {}} />
      </div>
      <div data-surface="tab" style={{ flex: 1, minWidth: 0, display: "flex", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <SceneRenderer store={tab} dispatch={() => {}} />
        </div>
      </div>
    </div>
  );
}

const ready: Play = async (ctx) => {
  await ctx.waitFor(() => ctx.document.querySelectorAll(".cmux-app-scene-root").length === 2);
};
const v = (look: string, sky: string) => ({ note: `${look} look, ${sky} sky`, props: { look, sky }, play: ready });

export default componentEntry<{ look?: string; sky?: string }>({
  id: "apps.leo-weather",
  title: "Leo weather (example extension)",
  area: "Apps",
  pane: true,
  height: 560,
  widths: { narrow: 900, normal: 1100 },
  keywords: ["weather", "extension", "motion", "particles"],
  covers: ["apps/scene/SceneRenderer.tsx", "apps/scene/SceneParticles.tsx", "apps/scene/motionProps.ts"],
  load: async () => LeoWeather,
  variants: {
    "sky-rain": v("sky", "rain"),
    "sky-snow": v("sky", "snow"),
    "sky-sun": v("sky", "sun"),
    "sky-storm": v("sky", "storm"),
    "sky-night": v("sky", "night"),
    "card-sun": v("card", "sun"),
    "card-rain": v("card", "rain"),
    "minimal-snow": v("minimal", "snow"),
    "minimal-sun": v("minimal", "sun"),
  },
});
