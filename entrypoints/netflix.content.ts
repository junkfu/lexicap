import { onCuesMessage, onEpisodeMessage, onStateMessage, postCommand } from '@/lib/bridge';
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
    let overlay: Overlay | null = null;
    let attached: HTMLVideoElement | null = null;
    /**
     * 已解析的字幕，連同它屬於哪一集。
     *
     * ⚠️ 收到後就一直留著，不可以用完即丟。換集時 Netflix 會換掉 <video>，
     * Overlay 得跟著重建，而 MAIN world 每一集只送一次字幕 —— 用完即丟的話，
     * 重建出來的 Overlay 手上是空的，整集都不會有字。
     */
    let loaded: { movieId: string; dialogue: Cue[] } | null = null;
    /** MAIN world 說的、現在正在播的那一集 */
    let movieId = '';
    /** 目前掛在 Overlay 上的那份。用陣列本體比對，避免重複 setCues */
    let dialogue: Cue[] = NO_CUES;
    /** MAIN world 最後一次說的「該不該接管」。真的要不要接管還得看手上有沒有字幕 */
    let wanted = false;

    // 這些監聽必須最先註冊。postMessage 不會緩衝，MAIN world 可能在
    // 播放器出現之前就把字幕送過來了，那樣訊息會直接消失
    onCuesMessage((message) => {
      const cues = dialogueCues(parseVtt(message.vtt));
      loaded = { movieId: message.movieId, dialogue: cues };
      console.log(`[lexicap] movieId=${message.movieId}，${cues.length} 句有台詞`);
      applyCues();
    });

    // 換集。兩則訊息沒有先後保證 —— 新字幕可能比這則早到，也可能晚到，
    // 所以兩邊都呼叫 applyCues()，由它比對 movieId 決定該顯示哪一份
    onEpisodeMessage((id) => {
      if (id === movieId) return;
      movieId = id;
      applyCues();
    });

    // 使用者切到中文字幕或把字幕關掉時，MAIN world 會通知我們收起來。
    // 擴充在那之後完全休眠 —— 不該改變使用者原本的觀看體驗
    onStateMessage((visible) => {
      wanted = visible;
      applyVisibility();
    });

    /**
     * 手上沒有這一集的字幕時絕不接管。
     *
     * 換集到新字幕送達之間就是這種狀態 —— 光看 MAIN 的指示就遮掉原生字幕的話，
     * 原生的被遮、我們又拿不出東西，使用者整段完全沒有字可看。
     */
    function applyVisibility(): void {
      const on = wanted && dialogue.length > 0;
      overlay?.setVisible(on);
      // 遮蔽原生字幕靠這個 class + stylesheet 規則，不去動播放器狀態。
      // 移除 class 之後，Netflix 的字幕會回到它原本的位置
      document.documentElement.classList.toggle('lexicap-active', on);
    }

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

      // 播放器被拆掉了（回瀏覽頁、或換集重建到一半）。脫離 DOM 的 <video>
      // currentTime 會凍在原地 —— Overlay 留著只會讓最後一句卡在畫面上不動
      if (!video) {
        if (attached) detach();
        return;
      }
      if (video === attached) return;

      detach();
      attached = video;

      overlay = createOverlay(video, {
        onWordClick: (word, cue) => void capture(cue, word, 'word'),
        // 只有確定 Overlay 真的畫出來了才通知可以接管。
        // 否則 Overlay 一有問題，使用者會完全沒有字幕可看
        onFirstRender: () => postCommand({ action: 'overlayReady' }),
      });

      applyCues();
      console.log('[lexicap] 已接上播放器');
    }

    /** 拆掉 Overlay，把畫面完整還給 Netflix */
    function detach(): void {
      overlay?.destroy();
      overlay = null;
      attached = null;
      // 新的 Overlay 身上還沒有任何字幕，清掉記號讓 applyCues 一定重灌一次。
      // movieId 不清 —— 那是 MAIN world 的權威狀態，清掉只會讓手上的字幕對不上
      dialogue = NO_CUES;
      // 遮罩若留著，會有一段原生字幕被遮、我們又還沒獲准顯示的空窗
      document.documentElement.classList.remove('lexicap-active');
    }

    // 只註冊一次。放進 ensureAttached 的話，每換一集就多一組監聽，
    // 按一次 S 會存好幾筆
    installHotkeys(
      () => overlay,
      (cue, word, type) => void capture(cue, word, type),
    );

    setInterval(ensureAttached, 1000);
    ensureAttached();

    /** 把手上的字幕掛上 Overlay —— 但只在它確實屬於正在播的這一集時 */
    function applyCues(): void {
      if (!overlay) return;
      const next = loaded && loaded.movieId === movieId ? loaded.dialogue : NO_CUES;
      if (next === dialogue) return;
      dialogue = next;
      overlay.setCues(next);
      applyVisibility();
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

/** 「沒有字幕」的共用空陣列。applyCues 用陣列本體比對，所以必須是同一顆 */
const NO_CUES: Cue[] = [];

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
