import Dexie, { type Table } from 'dexie';
import type { Capture } from './types';

/**
 * ⚠️ 鐵則：只能在 background service worker 或 extension page 開啟。
 *
 * Content script 雖然跑在 isolated world，但 storage API 用的是**宿主頁面的
 * origin**。在 content script 裡開 Dexie，資料會存進 netflix.com 底下 ——
 * 使用者清一次網站資料就全沒了。所有讀寫一律走 chrome.runtime.sendMessage。
 */
class LexicapDB extends Dexie {
  captures!: Table<Capture, string>;

  constructor() {
    super('lexicap');
    this.version(1).stores({
      // id 是主鍵；其餘是清單頁分組、搜尋與富化佇列要用的索引
      captures: 'id, videoId, capturedAt, enrichStatus, lemma',
    });
  }
}

export const db = new LexicapDB();
