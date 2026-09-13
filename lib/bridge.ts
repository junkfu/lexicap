/**
 * MAIN world ↔ ISOLATED world 的橋接。
 *
 * MAIN world 負責 hook 與下載（需要頁面的執行環境與 origin），
 * ISOLATED world 負責解析、UI 與跟背景通訊。
 */
export const CUES_MESSAGE = 'lexicap:cues';

export interface CuesMessage {
  type: typeof CUES_MESSAGE;
  movieId: string;
  /** 原始 WebVTT 文字。解析留在 ISOLATED 做，MAIN world 的足跡越小越好 */
  vtt: string;
  trackLabel: string;
}

export function postCues(message: CuesMessage): void {
  window.postMessage(message, '*');
}

export function onCuesMessage(cb: (message: CuesMessage) => void): () => void {
  const handler = (event: MessageEvent) => {
    // 頁面自己也會用 postMessage，必須同時檢查來源與專屬 type
    if (event.source !== window) return;
    const data = event.data as CuesMessage | undefined;
    if (data?.type !== CUES_MESSAGE) return;
    cb(data);
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

/** ISOLATED → MAIN 的指令channel。有些事只有 MAIN world 做得到 */
export const COMMAND_MESSAGE = 'lexicap:command';

export type Command =
  /** Overlay 已成功渲染，MAIN world 可以開始依使用者選的字幕軌判斷要不要接管 */
  | { action: 'overlayReady' }
  /** 回跳。寫 video.currentTime 會被播放器覆寫，必須走 player.seek() */
  | { action: 'seek'; seconds: number };

export interface CommandMessage {
  type: typeof COMMAND_MESSAGE;
  command: Command;
}

export function postCommand(command: Command): void {
  window.postMessage({ type: COMMAND_MESSAGE, command } satisfies CommandMessage, '*');
}

export function onCommandMessage(cb: (command: Command) => void): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as CommandMessage | undefined;
    if (data?.type !== COMMAND_MESSAGE) return;
    cb(data.command);
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

/** MAIN → ISOLATED：Overlay 該不該顯示（依使用者當下選的字幕軌決定） */
export const STATE_MESSAGE = 'lexicap:state';

export interface StateMessage {
  type: typeof STATE_MESSAGE;
  overlayVisible: boolean;
}

export function postState(overlayVisible: boolean): void {
  window.postMessage({ type: STATE_MESSAGE, overlayVisible } satisfies StateMessage, '*');
}

export function onStateMessage(cb: (overlayVisible: boolean) => void): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as StateMessage | undefined;
    if (data?.type !== STATE_MESSAGE) return;
    cb(data.overlayVisible);
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}
