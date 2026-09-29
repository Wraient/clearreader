# ClearReader

A Manifest V3 browser extension (Brave, Chrome, any Chromium) that reads web
articles aloud. The differentiator: an LLM first rewrites the article into a
**listenable script** (cruft removed, tables turned into spoken comparisons,
diagrams and charts described from alt text and captions, code summarized
instead of read), then a TTS model voices it. You bring your own API keys;
nothing is proxied through anyone else's server.

## Install (Brave)

1. Open `brave://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder (`reader-extension`)
4. Open the extension's **Options** page and add your API key

## Setup

In Options, pick a provider and fill in the key:

- **OpenAI**: API key, chat model (default `gpt-4o-mini`, cheap), TTS model
  (default `tts-1`), voice (default `alloy`)
- **Gemini**: Google AI Studio key, model (default `gemini-2.0-flash`)
- **OpenAI-compatible**: any base URL + key + model names (self-hosted
  proxies, local OpenAI-style servers)

Press **Test connection** to send one tiny "say hi" request and verify the
key works without spending real tokens.

## Use

- Click the toolbar icon, then **Read this article**
- Right-click a page and choose **Read article aloud**
- The floating player appears bottom-right: play/pause, -15s / +15s,
  speed cycler (1x, 1.25x, 1.5x, 2x), clickable progress bar, close

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+R` | Read the current article |
| `Alt+Shift+P` | Play / pause |
| `Space` (player open) | Play / pause |
| `Left` / `Right` (player open) | Seek 15s back / forward |
| `Esc` (player open) | Close the player |

Shortcuts do nothing while you are typing in a text field.

## How the pipeline works

1. **Extract** (`content.js` + `vendor/readability.js`): Readability parses a
   cloned DOM into title, byline, and article text. Falls back to selected
   text, then body text.
2. **Script** (`background.js`): the article (truncated to ~12000 chars) goes
   to your chosen LLM with a prompt that produces a listenable script.
3. **Voice** (`background.js`): the script is split at sentence boundaries
   into <=4000 char chunks and synthesized one chunk at a time, one ahead
   prefetched.
4. **Play** (`offscreen.html` / `offscreen.js`): audio must live in an
   offscreen document because MV3 service workers cannot hold audio. A single
   Audio element plays the queue in order and reports progress.
5. **UI** (`content.js`): the player is injected in a Shadow DOM so page CSS
   cannot break it. Progress and status flow background -> content script.

Keys live only in `chrome.storage.local` and are sent only to the provider
you selected. Article text is sent to the LLM provider; audio chunks come
from the TTS provider.

## Files

- `manifest.json` - MV3 manifest, permissions, commands
- `background.js` - service worker orchestrator (extract -> LLM -> TTS -> offscreen)
- `content.js` - article extraction trigger, floating Shadow-DOM player, shortcuts
- `offscreen.html` / `offscreen.js` - audio playback document
- `popup.html` / `popup.js` - toolbar popup
- `options.html` / `options.js` - provider and key settings, connection test
- `vendor/readability.js` - genuine Mozilla Readability (Apache 2.0), article extractor

## Limitations

- LLM rewrite and TTS verified end to end with a real OpenAI key against
  the claude.dev eval article (2026-09-29): figures narrated, tables spoken,
  valid mp3 output. Message protocol between background/offscreen/content is
  logic-reviewed but not runtime-tested; loading unpacked in Brave and clicking
  Test will surface any issue fast.
- Gemini TTS is best effort; the OpenAI path is the primary one.
