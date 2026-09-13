import type { Cue } from '../types';

/**
 * 音效描述與說話者標籤。
 *
 * 實測（見 spike/FINDINGS.md）：Netflix 英文 CC 軌的說話者標籤是
 * `[narrator]` 方括號形式，由 SFX 處理。
 *
 * SPEAKER（`MAN:` 大寫冒號形式）在實測片源**一次都沒觸發**，
 * 屬於未驗證且有誤殺風險的規則 —— 保留是因為舊片源仍可能使用，
 * 但若日後發現誤殺正常台詞，優先移除它。
 */
const SFX = /\[[^\]]*\]|\([^)]*\)|♪/g;
const SPEAKER = /^\s*-?\s*[A-Z][A-Z0-9 .'’-]{1,24}:\s*/;
const TAG = /<[^>]+>/g;

/**
 * Netflix 的 WebVTT 會夾帶 HTML entity，實測看到 `&lrm;- Are you sure…`。
 * 不解碼的話會污染 LLM 輸入與清單頁的搜尋。
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '\u200e',
  rlm: '\u200f',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * 方向標記與零寬字元。解碼後一律剝除 —— 對英文學習是純雜訊，
 * 而且看不見，會讓「為什麼搜尋不到」變成無頭公案。
 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;

/** 先剝標籤再解碼 —— 順序相反的話 `&lt;` 會被解成假標籤 */
const normalize = (s: string) =>
  decodeEntities(s.replace(TAG, '')).replace(INVISIBLE, '');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 清理單一字幕「行」。必須逐行做 —— 說話者標籤只出現在行首 */
export function cleanLine(line: string): string {
  return line.replace(SFX, '').replace(SPEAKER, '');
}

/** `00:01:02.345` / `01:02.345` → 秒 */
export function timestampToSeconds(stamp: string): number {
  const m = stamp.trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
  if (!m) return NaN;
  const [, h, mm, ss, ms] = m;
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

/**
 * 解析 WebVTT。Netflix 的時間軸單位直接就是秒，不需要 TTML 的 tick 換算。
 */
export function parseVtt(source: string): Cue[] {
  const cues: Cue[] = [];

  for (const block of source.replace(/\r/g, '').split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i === -1) continue;

    const [from, to] = lines[i]!.split('-->');
    if (from === undefined || to === undefined) continue;

    const parts = lines.slice(i + 1).map(normalize);
    const raw = squash(parts.join(' '));
    if (!raw) continue;

    cues.push({
      start: timestampToSeconds(from),
      end: timestampToSeconds(to),
      text: squash(parts.map(cleanLine).join(' ')),
      raw,
    });
  }

  return cues;
}

/**
 * 可擷取的句子 —— 排除清理後為空的純音效 cue。
 *
 * 實測某集 368 句中有 64 句（17%）是純音效。按 S 時若當下正好落在
 * `[roaring]` 上，沒有台詞可存，所以擷取一律在這個清單上操作。
 */
export function dialogueCues(cues: Cue[]): Cue[] {
  return cues.filter((c) => c.text.length > 0);
}

/** 找出 `seconds` 當下所在的句；落在純音效或空檔時，回傳前一句有台詞的 */
export function cueAt(cues: Cue[], seconds: number): Cue | null {
  let candidate: Cue | null = null;
  for (const cue of cues) {
    if (cue.start > seconds) break;
    candidate = cue;
  }
  return candidate;
}
