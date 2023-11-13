/// <reference lib="webworker" />

import { IncomingMessage } from "http";

import { isNode } from "browser-or-node";
import * as comlink from "comlink";
import { FileInfo, ModelRegistry, TranslationOptions } from "./index";

comlink.expose({ importBergamotWorker, loadModel, translate });

const timing: Record<string, number> = { workerStart: Date.now() };

const FILE_INFO: FileInfo[] = [
  { type: "model", alignment: 256 },
  { type: "lex", alignment: 64 },
  { type: "vocab", alignment: 64 },
  { type: "qualityModel", alignment: 64 },
];

function log(...args: any[]) {
  console.debug(...args);
}

function logTime(timingKey: string, ...args: any[]) {
  const time = (Date.now() - timing[timingKey]) / 1000;
  log(...args, `${time} secs`);
}

interface TranslationServiceConfig {
  cacheSize: number;
}

interface TranslationService {
  new (config: TranslationServiceConfig): TranslationService;

  translateViaPivoting: (
    translationModelSrcToPivot: any,
    translationModelPivotToTarget: any,
    vectorSourceText: any,
    vectorResponseOptions: any
  ) => any;

  translate: (
    translationModel: any,
    vectorSourceText: any,
    vectorResponseOptions: any
  ) => ResponseVector;
}

let translationService: TranslationService;

let runtimeInitializedPromiseResolve: CallableFunction;
const runtimeInitializedPromise = new Promise(
  (resolve) => (runtimeInitializedPromiseResolve = resolve)
);

// bergamot-translator-worker.js expects a "Module" object to be available
let workerWasmFilePath: string;

(globalThis as any).Module = {
  preRun: [
    () => {
      logTime("workerStart", "Time until Module.preRun");
      timing.moduleLoadStart = Date.now();
    },
  ],

  locateFile: () => {
    return workerWasmFilePath;
  },

  onRuntimeInitialized: async () => {
    logTime(
      "moduleLoadStart",
      "Wasm Runtime initialized Successfully (preRun -> onRuntimeInitialized)"
    );
    runtimeInitializedPromiseResolve();
  },
} as any;

async function importBergamotWorker(
  jsFilePath: string,
  wasmFilePath: string | Buffer
) {
  if (typeof wasmFilePath === "string") {
    workerWasmFilePath = wasmFilePath;
  } else {
    (globalThis as any).Module.wasmBinary = wasmFilePath;
  }

  if (isNode) {
    const fs = require("fs");
    const code = fs.readFileSync(jsFilePath, "utf-8");
    const vm = require("vm");
    vm.runInThisContext(code);
  } else {
    importScripts(jsFilePath);
  }
  await runtimeInitializedPromise;
}

async function loadModel(
  from: string,
  to: string,
  modelRegistry: ModelRegistry
) {
  timing.loadModelStart = Date.now();

  try {
    await constructTranslationService();
    await constructTranslationModel(from, to, modelRegistry);
    logTime("loadModelStart", `Model '${from}-${to}' successfully constructed`);
    return "Model successfully loaded";
  } catch (error: any) {
    console.error(error);
    log(`Model '${from}${to}' construction failed:`, error.message);
    return "Model loading failed";
  }
}

function translate(
  from: string,
  to: string,
  sentences: string[],
  options: TranslationOptions[]
) {
  timing.translateStart = Date.now();

  const wordCount = sentences.reduce(
    (acc, sentence) => acc + _wordsCount(sentence),
    0
  );
  let result;
  try {
    log(`Blocks to translate: ${sentences.length}`);
    result = _translate(from, to, sentences, options);
    const secs = (Date.now() - timing.translateStart) / 1000;
    log(
      `Speed: ${Math.round(
        wordCount / secs
      )} WPS (${wordCount} words in ${secs} secs)`
    );
  } catch (error: any) {
    log(`Error:`, error.message);
  }
  return result;
}

// All variables specific to translation service

// A map of language-pair to TranslationModel object
const languagePairToTranslationModels = new Map();

const PIVOT_LANGUAGE = "en";

onmessage = async function (e) {
  const command = e.data[0];
  log(`Message '${command}' received from main script`);
  if (command === "translate") {
    const from = e.data[1];
    const to = e.data[2];
    const input = e.data[3];
    const translateOptions = e.data[4];
    const result = translate(from, to, input, translateOptions);
    console.warn(result);
    log(`'${command}' command done, Posting message back to main script`);
    postMessage([`${command}_reply`, result]);
  }
};

