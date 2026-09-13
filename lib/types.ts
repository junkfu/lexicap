/** 正規化後的字幕句。所有平台 adapter 都必須產出這個形狀。 */
export interface Cue {
  /** 秒。Netflix WebVTT 直接就是秒，不需換算（見 spike/FINDINGS.md） */
  start: number;
  end: number;
  /** 清理後的台詞：剝除音效描述與說話者標籤。可能為空字串（純音效 cue） */
  text: string;
  /** 原始字幕文字，保留供比對與除錯 */
  raw: string;
}

export interface VideoMeta {
  platform: 'netflix';
  /** Netflix 的「集」id，來自 player.getMovieId() */
  videoId: string;
  /** 會跟著 Netflix UI 語言在地化，不是英文原名 */
  title: string;
}

export type CaptureType = 'word' | 'sentence' | 'selection';
export type EnrichStatus = 'raw' | 'done' | 'failed';

export interface Capture {
  id: string;
  platform: 'netflix';
  videoId: string;
  videoTitle: string;

  /** 秒。核心欄位 —— 每筆擷取都必須能回跳到影片的那一秒 */
  startTime: number;
  endTime: number;

  text: string;
  /** 前後文，供 LLM 判斷語境 */
  prevText?: string;
  nextText?: string;

  /** 點選的單字；null 表示整句擷取 */
  word: string | null;
  captureType: CaptureType;

  // 以下由背景富化填入
  translation?: string;
  wordMeaning?: string;
  lemma?: string;
  pos?: string;
  note?: string;

  enrichStatus: EnrichStatus;
  capturedAt: number;
}

/**
 * 平台專屬邏輯的唯一出口。Netflix 改版時只該動 adapter 內部。
 */
export interface PlatformAdapter {
  match(url: string): boolean;
  getVideoMeta(): VideoMeta | null;
  onCues(cb: (cues: Cue[], meta: VideoMeta) => void): void;
  getCurrentTime(): number;
  seekTo(seconds: number): void;
  /** 全螢幕時 Overlay 的掛載容器 —— 掛在外面全螢幕會消失 */
  getPlayerRoot(): HTMLElement | null;
  hideNativeSubtitles(): void;
}
