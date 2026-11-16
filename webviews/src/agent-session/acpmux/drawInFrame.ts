// A record that is ready paints on the next frame, also under load (Leo, 2026-11-16: "it shuold be
// instant even under load").
//
// The client batches the records of one display frame into one snapshot, emitted from that frame's
// callback (`nextFrame`, direct.ts `emitInFrame`). The pane's `setSnapshot` from a frame callback is
// a default-priority update: React renders it in a scheduler task, which runs after the frame has
// rendered, so the record drew one frame later than the frame it was batched for. On Leo's loaded
// NIGHTLY (about 4 fps, 2026-11-16) that frame was 250 ms to 1 s. Committing the snapshot inside the
// frame callback (`flushSync`) puts it in the frame it was batched for. The 50 ms fallback for a page
// that draws no frames commits at once the same way, and paints with the next frame there is.
//
// Cost: the snapshot's render moves from the task after the frame into the frame itself, the same
// work, once per frame at most (the batch). Stop condition: none of its own; `nextFrame`'s.
import { flushSync } from "react-dom";
import { nextFrame } from "./direct";

/// `AcpmuxDirectClient.scheduleFrame` for a page that draws the transcript with React.
export const drawInFrame = (run: () => void): (() => void) => nextFrame(() => flushSync(run));
