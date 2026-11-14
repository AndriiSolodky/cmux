// A tool call's row counts its commits while the page measures (perf.ts, debug.ts `renders`):
// `tool:<call id>` for each commit and `tool-mount:<call id>` for each mount. A settled call that
// draws again or mounts again on a stream update that is not its own is the flicker this counts
// (test/agent-pane-tool-row-renders.test.ts). Until a measurement call it costs one branch.
import { useLayoutEffect } from "react";
import { acpmuxPerf } from "../perf";

export function useToolRowCount(id: string | undefined): void {
  useLayoutEffect(() => {
    if (acpmuxPerf.enabled) acpmuxPerf.render(`tool:${id}`);
  });
  useLayoutEffect(() => {
    if (acpmuxPerf.enabled) acpmuxPerf.render(`tool-mount:${id}`);
  }, [id]);
}
