# Reader mode: the article, and nothing else

`local/reader-mode` imports nothing but `cmux-extension-sdk`. In a browser tab, **Reader Mode:
Toggle** lays the article over the page as clean, readable text: the site, the title, the byline
and reading time, then the story with its images, quotes, lists, code and tables. Menus, ads,
share bars, related links, cookie banners and popups are gone. Run it again (or press Escape) and
the page is back exactly as it was: reader mode never changes or reloads the page, so the scroll
position and anything you typed stay.

- **One script per toggle.** `src/page.js` runs in the page through `browserPage.eval`
  (`browser.page.eval`). It finds the block whose paragraphs carry the most text, adds the sibling
  blocks of the same story, cleans a copy and draws it in a shadow root, so the page's own styles
  never reach it. Only a small answer (`{reader, title, words, minutes}`) comes back.
- **It asks for one scope, `browser.page:control`.** It lets the extension run a script in the page
  of the browser tab you are reading. cmux shows it highlighted when you turn the extension on, and
  you can take it back in Settings > Extensions.
- **Light and dark** follow the system.

## Run it

```sh
cd examples/extensions/reader-mode
cmux ext dev
```

Then open an article in a browser tab, press Cmd+Shift+P and pick **Reader Mode: Toggle**.

## One key

`catalog.json` asks for Cmd+Shift+R while a browser tab has the keyboard. Until cmux applies an
extension's own shortcuts, bind it yourself in `~/.config/cmux/keybindings.json`:

```jsonc
[
  { "key": "cmd+shift+r", "command": "app.command.run",
    "args": { "app": "local/reader-mode", "command": "local.reader_mode.toggle" },
    "when": "browserFocused" }
]
```

## Tests

`cmux-tui/crates/cmux-app-host/js/test/reader-mode.test.ts` packs the extension and runs the
command in the fake host. `test/page.test.ts` runs the page script against a news page in a DOM
(happy-dom, from `webviews/`).
