import * as comlink from "comlink";

interface ModelInfoPiece {
  estimatedCompressedSize: number;
  expectedSha256Hash: string;
  modelType: string;
  name: string;
  size: number;
}

interface ModelInfo {
  model: ModelInfoPiece;
  vocab: ModelInfoPiece;
  lex: ModelInfoPiece;
  qualityModel: ModelInfoPiece;
}

export type ModelRegistry = Record<string, ModelInfo>;

// Information corresponding to each file type
type FileType = "model" | "lex" | "vocab" | "qualityModel";

export interface FileInfo {
  type: FileType;
  alignment: number;
}

export interface TranslationOptions {
  isHtml?: boolean;
  isQualityScores?: boolean;
}

export interface TranslationResponse {
  text: string;
}

interface WorkerInterface {
  importBergamotWorker: (
    jsFilePath: string,
    wasmFilePath: string | Buffer
  ) => Promise<void>;
  loadModel: (
    from: string,
    to: string,
    modelRegistry: ModelRegistry
  ) => Promise<string>;
  translate: (
    from: string,
    to: string,
    sentences: string[],
    options: TranslationOptions[]
  ) => Promise<TranslationResponse[]>;
  terminate: () => Promise<void>;
}

export type ComlinkWorkerInterface = comlink.Remote<WorkerInterface>;

export function createBergamotWorker(path: string): ComlinkWorkerInterface {
  const workerClass =
    "Worker" in globalThis ? globalThis.Worker : require("web-worker");
  const worker: Worker = new workerClass(path);
  const abortionError = new Promise((resolve, reject) => {
    worker.addEventListener("error", reject);
    worker.addEventListener("close", resolve);
  });

  return new Proxy(comlink.wrap(worker), {
    get(target, prop, receiver) {
      if (prop === "terminate") {
        return () => {
          worker.terminate();
        };
      }
      const targetProp = Reflect.get(target, prop, receiver);
      if (typeof targetProp === "function") {
        return (...args: any[]) => {
          // If for any reason the worker terminates unexpectedly, reject the promise
          return Promise.race([targetProp(...args), abortionError]);
        };
      }
      return targetProp;
    },
  });
}
