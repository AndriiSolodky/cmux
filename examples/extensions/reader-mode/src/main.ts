// Reader mode, built only on cmux-extension-sdk. One command, `Reader Mode: Toggle`: in a browser
// tab it lays the article (title, byline, text, images) over the page as clean, readable text,
// with no ads, menus or popups; the same command takes it away again. The work happens in the page
// (src/page.js, one script per toggle), so nothing big crosses into the extension.
import { browserPage, cmux, command } from "cmux-extension-sdk"
import PAGE_SCRIPT from "./page.js" with { type: "text" }

/** What the page script answers. */
export interface ReaderState {
  reader: boolean
  reason?: "no_article" | "no_browser"
  title?: string
  words?: number
  minutes?: number
}

// The export catalog.json names for local.reader_mode.toggle.
export const toggle = command(async (): Promise<ReaderState> => {
  try {
    const { value } = await browserPage.eval<ReaderState>(PAGE_SCRIPT)
    if (value.reason === "no_article") await cmux.toast({ title: "No article to read on this page", tone: "warning" })
    return value
  } catch (error) {
    if ((error as { code?: string })?.code !== "not_found") throw error
    await cmux.toast({ title: "Reader mode works in a browser tab", tone: "warning" })
    return { reader: false, reason: "no_browser" }
  }
})