// Instantiates the Translation Service
const constructTranslationService = async () => {
  if (!translationService) {
    const config: TranslationServiceConfig = { cacheSize: 20000 };
    log(`Creating Translation Service with config`, config);
    translationService = new (globalThis as any).Module.BlockingService(config);
    log(`Translation Service created successfully`);
  }
};

// Constructs translation model(s) for the source and target language pair (using
// pivoting if required).
const constructTranslationModel = async (
  from: string,
  to: string,
  modelRegistry: ModelRegistry
) => {
  // Delete all previously constructed translation models and clear the map
  languagePairToTranslationModels.forEach((value, key) => {
    log(`Destructing model '${key}'`);
    value.delete();
  });
  languagePairToTranslationModels.clear();

  if (_isPivotingRequired(from, to)) {
    // Pivoting requires 2 translation models
    const languagePairSrcToPivot = _getLanguagePair(from, PIVOT_LANGUAGE);
    const languagePairPivotToTarget = _getLanguagePair(PIVOT_LANGUAGE, to);
    await Promise.all([
      _constructTranslationModelHelper(languagePairSrcToPivot, modelRegistry),
      _constructTranslationModelHelper(
        languagePairPivotToTarget,
        modelRegistry
      ),
    ]);
  } else {
    // Non-pivoting case requires only 1 translation model
    await _constructTranslationModelHelper(
      _getLanguagePair(from, to),
      modelRegistry
    );
  }
};

// Translates text from source language to target language (via pivoting if necessary).
const _translate = (
  from: string,
  to: string,
  input: string[],
  translateOptions: TranslationOptions[]
) => {
  let vectorResponseOptions, vectorSourceText, vectorResponse;
  try {
    // Prepare the arguments (vectorResponseOptions and vectorSourceText (vector<string>)) of Translation API and call it.
    // Result is a vector<Response> where each of its item corresponds to one item of vectorSourceText in the same order.
    vectorResponseOptions = _prepareResponseOptions(translateOptions);
    vectorSourceText = _prepareSourceText(input);

    if (_isPivotingRequired(from, to)) {
      // Translate via pivoting
      const translationModelSrcToPivot = _getLoadedTranslationModel(
        from,
        PIVOT_LANGUAGE
      );
      const translationModelPivotToTarget = _getLoadedTranslationModel(
        PIVOT_LANGUAGE,
        to
      );
      vectorResponse = translationService.translateViaPivoting(
        translationModelSrcToPivot,
        translationModelPivotToTarget,
        vectorSourceText,
        vectorResponseOptions
      );
    } else {
      // Translate without pivoting
      const translationModel = _getLoadedTranslationModel(from, to);
      vectorResponse = translationService.translate(
        translationModel,
        vectorSourceText,
        vectorResponseOptions
      );
    }

    // Parse all relevant information from vectorResponse
    const listTranslatedText = _parseTranslatedText(vectorResponse);
    const listSourceText = _parseSourceText(vectorResponse);
    const listTranslatedTextSentences =
      _parseTranslatedTextSentences(vectorResponse);
    const listSourceTextSentences = _parseSourceTextSentences(vectorResponse);

    log(`Source text: ${listSourceText}`);
    log(`Translated text: ${listTranslatedText}`);
    log(`Translated sentences: ${JSON.stringify(listTranslatedTextSentences)}`);
    log(`Source sentences: ${JSON.stringify(listSourceTextSentences)}`);

    return listTranslatedText;
  } finally {
    // Necessary clean up
    if (vectorSourceText != null) vectorSourceText.delete();
    if (vectorResponseOptions != null) vectorResponseOptions.delete();
    if (vectorResponse != null) vectorResponse.delete();
  }
};

const _downloadAsArrayBufferNode = async (
  url: string
): Promise<ArrayBuffer> => {
  const protocol = url.split("://")[0];
  const https = require(protocol);
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res: IncomingMessage) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Status code ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("error", (error: Error) => {
        console.error("Error in fetching", error);
        reject(error);
      });
      res.on("data", (chunk) => {
        if (res.statusCode !== 200) {
          reject("data: Status code is not 200");
        }
        chunks.push(chunk);
      });
      res.on("end", async () => {
        if (res.statusCode !== 200) {
          reject("end: Status code is not 200");
        }
        const { Blob } = require("buffer");
        const data = new Blob(chunks);
        try {
          const buffer = await data.arrayBuffer();
          resolve(buffer);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", function (e: any) {
      // For some reason, firebase storage returns ECONNRESET while returning the right data
      if (e.code !== "ECONNRESET") {
        reject(e);
      }
    });
    req.on("timeout", function (e: any) {
      console.error(`timeout: problem with request: ${e.message}`);
      reject(e);
    });
    req.on("uncaughtException", function (e: any) {
      console.error(`uncaughtException: problem with request: ${e.message}`);
      reject(e);
    });
  });
};

