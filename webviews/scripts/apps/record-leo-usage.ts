// Records the example extension examples/extensions/leo-usage (source: "demo") as scene op traces:
// it packs src/main.ts, mounts renderSection and renderPane in the reference fake host
// (cmux-app-host js/test/fake-host.ts) per variant, and fires its 1 s timers on a fake clock for
// SECONDS seconds. Each trace is { initial: ops, steps: ops[] } (one step per second), which the
// gallery entry apps.leo-usage feeds to the real SceneStore + SceneRenderer.
// Usage: bun scripts/apps/record-leo-usage.ts [SECONDS]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pack } from "../../../cmux-tui/crates/cmux-app-host/tools/pack.ts";
import { FakeHost, type Op } from "../../../cmux-tui/crates/cmux-app-host/js/test/fake-host.ts";

const repo = path.resolve(import.meta.dir, "../../..");
const dir = path.join(repo, "examples/extensions/leo-usage");
const sdk = path.join(repo, "cmux-tui/crates/cmux-extension-sdk/typescript/src/index.ts");
const seconds = Number(process.argv[2] ?? 14);
const manifest = JSON.parse(readFileSync(path.join(dir, "cmux-app.json"), "utf8"));
const source = await pack(dir, { sdk });

type Trace = { initial: Op[]; steps: Op[][] };

async function record(variant: string, exportName: string): Promise<Trace> {
  // A fake clock, installed before the app loads (its clock starts at load): the demo fixture and
  // the countdowns read Date.now().
  let now = Date.UTC(2026, 10, 15, 18, 0, 0);
  const clock = `globalThis.__now = ${now}; Date.now = () => globalThis.__now;\n`;
  const host = new FakeHost(clock + source, {
    app: { id: manifest.id, version: manifest.version },
    settings: { variant, source: "demo" },
    apiVersion: "1.0.0",
  });
  host.handlers["chat.list"] = () => ({ ok: true, body: { value: [] } });
  const error = host.mount("m", exportName);
  if (error) throw new Error(`${variant}/${exportName}: mount failed: ${error}`);
  await host.settle(10);
  const take = (from: number) => host.batches("m").slice(from).flat();
  const initial = take(0);
  let seen = host.batches("m").length;
  const steps: Op[][] = [];
  for (let s = 0; s < seconds; s++) {
    now += 1000;
    host.ctx.__now = now;
    for (const [id, t] of [...host.timers]) {
      if (t.ms > 1000) continue;
      if (!t.repeat) host.timers.delete(id);
      host.global.__cmuxAppTimer(id);
    }
    await host.settle(10);
    steps.push(take(seen));
    seen = host.batches("m").length;
  }
  const errors = host.logs.filter(([level]) => level === "error");
  if (errors.length) console.warn(`${variant}/${exportName} logged errors:`, errors);
  const pending = [...host.timers.values()].map((t) => t.ms);
  console.log(
    `${variant}/${exportName}: initial ${initial.length} ops, steps ${steps.map((o) => o.length).join(",")}, pending timers ${pending.join(",")}`,
  );
  return { initial, steps };
}

const traces: Record<string, Trace> = {};
for (const variant of ["rings", "bars", "neon"]) {
  for (const [surface, name] of [
    ["section", "renderSection"],
    ["pane", "renderPane"],
  ] as const) {
    traces[`${variant}-${surface}`] = await record(variant, name);
  }
}
const out = path.join(repo, "webviews/src/apps/scene/fixtures/leo-usage-traces.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(traces));
console.log(`wrote ${out}`);
