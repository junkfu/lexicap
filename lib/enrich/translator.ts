import type { Capture } from '../types';
import type { Enricher, Enrichment } from './types';

/**
 * Chrome 內建 Translator API（Chrome 138+ / Edge 148+）。
 *
 * 為什麼不是 Prompt API（Gemini Nano）：**它只支援 en / ja / es / de / fr，
 * 不支援中文**，要求 zh-Hant 輸出會丟 NotSupportedError。
 *
 * ⚠️ 這個 API 在 Web Worker（含 extension service worker）中不可用 ——
 * 官方說明是無法為 worker 建立 responsible document 來檢查 Permissions
 * Policy。所以富化必須在 extension page（清單頁）執行，不能放在 background。
 */
interface TranslatorInstance {
  translate(input: string): Promise<string>;
  destroy?(): void;
}

interface CreateOptions {
  sourceLanguage: string;
  targetLanguage: string;
  monitor?: (m: EventTarget) => void;
}

interface TranslatorFactory {
  availability(o: Omit<CreateOptions, 'monitor'>): Promise<
    'unavailable' | 'downloadable' | 'downloading' | 'available'
  >;
  create(o: CreateOptions): Promise<TranslatorInstance>;
}

declare global {
  // eslint-disable-next-line no-var
  var Translator: TranslatorFactory | undefined;
}

/**
 * 目標語言代碼。Chrome 對繁中的代碼寫法不只一種，逐一試最穩
 * —— 猜錯代碼跟「不支援」在 availability() 的回傳上長得一樣。
 */
const TARGETS = ['zh-Hant', 'zh-TW', 'zh'] as const;

export type Diagnosis =
  | { ok: true; target: string; status: string }
  | { ok: false; reason: string };

export class TranslatorEnricher implements Enricher {
  readonly name = 'Chrome 內建翻譯';
  #instance: TranslatorInstance | null = null;
  #target: string | null = null;

  /** 失敗時回傳具體原因，不要只說「不支援」—— 那會讓除錯變成猜謎 */
  async diagnose(): Promise<Diagnosis> {
    if (typeof Translator === 'undefined') {
      return {
        ok: false,
        reason: 'Translator API 在這個頁面不存在（內建 AI 可能不開放給 chrome-extension:// origin）',
      };
    }

    const tried: string[] = [];
    for (const targetLanguage of TARGETS) {
      let status: string;
      try {
        status = await Translator.availability({ sourceLanguage: 'en', targetLanguage });
      } catch (error) {
        tried.push(`${targetLanguage}: ${(error as Error).message}`);
        continue;
      }
      tried.push(`${targetLanguage}: ${status}`);
      if (status !== 'unavailable') {
        this.#target = targetLanguage;
        return { ok: true, target: targetLanguage, status };
      }
    }
    return { ok: false, reason: `en → 繁中都不可用（${tried.join('、')}）` };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.diagnose()).ok;
  }

  async prepare(onProgress?: (ratio: number) => void): Promise<void> {
    if (this.#instance) return;
    if (!this.#target) {
      const diagnosis = await this.diagnose();
      if (!diagnosis.ok) throw new Error(diagnosis.reason);
    }

    this.#instance = await Translator!.create({
      sourceLanguage: 'en',
      targetLanguage: this.#target!,
      // 首次使用要下載語言包，可能要等一會兒
      monitor: (m) =>
        m.addEventListener('downloadprogress', (event) => {
          onProgress?.((event as ProgressEvent).loaded);
        }),
    });
  }

  /**
   * 查字典要用原形小寫。
   *
   * 字幕裡的單字常常是句首大寫（`Hunter`），而機器翻譯對大寫單詞會偏向
   * 當專有名詞處理 —— 實測 `Hunter` 得到「跡人」，`hunter` 才是「獵人」。
   *
   * 只還原「句首大寫」這一種形態：全大寫（NASA）與詞中含大寫（iPhone）
   * 保持原樣，那些大寫是有意義的。
   * 代價是人名（Gon）也會被小寫，但學語言時常見名詞遠比角色名重要。
   */
  static lookupForm(word: string): string {
    return /^[A-Z][a-z'’-]*$/.test(word) ? word.toLowerCase() : word;
  }

  async enrich(captures: Capture[]): Promise<Enrichment[]> {
    await this.prepare();
    const translator = this.#instance!;

    const results: Enrichment[] = [];
    // 逐筆送 —— Translator API 一次只吃一個字串，而且本機執行沒有網路延遲，
    // 批次在這裡沒有意義（跟雲端 LLM 不同）
    for (const capture of captures) {
      try {
        // 整句翻譯：兩種擷取都做。單字擷取雖然不顯示句子，但存著供匯出，
        // 之後換成 LLM 富化時它就是語境來源
        const translation = (await translator.translate(capture.text)).trim();

        if (!capture.word) {
          results.push({ id: capture.id, translation });
          continue;
        }

        // ⚠️ Translator API 是機器翻譯引擎，沒有「這個字在這句裡是什麼意思」
        //    的介面，只能把字單獨丟進去 —— 所以 goal 這種多義字仍然靠碰運氣。
        //    要真正用上語境，得換成 LLM 富化器。
        const wordMeaning = (
          await translator.translate(TranslatorEnricher.lookupForm(capture.word))
        ).trim();

        results.push({
          id: capture.id,
          translation,
          wordMeaning,
          lemma: capture.word.toLowerCase(),
        });
      } catch {
        // 單筆失敗不該拖垮整批，留在 raw 下次重試
      }
    }
    return results;
  }
}
