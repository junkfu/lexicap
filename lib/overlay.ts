import type { Cue } from './types';

const ROOT_ID = 'lexicap-overlay';

export interface OverlayOptions {
  /** 點單字。連同整句一起交出去 —— 句子才是真正的儲存單位 */
  onWordClick(word: string, cue: Cue): void;
  /**
   * 第一次真的把一句畫到畫面上時呼叫（當下是收著的也照畫、照呼叫）。
   *
   * 存在的理由：接管字幕必須等到確定 Overlay 畫得出東西之後。
   * 否則 Overlay 一有問題，使用者就完全沒有字幕可看 —— 實際發生過。
   */
  onFirstRender?(): void;
}

export interface Overlay {
  setCues(cues: Cue[]): void;
  /** 當前顯示中的句（供熱鍵擷取用），沒有則 null */
  current(): Cue | null;
  /** 上一句有台詞的（`A` 鍵用） */
  previous(): Cue | null;
  toast(message: string): void;
  /** 只有 MAIN world 確認使用者選了英文軌才會打開；切走或關掉字幕時收回去 */
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  destroy(): void;
}

export function createOverlay(video: HTMLVideoElement, options: OverlayOptions): Overlay {
  injectStyles();

  const root = document.createElement('div');
  root.id = ROOT_ID;
  // 預設收著。要等 MAIN world 確認使用者選的是英文軌才打開 ——
  // 反過來（先顯示、發現不是英文再收）會讓選中文的使用者看到一閃而過的英文字幕
  root.className = 'lexicap-hidden';
  root.innerHTML = '<div class="lexicap-line"></div>';

  const lineEl = root.querySelector<HTMLElement>('.lexicap-line')!;

  let dialogue: Cue[] = [];
  let shownIndex = -1;
  let frozen = false;
  let announced = false;

  // 滑鼠移入時凍結當前句不被換掉，但影片繼續播 ——
  // 做到「字幕停留 + 凍結」之後就不需要 hover 自動暫停，因為使用者不趕時間
  root.addEventListener('pointerenter', () => (frozen = true));
  root.addEventListener('pointerleave', () => (frozen = false));

  mount(root);
  const detachRemount = keepMounted(root);
  const detachControls = followControls(root);

  let rafId = requestAnimationFrame(function tick() {
    rafId = requestAnimationFrame(tick);
    if (frozen) return;

    // 「停到下一句出現」—— 取最後一個 start <= 現在時間的句。
    // 這是唯一完全可預測的規則：使用者不需要在腦中維護計時器，
    // 而且純音效 cue 已經被排除，不會造成畫面忽然空白
    const index = indexAt(dialogue, video.currentTime);
    if (index === shownIndex) return;
    shownIndex = index;
    render();
  });

  function render(): void {
    const cue = dialogue[shownIndex];

    lineEl.replaceChildren();
    if (!cue) return;

    for (const token of cue.text.split(/(\s+)/)) {
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        lineEl.append(token);
        continue;
      }
      lineEl.append(makeWord(token, cue, options.onWordClick));
    }

    if (!announced) {
      announced = true;
      options.onFirstRender?.();
    }
  }

  return {
    setCues(cues) {
      dialogue = cues;
      shownIndex = -1;
    },
    current: () => dialogue[shownIndex] ?? null,
    previous: () => (shownIndex > 0 ? dialogue[shownIndex - 1] ?? null : null),
    toast: (message) => showToast(root, message),
    setVisible: (visible) => root.classList.toggle('lexicap-hidden', !visible),
    isVisible: () => !root.classList.contains('lexicap-hidden'),
    destroy() {
      cancelAnimationFrame(rafId);
      detachRemount();
      detachControls();
      root.remove();
    },
  };
}

/** 取最後一個 start <= seconds 的句 */
function indexAt(cues: Cue[], seconds: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= seconds) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function makeWord(token: string, cue: Cue, onClick: OverlayOptions['onWordClick']): HTMLElement {
  const span = document.createElement('span');
  span.className = 'lexicap-word';
  span.textContent = token;

  // 去掉前後標點才是要查的字，但顯示仍保留原樣
  const word = token.replace(/^[^\p{L}'’-]+|[^\p{L}'’-]+$/gu, '');

  // Netflix 在播放器容器上掛了「點擊 = play/pause」。因為 Overlay 是我們自己的
  // 節點，可以在 capture phase 就把事件攔下來，不會冒泡到播放器。
  // 不模擬點擊恢復播放 —— 那會跟播放器狀態產生 race condition
  for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick'] as const) {
    span.addEventListener(
      type,
      (event) => {
        event.stopPropagation();
        event.preventDefault();
        if (type === 'click' && word) onClick(word, cue);
      },
      true,
    );
  }

  return span;
}

