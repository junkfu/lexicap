import type { Capture } from './types';
import type { Enrichment } from './enrich/types';

/** content script → background。Content script 不碰 DB，只送訊息 */
export interface SaveCaptureMessage {
  type: 'lexicap:save';
  capture: Omit<Capture, 'id' | 'capturedAt' | 'enrichStatus'>;
}

export interface ListCapturesMessage {
  type: 'lexicap:list';
}

export interface DeleteCaptureMessage {
  type: 'lexicap:delete';
  id: string;
}

/** 富化結果寫回。富化在清單頁跑（內建 AI 在 service worker 不可用），DB 仍只由 background 持有 */
export interface ApplyEnrichmentMessage {
  type: 'lexicap:enriched';
  enrichments: Enrichment[];
  /** 這批送去富化、但沒有結果的 id —— 標記為 failed 以免無限重試 */
  failedIds: string[];
}

/** 把所有記錄退回 raw，讓富化邏輯的改善能套用到已存的資料 */
export interface ResetEnrichmentMessage {
  type: 'lexicap:reset-enrichment';
}

export type LexicapMessage =
  | SaveCaptureMessage
  | ListCapturesMessage
  | DeleteCaptureMessage
  | ApplyEnrichmentMessage
  | ResetEnrichmentMessage;

export interface SaveCaptureResult {
  ok: boolean;
  /** 同一句已經存過時為 true，UI 據此顯示不同的 toast */
  duplicate?: boolean;
}
