import type { Capture } from './types';

const clock = (seconds: number): string => {
  const s = Math.floor(seconds);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

export function toMarkdown(captures: Capture[]): string {
  const byVideo = new Map<string, Capture[]>();
  for (const c of captures) {
    const list = byVideo.get(c.videoTitle || c.videoId) ?? [];
    list.push(c);
    byVideo.set(c.videoTitle || c.videoId, list);
  }

  const blocks: string[] = [];
  for (const [videoTitle, list] of byVideo) {
    blocks.push(`## ${videoTitle}\n`);
    for (const c of [...list].sort((a, b) => a.startTime - b.startTime)) {
      // 單字擷取在清單頁只顯示那個字，但匯出時把整句帶出來 ——
      // 事後翻閱筆記時，沒有上下文的單字清單價值很低
      blocks.push(`- \`${clock(c.startTime)}\` ${c.word ? `**${c.word}**` : c.text}`);
      if (c.word) {
        if (c.wordMeaning) blocks.push(`  - ${c.wordMeaning}`);
        blocks.push(`  - 原句：${c.text}`);
      }
      if (c.translation) blocks.push(`  - ${c.translation}`);
      if (c.note) blocks.push(`  - 註：${c.note}`);
    }
    blocks.push('');
  }
  return blocks.join('\n');
}

/**
 * CSV 儲存格。
 *
 * 除了跳脫引號，開頭是 = + - @ 時要前置單引號 —— 試算表軟體會把那些
 * 當成公式執行。字幕對白很常以 `-` 開頭（`-Are you sure about this?`），
 * 這不是理論風險。
 */
const csvCell = (v: unknown): string => {
  const text = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function toCsv(captures: Capture[]): string {
  // text 是原句，word 是點選的單字 —— 兩欄都給，匯進 Anki 之類的工具才有語境
  const columns: (keyof Capture)[] = [
    'videoTitle', 'startTime', 'word', 'wordMeaning', 'text', 'translation', 'note', 'capturedAt',
  ];
  const rows = captures.map((c) => columns.map((k) => csvCell(c[k])).join(','));
  return [columns.join(','), ...rows].join('\n');
}

/**
 * 原則 4 說資料不綁定工具，但 Markdown 與 CSV 都是有損的
 * （prevText / nextText / enrichStatus / endTime 都會掉），
 * 所以備份一定要有完整的 JSON。
 */
export function toJson(captures: Capture[]): string {
  return JSON.stringify(captures, null, 2);
}

export function download(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export { clock };
