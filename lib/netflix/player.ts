/**
 * Netflix player API 包裝。只在 MAIN world 可用（依賴 window.netflix）。
 *
 * 實測重點（見 spike/FINDINGS.md）：
 *  - 寫 video.currentTime 會被播放器覆寫 → 回跳必須用 pl.seek(毫秒)
 *  - 方法都掛在 prototype 上，Object.keys 看不到
 */

interface NetflixPlayer {
  seek(ms: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getMovieId(): number;
  isPlaying(): boolean;
  play(): void;
  pause(): void;
  /**
   * ⚠️ 不要用它來隱藏原生字幕。實測開關後 Netflix 會重置字幕位置，
   * 而不是還原成使用者原本的設定。遮蔽用 CSS 規則做（見 lib/overlay.ts）。
   */
  setTimedTextVisibility(visible: boolean): void;
  /** 使用者當下選的字幕軌。與「顯不顯示」是兩個獨立狀態，所以我們壓住顯示也讀得到 */
  getTimedTextTrack(): unknown;
}

declare global {
  interface Window {
    netflix?: {
      appContext?: {
        state?: {
          playerApp?: {
            getAPI?: () => {
              videoPlayer: {
                getAllPlayerSessionIds(): string[];
                getVideoPlayerBySessionId(id: string): NetflixPlayer;
              };
            };
          };
        };
      };
    };
  }
}

export function getPlayer(): NetflixPlayer | null {
  try {
    const vp = window.netflix?.appContext?.state?.playerApp?.getAPI?.().videoPlayer;
    const session = vp?.getAllPlayerSessionIds()[0];
    return session ? vp!.getVideoPlayerBySessionId(session) : null;
  } catch {
    return null;
  }
}

/** 當前正在播的那一集。用來比對 manifest —— Netflix 會預抓別集的 manifest */
export function currentMovieId(): string | null {
  const id = getPlayer()?.getMovieId();
  return id ? String(id) : null;
}

export function seekTo(seconds: number): boolean {
  const player = getPlayer();
  if (!player) return false;
  player.seek(Math.round(seconds * 1000));
  return true;
}

export function getCurrentTime(): number {
  return (getPlayer()?.getCurrentTime() ?? 0) / 1000;
}

/**
 * 使用者當下選的字幕語言。
 *
 * 物件形狀未經探勘確認，所以廣撒網取常見欄位名；取不到時回 null，
 * 呼叫端據此保守處理（不接管，讓 Netflix 自己的字幕照常顯示）。
 */
export function selectedSubtitleLanguage(): string | null {
  let track: unknown;
  try {
    track = getPlayer()?.getTimedTextTrack();
  } catch {
    return null;
  }
  if (!track || typeof track !== 'object') return null;
  const fields = track as Record<string, unknown>;

  // isNoneTrack = 使用者把字幕關掉了
  if (fields['isNoneTrack'] === true) return 'off';

  for (const key of ['bcp47', 'language', 'languageCode', 'locale']) {
    const value = fields[key];
    if (typeof value === 'string' && value) return value;
  }

  // id 不是語言碼，是 `T:2:1;2;en;1;1;` 這種複合字串 —— 整串拿去比對開頭
  // 永遠不會等於 en。撈出其中的語言碼片段，撈不到就當作讀不到
  const id = fields['id'];
  if (typeof id === 'string') {
    const hit = id.split(/[;:,]/).find((part) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(part));
    if (hit) return hit;
  }
  return null;
}

/**
 * 片名。會跟著 Netflix UI 語言在地化，且**只在控制列顯示時才掛上 DOM**。
 * 取不到是正常的，呼叫端應快取上一次成功的結果。
 */
export function readTitle(): string | null {
  const el = document.querySelector<HTMLElement>('[data-uia="video-title"]');
  const text = el?.innerText?.trim();
  return text || null;
}

/**
 * 控制列顯隱。實測 `[data-uia="player"]` 在 active / inactive 之間切換。
 *
 * ⚠️ 絕對不要依賴 `default-ltr-iqcdef-cache-*` 那類 class —— 那是 CSS-in-JS
 * 產生的雜湊，Netflix 每次重建都會變。`data-uia` 是 Netflix 自己的測試
 * 自動化屬性，是這個頁面上最穩定的識別面。
 */
export function watchControlsVisibility(cb: (visible: boolean) => void): () => void {
  const root = document.querySelector('[data-uia="player"]');
  if (!root) return () => {};

  const emit = () => cb(root.classList.contains('active'));
  const mo = new MutationObserver(emit);
  mo.observe(root, { attributes: true, attributeFilter: ['class'] });
  emit();

  return () => mo.disconnect();
}

/** 全螢幕時 Overlay 必須掛在這裡面，掛在外面會消失 */
export function getPlayerRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.watch-video') ?? document.querySelector<HTMLElement>('#appMountPoint');
}