// Downloads file from a url and returns the array buffer
const _downloadAsArrayBuffer = async (url: string): Promise<ArrayBuffer> => {
  if (isNode) {
    return _downloadAsArrayBufferNode(url);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw Error(
      `Downloading ${url} failed: HTTP ${response.status} - ${response.statusText}`
    );
  }
  return response.arrayBuffer();
};

// Constructs and initializes the AlignedMemory from the array buffer and alignment size
const _prepareAlignedMemoryFromBuffer = async (
  buffer: ArrayBuffer,
  alignmentSize: number
) => {
  const byteArray = new Int8Array(buffer);
  const alignedMemory = new (globalThis as any).Module.AlignedMemory(
    byteArray.byteLength,
    alignmentSize
  );
  const alignedByteArrayView = alignedMemory.getByteArrayView();
  alignedByteArrayView.set(byteArray);
  return alignedMemory;
};

async function prepareAlignedMemory(
  file: FileInfo,
  languagePair: string,
  modelRegistry: ModelRegistry
) {
  const fileName = modelRegistry[languagePair][file.type].name;
  const buffer = await _downloadAsArrayBuffer(fileName);
  const alignedMemory = await _prepareAlignedMemoryFromBuffer(
    buffer,
    file.alignment
  );
  log(
    `${
      file.type
    } aligned memory prepared. Size: ${alignedMemory.size()} bytes, alignment: ${
      file.alignment
    }`
  );
  return alignedMemory;
}

const _constructTranslationModelHelper = async (
  languagePair: string,
  modelRegistry: ModelRegistry
) => {
  log(`Constructing translation model ${languagePair}`);

  /*Set the Model Configuration as YAML formatted string.
    For available configuration options, please check: https://marian-nmt.github.io/docs/cmd/marian-decoder/
    Vocab files are re-used in both translation directions.
    DO NOT CHANGE THE SPACES BETWEEN EACH ENTRY OF CONFIG
  */
  // Constraints:
  // max-length-factor * max-length-break < mini-batch-words
  const modelConfig = `beam-size: 12
normalize: 1.0
word-penalty: 0
max-length-break: 512
mini-batch-words: 8192
workspace: 512
max-length-factor: 12
skip-cost: false
cpu-threads: 0
quiet: true
quiet-translation: true
gemm-precision: int8shiftAlphaAll
alignment: soft
`;

  const alignedMemories = await Promise.all(
    FILE_INFO.filter((file) => file.type in modelRegistry[languagePair]).map(
      (file) => prepareAlignedMemory(file, languagePair, modelRegistry)
    )
  );

  log(`Translation Model config: ${modelConfig}`);
  log(
    `Aligned memory sizes: Model:${alignedMemories[0].size()} Shortlist:${alignedMemories[1].size()} Vocab:${alignedMemories[2].size()}`
  );
  const alignedVocabMemoryList = new (
    globalThis as any
  ).Module.AlignedMemoryList();
  alignedVocabMemoryList.push_back(alignedMemories[2]);
  let translationModel;
  if (alignedMemories.length === FILE_INFO.length) {
    log(`QE:${alignedMemories[3].size()}`);
    translationModel = new (globalThis as any).Module.TranslationModel(
      modelConfig,
      alignedMemories[0],
      alignedMemories[1],
      alignedVocabMemoryList,
      alignedMemories[3]
    );
  } else {
    translationModel = new (globalThis as any).Module.TranslationModel(
      modelConfig,
      alignedMemories[0],
      alignedMemories[1],
      alignedVocabMemoryList,
      null
    );
  }
  languagePairToTranslationModels.set(languagePair, translationModel);
};

const _isPivotingRequired = (from: string, to: string) => {
  return false;
  // return from !== PIVOT_LANGUAGE && to !== PIVOT_LANGUAGE;
};

const _getLanguagePair = (srcLang: string, tgtLang: string) => {
  return `${srcLang}${tgtLang}`;
};

