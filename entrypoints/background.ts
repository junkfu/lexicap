import { db } from '@/lib/db';
import type { Capture } from '@/lib/types';
import type { LexicapMessage, SaveCaptureResult } from '@/lib/messages';
import type { Enrichment } from '@/lib/enrich/types';

/**
 * Service worker：唯一的 DB 持有者。
 *
 * ⚠️ MV3 的 SW 閒置約 30 秒就會被終止，所以這裡**不得有任何跨事件的
 * 記憶體狀態**。佇列就是 DB 裡 enrichStatus === 'raw' 的記錄本身，
 * 任何時候被殺掉，下次醒來從 DB 重讀即可。
 */
export default defineBackground(() => {
  // 沒有 popup —— 點圖示直接開清單頁，少一層點擊
  browser.action.onClicked.addListener(() => {
    void browser.tabs.create({ url: browser.runtime.getURL('/list.html') });
  });

  browser.runtime.onMessage.addListener((message: LexicapMessage, _sender, sendResponse) => {
    void handle(message).then(sendResponse);
    return true; // 非同步回覆
  });
});

async function handle(message: LexicapMessage): Promise<unknown> {
  switch (message.type) {
    case 'lexicap:save':
      return saveCapture(message.capture);

    case 'lexicap:list':
      return db.captures.orderBy('capturedAt').reverse().toArray();

    case 'lexicap:delete':
      await db.captures.delete(message.id);
      return { ok: true };

    case 'lexicap:enriched':
      return applyEnrichments(message.enrichments, message.failedIds);

    case 'lexicap:reset-enrichment':
      await db.captures.toCollection().modify({ enrichStatus: 'raw' });
      return { ok: true };
  }
}

async function applyEnrichments(
  enrichments: Enrichment[],
  failedIds: string[],
): Promise<{ ok: true }> {
  await db.transaction('rw', db.captures, async () => {
    for (const { id, ...fields } of enrichments) {
      await db.captures.update(id, { ...fields, enrichStatus: 'done' });
    }
    // 標記失敗，否則每次打開清單頁都會重試同一批永遠失敗的資料
    for (const id of failedIds) {
      await db.captures.update(id, { enrichStatus: 'failed' });
    }
  });
  return { ok: true };
}

async function saveCapture(input: SaveInput): Promise<SaveCaptureResult> {
  // 同一句 + 同一個字只存一次，避免連按造成重複。
  // 注意：不同 timestamp 的同一個字仍然各存一筆 —— capture 是不可變的事件
  // 日誌，timestamp 是核心資產，寫入時合併就摧毀了語境。
  const existing = await db.captures
    .where('videoId')
    .equals(input.videoId)
    .filter((c) => c.startTime === input.startTime && c.word === input.word)
    .first();

  if (existing) return { ok: true, duplicate: true };

  const capture: Capture = {
    ...input,
    id: crypto.randomUUID(),
    capturedAt: Date.now(),
    enrichStatus: 'raw',
  };

  await db.captures.add(capture);
  return { ok: true };
}

type SaveInput = Omit<Capture, 'id' | 'capturedAt' | 'enrichStatus'>;
