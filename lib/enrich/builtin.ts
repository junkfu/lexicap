import type { Capture } from '../types';
import type { Enricher, Enrichment } from './types';
import { lookup } from './dictionary';
import { TranslatorEnricher, type Diagnosis } from './translator';

/**
 * 免設定的預設富化器：
 *   - 單字 → 離線詞典（列出所有義項，零設定、瞬間、免費）
 *   - 句子 → Chrome 內建 Translator
 *   - 詞典查不到的字（人名、罕見字）→ 退回 Translator
 *
 * 它做不到的事：判斷「這個字在這句裡是哪個意思」。詞典會把 goal 的
 * 五個義項全列出來讓你自己選，但不會告訴你這句用的是哪個。
 * 那需要 LLM —— 見 lib/enrich/llm.ts。
 */
export class BuiltinEnricher implements Enricher {
  readonly name = '離線詞典 + Chrome 內建翻譯';
  readonly #translator = new TranslatorEnricher();
  #translatorReady = false;

  async isAvailable(): Promise<boolean> {
    return true; // 詞典是打包進來的，一定可用
  }

  /** 內建翻譯是否可用、語言包下載了沒 —— 只有句子擷取需要它 */
  diagnoseTranslator(): Promise<Diagnosis> {
    return this.#translator.diagnose();
  }

  async prepare(onProgress?: (ratio: number) => void): Promise<void> {
    try {
      await this.#translator.prepare(onProgress);
      this.#translatorReady = true;
    } catch {
      // 翻譯器沒準備好不該擋住查詞典。句子擷取會留在待翻譯狀態
      this.#translatorReady = false;
    }
  }

  async enrich(captures: Capture[]): Promise<Enrichment[]> {
    const results: Enrichment[] = [];
    const needTranslator: Capture[] = [];

    for (const capture of captures) {
      if (!capture.word) {
        needTranslator.push(capture);
        continue;
      }
      const hit = await lookup(capture.word);
      if (hit) {
        results.push({ id: capture.id, wordMeaning: hit.meaning, lemma: hit.lemma });
      } else {
        // 詞典沒收錄（人名、罕見字）才動用機器翻譯
        needTranslator.push(capture);
      }
    }

    if (needTranslator.length && this.#translatorReady) {
      results.push(...(await this.#translator.enrich(needTranslator)));
    }
    return results;
  }
}