const _getLoadedTranslationModel = (srcLang: string, tgtLang: string) => {
  const languagePair = _getLanguagePair(srcLang, tgtLang);
  if (!languagePairToTranslationModels.has(languagePair)) {
    throw Error(`Translation model '${languagePair}' not loaded`);
  }
  return languagePairToTranslationModels.get(languagePair);
};

const _parseTranslatedText = (vectorResponse: ResponseVector) => {
  const result = [];
  for (let i = 0; i < vectorResponse.size(); i++) {
    const response = vectorResponse.get(i);
    result.push(response.getTranslatedText());
  }
  return result;
};

const _parseTranslatedTextSentences = (vectorResponse: ResponseVector) => {
  const result = [];
  for (let i = 0; i < vectorResponse.size(); i++) {
    const response = vectorResponse.get(i);
    result.push(_getTranslatedSentences(response));
  }
  return result;
};

const _parseSourceText = (vectorResponse: ResponseVector) => {
  const result = [];
  for (let i = 0; i < vectorResponse.size(); i++) {
    const response = vectorResponse.get(i);
    result.push(response.getOriginalText());
  }
  return result;
};

const _parseSourceTextSentences = (vectorResponse: ResponseVector) => {
  const result = [];
  for (let i = 0; i < vectorResponse.size(); i++) {
    const response = vectorResponse.get(i);
    result.push(_getSourceSentences(response));
  }
  return result;
};

const _prepareResponseOptions = (translateOptions: TranslationOptions[]) => {
  const vectorResponseOptions = new (
    globalThis as any
  ).Module.VectorResponseOptions();
  translateOptions.forEach((translateOption) => {
    vectorResponseOptions.push_back({
      qualityScores: translateOption.isQualityScores,
      alignment: true,
      html: translateOption.isHtml,
    });
  });
  if (vectorResponseOptions.size() == 0) {
    vectorResponseOptions.delete();
    throw Error(`No Translation Options provided`);
  }
  return vectorResponseOptions;
};

const _prepareSourceText = (input: string[]) => {
  const vectorSourceText = new (globalThis as any).Module.VectorString();
  input.forEach((paragraph) => {
    // prevent empty paragraph - it breaks the translation
    if (paragraph.trim() === "") {
      return;
    }
    vectorSourceText.push_back(paragraph.trim());
  });
  if (vectorSourceText.size() == 0) {
    vectorSourceText.delete();
    throw Error(`No text provided to translate`);
  }
  return vectorSourceText;
};

interface Response {
  getTranslatedText(): string;

  getTranslatedSentence(index: number): { begin: number; end: number };

  getSourceSentence(index: number): { begin: number; end: number };

  size(): number;

  getOriginalText(): string;
}

interface ResponseVector {
  size(): number;

  get(index: number): Response;
}

const _getTranslatedSentences = (response: Response) => {
  const sentences = [];
  const text = response.getTranslatedText();
  for (
    let sentenceIndex = 0;
    sentenceIndex < response.size();
    sentenceIndex++
  ) {
    const utf8SentenceByteRange = response.getTranslatedSentence(sentenceIndex);
    sentences.push(_getSubString(text, utf8SentenceByteRange));
  }
  return sentences;
};

const _getSourceSentences = (response: Response) => {
  const sentences = [];
  const text = response.getOriginalText();
  for (
    let sentenceIndex = 0;
    sentenceIndex < response.size();
    sentenceIndex++
  ) {
    const utf8SentenceByteRange = response.getSourceSentence(sentenceIndex);
    sentences.push(_getSubString(text, utf8SentenceByteRange));
  }
  return sentences;
};

/*
 * Returns a substring of text (a string). The substring is represented by
 * byteRange (begin and end indices) within the utf-8 encoded version of the text.
 */
const _getSubString = (
  text: string,
  utf8ByteRange: { begin: number; end: number }
) => {
  const encoder = new TextEncoder(); // string to utf-8 converter
  const decoder = new TextDecoder(); // utf-8 to string converter

  const textUtf8ByteView = encoder.encode(text);
  const substringUtf8ByteView = textUtf8ByteView.subarray(
    utf8ByteRange.begin,
    utf8ByteRange.end
  );
  return decoder.decode(substringUtf8ByteView);
};

function _wordsCount(sentence: string) {
  return sentence
    .trim()
    .split(" ")
    .filter((word) => word.trim() !== "").length;
}