/** 掛在播放器容器內部 —— 掛在外面全螢幕時會消失 */
function mount(root: HTMLElement): void {
  const host = document.querySelector('.watch-video') ?? document.body;
  if (root.parentElement !== host) host.append(root);
}

/** Netflix 是 React，重繪會把我們的節點掃掉，得自己掛回去 */
function keepMounted(root: HTMLElement): () => void {
  const mo = new MutationObserver(() => {
    if (!root.isConnected) mount(root);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return () => mo.disconnect();
}

/**
 * 控制列出現時把 Overlay 往上挪。
 * 實測 `[data-uia="player"]` 在 active / inactive 之間切換（見 FINDINGS）。
 * 絕不依賴 `default-ltr-iqcdef-cache-*` 那類 CSS-in-JS 雜湊 class。
 */
function followControls(root: HTMLElement): () => void {
  const player = document.querySelector('[data-uia="player"]');
  if (!player) return () => {};

  const sync = () => root.classList.toggle('lexicap-raised', player.classList.contains('active'));
  const mo = new MutationObserver(sync);
  mo.observe(player, { attributes: true, attributeFilter: ['class'] });
  sync();
  return () => mo.disconnect();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** 右下角 1 秒微型提示。禁止 modal / tooltip / 彈出卡片 —— 讀了就會斷 */
function showToast(root: HTMLElement, message: string): void {
  let el = root.querySelector<HTMLElement>('.lexicap-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'lexicap-toast';
    root.append(el);
  }
  el.textContent = message;
  el.classList.add('lexicap-toast-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove('lexicap-toast-show'), 1000);
}

function injectStyles(): void {
  if (document.getElementById('lexicap-styles')) return;
  const style = document.createElement('style');
  style.id = 'lexicap-styles';
  style.textContent = `
/*
 * 遮蔽原生字幕。
 *
 * 為什麼是 CSS 而不是 player.setTimedTextVisibility()：實測用那個 API
 * 開關之後，Netflix 會把字幕位置重置，不會還原成使用者原本的設定。
 * 這裡只加一條 stylesheet 規則，播放器的字幕狀態完全不動 ——
 * 移除 class 就回到原樣，位置、字級、間距都跟沒裝擴充時一致。
 *
 * （stylesheet 規則不受 React 重繪影響，會被重繪蓋掉的是元素的 inline style。）
 */
html.lexicap-active .player-timedtext { visibility: hidden !important; }

#${ROOT_ID} {
  /* fixed 而非 absolute：不依賴 .watch-video 有沒有定位脈絡，
     且全螢幕時 fixed 是相對於全螢幕視窗，兩種狀態都正確 */
  position: fixed;
  left: 0; right: 0; bottom: 9vh;
  z-index: 2147483000;          /* 疊在播放器控制列之上 */
  pointer-events: none;          /* 只有單字接受事件，其餘讓給播放器 */
  text-align: center;
  font-family: system-ui, -apple-system, "Helvetica Neue", sans-serif;
  transition: bottom .2s ease;
  user-select: none;
}
#${ROOT_ID}.lexicap-raised { bottom: 19vh; }   /* 控制列出現時讓開 */
#${ROOT_ID}.lexicap-hidden { display: none; }

#${ROOT_ID} .lexicap-line {
  font-size: 2.4vw;
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: .02em;         /* 放大字距，降低點擊精度需求 */
  color: #fff;
  text-shadow: 0 2px 8px rgba(0,0,0,.95);
  max-width: 80%;
  margin: 0 auto;
}
#${ROOT_ID} .lexicap-word {
  pointer-events: auto;
  cursor: pointer;
  padding: .05em .12em;
  border-radius: .2em;
  transition: background-color .1s;
}
#${ROOT_ID} .lexicap-word:hover { background: rgba(229,9,20,.85); }

#${ROOT_ID} .lexicap-toast {
  position: fixed;
  right: 2vw; bottom: 2vh;
  padding: .5em 1em;
  border-radius: 6px;
  background: rgba(0,0,0,.82);
  color: #fff;
  font-size: 14px;
  opacity: 0;
  transition: opacity .15s;
}
#${ROOT_ID} .lexicap-toast-show { opacity: 1; }
`;
  document.head.append(style);
}
