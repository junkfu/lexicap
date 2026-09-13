import { BuiltinEnricher } from './builtin';

export type { Enricher, Enrichment } from './types';

/**
 * 目前只有一種富化器：離線詞典（單字）+ Chrome 內建 Translator（句子）。
 * 零設定、免費、離線。
 *
 * lib/enrich/llm.ts 有一份完整的 LLM 富化器實作（能判斷「這個字在這句裡
 * 是什麼意思」），目前沒有接上 UI。要啟用的話把它換進這裡並補設定介面即可 ——
 * Enricher 介面就是為了這種替換而存在的。
 */
export function resolveEnricher(): BuiltinEnricher {
  return new BuiltinEnricher();
}
