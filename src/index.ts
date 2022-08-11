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

interface TranslationResponse {
  text: string;
}

interface WorkerInterface {
  importBergamotWorker: (
    jsFilePath: string,
    wasmFilePath: string
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
}

export type ComlinkWorkerInterface = comlink.Remote<WorkerInterface>;

export function createBergamotWorker(path: string): ComlinkWorkerInterface {
  const worker: Worker = new Worker(path);
  return comlink.wrap(worker);
}
