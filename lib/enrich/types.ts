import type { Capture } from '../types';

/** 富化結果。只填得出來的欄位，填不出來的留空 */
export interface Enrichment {
  id: string;
  translation?: string;
  wordMeaning?: string;
  lemma?: string;
  pos?: string;
}

/**
 * 富化器。
 *
 * 刻意抽成介面：富化是離線批次、可重試、失敗不影響原始擷取資料，
 * 所以換 provider 的成本接近零，甚至可以拿舊資料重跑升級。
 *
 * 目前只有 Chrome 內建 Translator API 一種實作。之後若要語境詞義
 * （「這裡的 run 是哪個意思」），接 Ollama 或雲端 LLM 是 drop-in。
 */
export interface Enricher {
  readonly name: string;
  /** 這台機器上能不能用。不能用時富化整個跳過，不影響擷取 */
  isAvailable(): Promise<boolean>;
  /** 需要下載模型時呼叫，回報 0–1 進度 */
  prepare(onProgress?: (ratio: number) => void): Promise<void>;
  enrich(captures: Capture[]): Promise<Enrichment[]>;
}
