# Jev Find

Ctrl-F for meaning and guided reading, powered by [TypeSafe](https://typesafe.ai). Jev points to the author's words; it never generates source-looking text for you to read.

Search for paraphrases (`can I get my money back`), intent (`where does the author admit a mistake`), or properties (`commitments with a date attached`). Dotted underlines show literal matches for comparison.

<img src="extension/screenshot.png" alt="Jev Find preview" width="640">

## Install

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** → `extension/`.
2. Open the extension's **Settings** (toolbar icon → Settings, or right-click → Options), paste your [TypeSafe](https://typesafe.ai) API key, and save.
3. Open `extension/test/sample.html`, press `Ctrl/Cmd+Shift+F`, and try a query above.

Change the shortcut at `chrome://extensions/shortcuts` if needed.

## Usage

- **Find** scores sentences against a semantic query and runs after 650 ms of idle typing.
- **Digest** takes a question when you press Enter, selects 3–7 paragraph-sized passages, and turns the page into a focused reading view. Selected passages and their headings stay vivid while the rest of the page gently recedes without changing its layout. Use **Full page** to remove the focus treatment.
- Digest roles include direct answer, background, explanation, evidence, important exception, and counterpoint. The strongest qualification or counterpoint becomes **The catch**, with a distinct amber marker. The numbered highlights and panel link back to the original passages.
- Digest always opens expanded so you can type your question. After a reading path is found you can collapse to a small movable HUD; **Collapse panel after results** in Settings does this automatically. Click **Digest** in the HUD to expand it again. The chosen panel position is remembered.
- Closing the panel (**Esc** or the close button) discards the query: reopening it starts empty so you can ask something new.
- Selected page text becomes the initial query.
- **Enter / Shift+Enter** moves to the next / previous match; **Esc** closes.
- Highlight intensity reflects probability: solid at 0.72+, faint down to the threshold. The current match's probability appears beside the count.
- Adjust the threshold slider (default 0.45) to repaint Find results or rebuild the Digest reading path instantly without new requests.
- Dotted underlines mark literal matches; the status line compares literal and semantic counts.
- Click **yes / no** to label the current match and advance. Labels stay in local storage; export them from Settings as `labels.json`.

## How it works

`extension/content.js` extracts visible text into sentences and paragraph-sized passages with DOM ranges.

Find sends a window of sentences with one independent yes/no (**Noul**) question per sentence. Digest sends smaller windows with a relevance Noul and a semantic-role **Choice** for each passage. Code—not the model—uses those typed judgments to choose a diverse reading path, cap it at seven passages, order it like the source, and paint its annotations.

Independent probabilities let multiple sentences score highly. A Choice over sentence IDs would make their probabilities sum to one. Neighboring sentences provide context, but each sentence is judged separately.

The CSS Custom Highlight API paints source ranges without wrapping or rewriting the page text. Digest adds removable numbered markers beside selected passages. Results are cached per query and window for the session, so repeated queries and threshold changes need no new requests.

## Layout

```
.
  extension/    # Chrome extension (load this folder via chrome://extensions)
  jev-digest/     # `jev-digest` PDF CLI (Python; see jev-digest/README.md)
```
