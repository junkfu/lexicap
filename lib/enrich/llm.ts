import type { Capture } from '../types';
import type { Enricher, Enrichment } from './types';

/**
 * OpenAI 相容的 chat completions 富化器。
 *
 * 同一套程式碼同時支援：
 *   - Ollama（本機免費）  http://localhost:11434/v1
 *   - 各家雲端           https://…/v1
 *
 * 為什麼需要它：Chrome 內建的 Translator API 是機器翻譯引擎，介面只有
 * translate(字串) → 字串，**沒有任何地方能表達「這個字在這句裡是什麼意思」**。
 * 語境詞義只有 LLM 做得到。
 * （內建的 Prompt API / Gemini Nano 不支援中文輸出，所以也不是選項。）
 */
export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

const SYSTEM_PROMPT = `你是英文學習筆記的翻譯助手，服務對象的母語是繁體中文。

規則：
1. 一律輸出繁體中文（台灣用語），絕不使用簡體字。
2. translation 要自然通順，像台灣人會說的話，不要逐字直譯。
3. word 不為 null 時，wordMeaning 必須是**該字在這個句子裡的意思**，
   不是字典上的第一個解釋。例如 "Yes, goal!" 裡的 goal 是「抵達終點」，
   不是「目標」；"He runs a bar" 裡的 run 是「經營」，不是「跑」。
4. 若該字在此處屬於片語動詞、俚語或慣用法，wordMeaning 要點出整個片語。
5. lemma 填該字的原形（running → run），pos 填詞性縮寫（v. / n. / adj. …）。
6. 只輸出 JSON，不要有任何說明文字。`;

export class LlmEnricher implements Enricher {
  readonly name: string;

  constructor(private readonly config: LlmConfig) {
    this.name = `${config.model}（${new URL(config.baseUrl).host}）`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/models`, {
        headers: this.headers(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async prepare(): Promise<void> {
    // 雲端不用準備；Ollama 沒開的話 enrich() 會丟錯，那批留在 raw 下次再試
  }

  async enrich(captures: Capture[]): Promise<Enrichment[]> {
    if (captures.length === 0) return [];

    const payload = captures.map((c) => ({
      id: c.id,
      sentence: c.text,
      word: c.word,
      before: c.prevText ?? null,
      after: c.nextText ?? null,
    }));

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              '請為以下每一筆產出結果，回傳形如 {"results":[{"id","translation","wordMeaning","lemma","pos"}]} 的 JSON。' +
              'word 為 null 的筆只需要 translation。\n\n' +
              JSON.stringify(payload, null, 2),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text().catch(() => '')}`.slice(0, 300));
    }

    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content ?? '';
    return parseResults(content, new Set(captures.map((c) => c.id)));
  }

  private headers(): Record<string, string> {
    return this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {};
  }
}

/**
 * 解析模型輸出。
 *
 * 就算要求了 JSON mode，本機小模型仍可能夾帶 markdown 圍欄或前言，
 * 所以先把最外層的 JSON 物件抓出來再解析。
 * 只採用 id 在這批裡的結果 —— 模型偶爾會自己發明 id。
 */
function parseResults(content: string, validIds: Set<string>): Enrichment[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }

  const rows = (parsed as { results?: unknown }).results;
  if (!Array.isArray(rows)) return [];

  const out: Enrichment[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const id = row['id'];
    if (typeof id !== 'string' || !validIds.has(id)) continue;

    const text = (key: string): string | undefined => {
      const value = row[key];
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };

    out.push({
      id,
      translation: text('translation'),
      wordMeaning: text('wordMeaning'),
      lemma: text('lemma')?.toLowerCase(),
      pos: text('pos'),
    });
  }
  return out;
}
