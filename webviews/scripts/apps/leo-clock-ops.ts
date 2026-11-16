// SCRATCH (not committed): runs examples/extensions/leo-clock in the fake host and writes its scene ops,
// one flattened batch for the mount and one per simulated second, for LeoClockPreview to replay.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { pack } from "../../../cmux-tui/crates/cmux-app-host/tools/pack.ts"
import { FakeHost } from "../../../cmux-tui/crates/cmux-app-host/js/test/fake-host.ts"

const repo = join(import.meta.dir, "../../..")
const built = await pack(join(repo, "examples/extensions/leo-clock"))
const T0 = Date.UTC(2026, 10, 16, 18, 41, 50) // 18:41:50 local (offset 0): the minute rolls over 10 s in
const out: Record<string, unknown[][]> = {}
for (const variant of ["analog", "flip", "ring"]) {
  const h = new FakeHost(built, { app: { id: "local/leo-clock", version: "1.0.0" }, settings: { variant, name: "Leo", zones: "America/Los_Angeles, America/New_York, Europe/London, Asia/Tokyo" }, apiVersion: "1.0.0" })
  h.eval(`Date.now = () => globalThis.__now; Date.prototype.getTimezoneOffset = () => 0; globalThis.__now = ${T0}`)
  h.mount("m", "renderNewTab", { surface: "newTab" })
  const steps: unknown[][] = [h.batches("m").flat()]
  let seen = h.batches("m").length
  for (let i = 1; i <= 20; i++) {
    const [id] = [...h.timers.keys()]
    h.timers.delete(id!)
    h.eval(`globalThis.__now = ${T0 + i * 1000}`)
    h.global.__cmuxAppTimer(id)
    steps.push(h.batches("m").slice(seen).flat())
    seen = h.batches("m").length
  }
  out[variant] = steps
  console.log(variant, steps.map((s) => s.length).join(","))
}
writeFileSync(join(repo, "webviews/src/apps/scene/leo-clock-ops.json"), JSON.stringify(out))
