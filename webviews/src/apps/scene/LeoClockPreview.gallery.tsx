// l10n-allow-file: gallery fixture text, not shipped UI.
// SCRATCH (not committed): replays examples/extensions/leo-clock's scene op batches (from the fake
// host, one per second) through the web scene renderer, as a New Tab page would draw them.
import { useEffect, useState } from "react";
import { componentEntry } from "../../gallery/format";
import type { Play } from "../../gallery/play";
import { SceneRenderer } from "./SceneRenderer";
import { SceneStore, type SceneOp } from "./store";
import OPS from "./leo-clock-ops.json";
import "../../agent-session/acpmux/newtab/appPage.css";

type Variant = "analog" | "flip" | "ring";

function LeoClockPreview({ variant = "analog" }: { variant?: Variant }) {
  const batches = (OPS as Record<string, SceneOp[][]>)[variant]!;
  const [store] = useState(() => {
    const s = new SceneStore();
    s.apply(batches[0]!);
    return s;
  });
  useEffect(() => {
    let step = 1;
    const timer = window.setInterval(() => {
      if (step < batches.length) store.apply(batches[step++]!);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [store, batches]);
  return (
    <div className="nt-app-page" data-status="ready" style={{ height: "100%" }}>
      <div className="nt-app-page-body">
        <SceneRenderer store={store} dispatch={() => {}} />
      </div>
    </div>
  );
}

const ready: Play = async (ctx) => {
  await ctx.waitFor(() => ctx.document.querySelector(".cmux-app-scene-root") !== null);
};

export default componentEntry<{ variant?: Variant }>({
  id: "apps.leo-clock-preview",
  title: "Leo clock preview",
  area: "Apps",
  pane: true,
  height: 760,
  widths: { narrow: 760, normal: 900 },
  covers: ["apps/scene/SceneRenderer.tsx"],
  load: async () => LeoClockPreview,
  variants: {
    analog: { note: "analog", props: { variant: "analog" }, play: ready },
    flip: { note: "flip", props: { variant: "flip" }, play: ready },
    ring: { note: "ring", props: { variant: "ring" }, play: ready },
  },
});
