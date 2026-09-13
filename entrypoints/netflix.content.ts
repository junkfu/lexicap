import { onCuesMessage, onStateMessage, postCommand } from '@/lib/bridge';
import { parseVtt, dialogueCues } from '@/lib/subtitles/vtt';
import { createOverlay, type Overlay } from '@/lib/overlay';
import { readTitle } from '@/lib/netflix/player';
import type { Cue, Capture } from '@/lib/types';
import type { SaveCaptureMessage, SaveCaptureResult } from '@/lib/messages';

/**
 * ISOLATED world：Overlay、熱鍵、擷取。
 *
 * 這裡不碰 IndexedDB —— content script 的 storage API 用的是 netflix.com 的
 * origin，資料會在使用者清網站資料時消失。一律送訊息給 background。
 */
export default defineContentScript({
  matches: ['https://*.netflix.com/*'],
  main() {
    let dialogue: Cue[] = [];
    let movieId = '';
    let overlay: Overlay | null = null;
    let attached: HTMLVideoElement | null = null;
    let pending: { vtt: string; movieId: string } | null = null;

    // 這些監聽必須最先註冊。postMessage 不會緩衝，MAIN world 可能在
    // 播放器出現之前就把字幕送過來了，那樣訊息會直接消失
    onCuesMessage((message) => {
      pending = { vtt: message.vtt, movieId: message.movieId };
      applyCues();
    });

    // 使用者切到中文字幕或把字幕關掉時，MAIN world 會通知我們收起來。
    // 擴充在那之後完全休眠 —— 不該改變使用者原本的觀看體驗
    onStateMessage((visible) => {
      overlay?.setVisible(visible);
      // 遮蔽原生字幕靠這個 class + stylesheet 規則，不去動播放器狀態。
      // 移除 class 之後，Netflix 的字幕會回到它原本的位置
      document.documentElement.classList.toggle('lexicap-active', visible);
    });

    // 清單頁按 ▶ 回跳。寫 video.currentTime 會被播放器覆寫，
    // 所以轉給 MAIN world 用 player.seek()
    browser.runtime.onMessage.addListener((message: { type?: string; seconds?: number }) => {
      if (message?.type === 'lexicap:seek' && typeof message.seconds === 'number') {
        postCommand({ action: 'seek', seconds: message.seconds });
      }
    });

    /**
     * Netflix 是 SPA —— 從瀏覽頁按播放鍵不會重新載入 document，
     * content script 也就不會重跑。所以這裡不能用「等一次、逾時放棄」，
     * 必須持續盯著播放器，換集時重新接上。
     */
    function ensureAttached(): void {
      // 一定要限定在播放器容器內 —— Netflix 的預告片 / 背景影片也是 <video>，
      // 抓錯的話 currentTime 永遠對不上字幕時間軸，Overlay 會一直空白
      const video =
        document.querySelector<HTMLVideoElement>('.watch-video video') ??
        document.querySelector<HTMLVideoElement>('[data-uia="player"] video');

      if (!video || video === attached) return;

      overlay?.destroy();
      attached = video;
      // 換集了，舊字幕不能留著 —— MAIN world 會在認出新的 movieId 後重送
      dialogue = [];
      movieId = '';

      overlay = createOverlay(video, {
        onWordClick: (word, cue) => void capture(cue, word, 'word'),
        // 只有確定 Overlay 真的畫出來了才通知可以接管。
        // 否則 Overlay 一有問題，使用者會完全沒有字幕可看
        onFirstRender: () => postCommand({ action: 'overlayReady' }),
      });

      applyCues();
      console.log('[lexicap] 已接上播放器');
    }

    // 只註冊一次。放進 ensureAttached 的話，每換一集就多一組監聽，
    // 按一次 S 會存好幾筆
    installHotkeys(
      () => overlay,
      (cue, word, type) => void capture(cue, word, type),
    );

    setInterval(ensureAttached, 1000);
    ensureAttached();

    function applyCues(): void {
      if (!overlay || !pending) return;
      dialogue = dialogueCues(parseVtt(pending.vtt));
      movieId = pending.movieId;
      pending = null;
      overlay.setCues(dialogue);
      console.log(`[lexicap] movieId=${movieId}，${dialogue.length} 句有台詞`);
    }

    async function capture(cue: Cue, word: string | null, captureType: Capture['captureType']) {
      const index = dialogue.indexOf(cue);

      // 點單字時整句一起存，但清單頁只顯示那個字。
      // 句子是富化的語境來源，也讓匯出的筆記看得到上下文；
      // 儲存成本是零，而「顯示得清爽」用排版解決就好，不需要真的不存。
      const message: SaveCaptureMessage = {
        type: 'lexicap:save',
        capture: {
          platform: 'netflix',
          videoId: movieId,
          videoTitle: title(),
          startTime: cue.start,
          endTime: cue.end,
          text: cue.text,
          prevText: dialogue[index - 1]?.text,
          nextText: dialogue[index + 1]?.text,
          word,
          captureType,
        },
      };

      const result = (await browser.runtime.sendMessage(message)) as SaveCaptureResult;
      overlay?.toast(result?.duplicate ? '已經存過了' : word ? `已存 ${word}` : '已存這句');
    }
  },
});

/** 片名只在控制列顯示時才掛上 DOM，取不到就沿用上次成功的 */
let cachedTitle = '';
function title(): string {
  const found = readTitle();
  if (found) cachedTitle = found;
  return cachedTitle;
}

/**
 * 熱鍵。用 capture phase + stopImmediatePropagation，在 Netflix 自己的
 * handler 之前攔下 —— 這比「避開已被佔用的按鍵」穩健得多。
 */
function installHotkeys(
  getOverlay: () => Overlay | null,
  capture: (cue: Cue, word: string | null, type: Capture['captureType']) => void,
): void {
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;

      // 換集時 overlay 會被重建，所以每次都取當下這顆
      const overlay = getOverlay();
      // Overlay 收起來時整個休眠，熱鍵也不該還在攔 Netflix 的按鍵
      if (!overlay?.isVisible()) return;

      const key = event.key.toLowerCase();
      // S = 存當前正在播的整句；A = 存上一句（反應慢半拍時用）
      const cue = key === 's' ? overlay.current() : key === 'a' ? overlay.previous() : null;
      if (!cue) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      capture(cue, null, 'sentence');
    },
    true,
  );
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  );
}
