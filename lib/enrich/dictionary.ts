/**
 * 離線英漢詞典。資料由 scripts/build-dictionary.py 從 ECDICT（MIT）產生。
 *
 * 為什麼需要詞典而不是機器翻譯：MT 引擎對單一個字只會回**一個**它猜的意思
 * （實測 goal → 籃、Hunter → 跡人），而且無法表達「在這句裡是什麼意思」。
 * 詞典則列出**所有義項**，使用者一眼就能挑對的那個 ——
 * 對語言學習來說，誠實地列出歧義比硬選一個有用得多。
 */
interface DictionaryData {
  /** 原形 → 繁體釋義（含詞性，多義項以「；」分隔） */
  words: Record<string, string>;
  /** 變化形 → 原形。running → run，goals → goal */
  forms: Record<string, string>;
}

let cache: Promise<DictionaryData> | null = null;

function load(): Promise<DictionaryData> {
  cache ??= fetch(browser.runtime.getURL('/dictionary.json')).then(
    (r) => r.json() as Promise<DictionaryData>,
  );
  return cache;
}

export interface Lookup {
  /** 繁體釋義 */
  meaning: string;
  /** 查到的原形，供清單頁分組與搜尋用 */
  lemma: string;
}

export async function lookup(word: string): Promise<Lookup | null> {
  const data = await load();
  // 字幕裡的字常是句首大寫，而詞典鍵一律小寫
  const key = word.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  if (!key) return null;

  const direct = data.words[key];
  if (direct) return { meaning: direct, lemma: key };

  // 變化形轉導：running → run、ran → run、goals → goal
  const base = data.forms[key];
  const viaForm = base ? data.words[base] : undefined;
  if (base && viaForm) return { meaning: viaForm, lemma: base };

  return null;
}
