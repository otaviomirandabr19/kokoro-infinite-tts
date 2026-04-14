# Kokoro Infinite TTS

A browser-only long-form text-to-speech studio built with React, Vite, and [`kokoro-js`](https://github.com/hexgrad/kokoro/tree/main/kokoro.js).

## What it does

- renders **very long text** by chunking it into Kokoro-safe segments
- streams chunks one after another in the browser as they finish
- merges finished chunks into **one downloadable WAV**
- supports **English and Portuguese** voice presets
- runs with **WebGPU when available**, with a **WASM fallback** when it is not
- requires **no backend** and no paid speech API

## Feasibility notes

Yes — this approach works without a backend.

`kokoro-js` already supports browser execution through Transformers.js, and Kokoro voice files are fetched directly by the browser. The main constraint is not “can it run client-side?” but rather “how do we keep long input safe for the model?”

This app solves that by:

1. normalizing the text
2. splitting by sentence first
3. falling back to clause and word boundaries for oversized segments
4. rendering each chunk sequentially
5. stitching the final output into one WAV export

That makes the experience effectively “infinite” for user-sized scripts, even though each individual generation pass still stays within Kokoro’s safe input envelope.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run lint
npm run build
```

## Deployment

This repository includes a GitHub Actions workflow that deploys the static Vite build to **GitHub Pages**.

The Vite config uses a relative base path (`./`) so the app can be served from a project Pages URL without extra rewrites.

## Stack

- React 19
- TypeScript
- Vite
- kokoro-js
- GitHub Pages
