// Renders each mock in .app-mocks with the default theme pair's real web tokens (gallery theme code,
// the same payload WebTheme.swift sends) to PNG, light and dark. Usage: bun .app-mocks/render.ts OUT
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { parseGhosttyTheme } from "../src/theme/ghosttyTheme";
import { themeTokens, webThemePayload } from "../src/gallery/theme/web";
import { css } from "../src/gallery/theme/tokens";

const here = import.meta.dir;
const out = process.argv[2] ?? join(here, "out");
mkdirSync(out, { recursive: true });
const sheet = readFileSync(join(here, "mock.css"), "utf8");
const schemes = { dark: "Apple System Colors", light: "Apple System Colors Light" } as const;

function vars(themeName: string): { decl: string; scheme: string } {
  const text = readFileSync(join(here, "../../Resources/ghostty/themes", themeName), "utf8");
  const theme = parseGhosttyTheme(themeName, text)!;
  const tokens = themeTokens(theme);
  const payload = webThemePayload(tokens);
  const all: Record<string, string> = {
    ...payload.variables,
    "--mock-ok": css(tokens.success),
    "--mock-bad": css(tokens.danger),
    "--mock-warn": css(tokens.attention),
  };
  return { decl: Object.entries(all).map(([k, v]) => `${k}: ${v};`).join(" "), scheme: payload.colorScheme };
}

const only = process.argv[3];
const browser = await chromium.launch();
for (const file of readdirSync(here).filter((f) => f.endsWith(".html") && (!only || f.startsWith(only)))) {
  const src = readFileSync(join(here, file), "utf8");
  for (const [mode, themeName] of Object.entries(schemes)) {
    const { decl, scheme } = vars(themeName);
    const html = src.replace(
      '<link rel="stylesheet" href="mock.css">',
      `<style>:root { color-scheme: ${scheme}; ${decl} }\n${sheet}</style>`,
    );
    const base = `${file.replace(/\.html$/, "")}-${mode}`;
    writeFileSync(join(out, `${base}.html`), html);
    const page = await browser.newPage({ viewport: { width: 1240, height: 800 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "load" });
    await page.locator(".page").screenshot({ path: join(out, `${base}.png`) });
    await page.close();
    console.log(`wrote ${base}.png`);
  }
}
await browser.close();
