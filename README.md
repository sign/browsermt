# `sign`/browsermt

Based on https://github.com/gjuchault/typescript-library-starter

This library is designed as a drop-in to run Bergamot models in the browser.

## Installation

```
npm install @sign-mt/browsermt
```

## Usage

```ts
import { createBergamotWorker } from "@sign-mt/browsermt";
// OR import {createBergamotWorker} from 'https://unpkg.com/@sign-mt/browsermt@0.0.2/build/bundled/index.js'

const worker = createBergamotWorker(
  "/node_modules/@sign-mt/browsermt/build/esm/worker.js"
);
// OR createBergamotWorker('https://unpkg.com/@sign-mt/browsermt@0.0.2/build/bundled/worker.js')

// Copy these artifacts to your deployed folder
await worker.importBergamotWorker(
  "browsermt/bergamot-translator-worker.js",
  "browsermt/bergamot-translator-worker.wasm"
);

// Create object with URLs to the model files
const modelRegistry = {
  enru: {
    model: { name: "/models/enru/model.enru.intgemm.alphas.bin" },
    lex: { name: "/models/enru/lex.50.50.enru.s2t.bin" },
    vocab: { name: "/models/enru/vocab.enru.spm" },
  },
};

await worker.loadModel("en", "ru", modelRegistry);

const translations = await worker.translate(
  "en",
  "ru",
  ["test sentence", "other sentence"],
  [{ isHtml: false }, { isHtml: false }]
);
console.log(translations);
```
