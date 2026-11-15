// Scratch measurement harness for the MCP deck viewer (not committed).
// Serves cmux-tui/.../pptx_view.html exactly as pptx_view.rs does (same template, same
// policy) and opens three public decks in Playwright Chromium.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = process.env.FAST_CHECKS_OUT || "/tmp/pptx-out";
mkdirSync(out, { recursive: true });
const rs = readFileSync(join(root, "cmux-tui/crates/cmux-tui/src/cli/mcp/pptx_view.rs"), "utf8");
const lib = rs.match(/RENDERER_URL: &str = "([^"]+)"/)[1];
const sri = rs.match(/RENDERER_SRI: &str =\s*"([^"]+)"/)[1];
const template = readFileSync(join(root, "cmux-tui/crates/cmux-tui/src/cli/mcp/pptx_view.html"), "utf8");
const page = (name) => template.replaceAll("{{TITLE}}", name).replaceAll("{{LIB_URL}}", lib).replaceAll("{{LIB_SRI}}", sri);
const scriptHash = (html) => createHash("sha256").update(html.split('<script type="module">')[1].split("</script>")[0]).digest("base64");
const policy = (html) => `default-src 'none'; script-src 'sha256-${scriptHash(html)}' blob:; connect-src 'self' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src 'self' blob: data:; media-src blob: data:; font-src blob: data:; base-uri 'none'; form-action 'none'`;
// Keep the copy honest: the Rust policy must be this one.
const rsPolicy = rs.match(/"default-src 'none';[^]*?form-action 'none'"/)[0].replace(/\\\s*\n\s*/g, "").slice(1, -1);
if (rsPolicy.replace("{}", "X") !== policy("<script type=\"module\"></script>").replace(/sha256-[^']+/, "sha256-X")) throw new Error("policy drift:\n" + rsPolicy);

const names = ["chart-picture-bg", "smartart-simple", "table_test", "SampleShow"];
const decks = {};
for (const n of names) {
  const r = await fetch(`https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/${n}.pptx`);
  decks[n] = new Uint8Array(await r.arrayBuffer());
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  let [, token, rest] = new URL(req.url).pathname.split("/"); const nocsp = token.endsWith("~nocsp"); token = token.replace("~nocsp", "");
  const deck = token === "gone" ? null : decks[token];
  if (rest === "") { const html = page(token + ".pptx"); return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...(nocsp ? {} : { "content-security-policy": policy(html) }), "cache-control": "no-store" } }); }
  if (rest === "deck.pptx") return deck ? new Response(deck, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "cache-control": "no-store" } }) : new Response("gone", { status: 404 });
  return new Response("nf", { status: 404 });
} });
const base = `http://127.0.0.1:${server.port}`;
const report = { page_bytes: Buffer.byteLength(page("deck.pptx")), page_gzip: Bun.gzipSync(page("deck.pptx")).length, decks: {} };
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
report.browser = browser.version();

async function open(context, n, scheme = "light", viewport = { width: 1280, height: 800 }) {
  const p = await context.newPage();
  await p.emulateMedia({ colorScheme: scheme });
  await p.setViewportSize(viewport);
  const errors = [];
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push(String(e))); p.on("response", (r) => r.status() >= 400 && errors.push(r.status() + " " + r.url())); p.on("requestfailed", (r) => errors.push("failed " + r.url()));
  const t0 = Date.now();
  await p.goto(`${base}/${n}/`);
  await p.waitForSelector("body[data-ready]", { timeout: 60000 }).catch(async () => errors.push("not ready: " + (await p.textContent("#stage"))));
  const ms = Date.now() - t0;
  const libMs = await p.evaluate((u) => performance.getEntriesByName(u)[0]?.duration ?? null, lib);
  return { p, ms, errors, lib: libMs };
}

for (const n of names) {
  const context = await browser.newContext();
  const cold = await open(context, n);
  const count = await cold.p.$$eval("#strip button", (b) => b.length);
  const r = { slides: count, first_open_ms: cold.ms, renderer_fetch_ms: cold.lib && Math.round(cold.lib), errors: cold.errors };
  await cold.p.waitForTimeout(500);
  for (let i = 0; i < count; i++) {
    await cold.p.screenshot({ path: join(out, `${n}-slide${i + 1}-light.png`) });
    if (i < count - 1) { await cold.p.keyboard.press("ArrowRight"); await cold.p.waitForTimeout(300); }
  }
  r.pos_after_arrows = await cold.p.textContent("#pos");
  const warm = await open(context, n, "dark");
  r.second_open_ms = warm.ms;
  r.errors.push(...warm.errors);
  await warm.p.waitForTimeout(500);
  await warm.p.screenshot({ path: join(out, `${n}-dark.png`) });
  const narrow = await open(context, n, "light", { width: 600, height: 700 });
  await narrow.p.waitForTimeout(300);
  r.strip_hidden_under_640 = await narrow.p.$eval("#strip", (s) => getComputedStyle(s).display === "none");
  await narrow.p.screenshot({ path: join(out, `${n}-narrow600.png`) });
  const bare = await open(context, n + "~nocsp");
  await bare.p.waitForTimeout(500);
  await bare.p.screenshot({ path: join(out, `${n}-nopolicy.png`) });
  r.nopolicy_errors = bare.errors;
  report.decks[n] = r;
  await context.close();
}
{
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto(`${base}/gone/`);
  await p.waitForFunction(() => /deleted|renderer/.test(document.getElementById("stage").textContent), null, { timeout: 30000 });
  report.deleted_notice = await p.textContent("#stage");
  await p.screenshot({ path: join(out, `deleted.png`) });
  await context.close();
}
await browser.close();
server.stop();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
