// Capture-only: records examples/extensions/leo-weather (setting `preview`) as scene op traces in
// the reference fake host, one step per second with its 4 s preview timer fired on schedule.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pack } from "../../../cmux-tui/crates/cmux-app-host/tools/pack.ts";
import { FakeHost, type Op } from "../../../cmux-tui/crates/cmux-app-host/js/test/fake-host.ts";

const repo = path.resolve(import.meta.dir, "../../..");
const dir = path.join(repo, "examples/extensions/leo-weather");
const sdk = path.join(repo, "cmux-tui/crates/cmux-extension-sdk/typescript/src/index.ts");
const seconds = 16;
const manifest = JSON.parse(readFileSync(path.join(dir, "cmux-app.json"), "utf8"));
const source = await pack(dir, { sdk });
type Trace = { initial: Op[]; steps: Op[][] };

async function record(variant: string, preview: string, exportName: string): Promise<Trace> {
  const host = new FakeHost(source, { app: { id: manifest.id, version: manifest.version }, settings: { variant, preview }, apiVersion: "1.0.0" });
  const error = host.mount("m", exportName, exportName === "renderNewTab" ? { surface: "newTab" } : {});
  if (error) throw new Error(`${variant}/${preview}/${exportName}: ${error}`);
  await host.settle(10);
  const take = (from: number) => host.batches("m").slice(from).flat();
  const initial = take(0);
  let seen = host.batches("m").length;
  const steps: Op[][] = [];
  for (let s = 1; s <= seconds; s++) {
    if (s % 4 === 0) for (const [id, t] of [...host.timers]) if (t.ms === 4000) host.global.__cmuxAppTimer(id);
    await host.settle(10);
    steps.push(take(seen));
    seen = host.batches("m").length;
  }
  const errors = host.logs.filter(([level]) => level === "error");
  if (errors.length) console.warn(`${variant}/${preview}/${exportName} errors:`, errors);
  return { initial, steps };
}

const traces: Record<string, Trace> = {};
for (const variant of ["sky", "card", "minimal"])
  for (const preview of ["sun", "rain", "snow", "storm", "night", "cloudy"])
    for (const [surface, name] of [["section", "renderSection"], ["tab", "renderNewTab"]] as const)
      traces[`${variant}-${preview}-${surface}`] = await record(variant, preview, name);
const out = path.join(repo, "webviews/src/apps/scene/fixtures/leo-weather-traces.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(traces));
console.log(`wrote ${out} (${Object.keys(traces).length} traces)`);
