import { findByKey } from '@/lib/deepScan';
import { CUES_MESSAGE, postCues, onCommandMessage, postEpisode, postState } from '@/lib/bridge';
import { currentMovieId, seekTo, selectedSubtitleLanguage } from '@/lib/netflix/player';
import { pickEnglishTrack, webvttUrlFor, WEBVTT_PROFILE, type NetflixTextTrack } from '@/lib/netflix/tracks';

/**
 * MAIN world：攔截 Netflix manifest 取得字幕。
 *
 * 為什麼是 JSON.parse 而不是 XMLHttpRequest：manifest 走 MSL 加密，
 * 網路層看不到明文，但 Netflix 一定得用 JSON.parse 把它解出來。
 * 這也讓它不依賴任何 selector 或 React 結構 —— 最耐改版的 hook 點。
 *
 * 必須 run_at: document_start，否則 hook 會裝在 manifest 請求之後。
 */
export default defineContentScript({
  matches: ['https://*.netflix.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    /** Netflix 會預抓下一集與推薦內容的 manifest，一次播放可能攔到多份 */
    const byMovie = new Map<string, NetflixTextTrack[]>();
    let sentFor: string | null = null;

    // ISOLATED world 拿不到 window.netflix，這些只能在這邊代辦
    let overlayWanted = false;
    /** 已經送給 ISOLATED 的狀態。null = 還沒送過，下一輪一定送 */
    let applied: boolean | null = null;
    onCommandMessage((command) => {
      if (command.action === 'overlayReady') {
        overlayWanted = true;   // Overlay 已成功渲染，可以開始接管
        // 必須清掉快取後再算一次。Overlay ready 之前每一輪算出來的都是「不接管」，
        // 使用者選的若是中文，ready 之後算出來還是「不接管」—— 值沒變就不會送，
        // ISOLATED 端也就永遠等不到指示。清掉快取才能保證 ready 後一定送出一次
        applied = null;
        syncSubtitles();
      } else if (command.action === 'seek') {
        seekTo(command.seconds);
      }
    });

    /**
     * 跟著使用者選的字幕軌走。只有使用者自己選了英文軌才接管，
     * 選中文、選別的語言、關掉字幕、或根本讀不到字幕軌狀態時一律不接管 ——
     * Overlay 預設就是收著的，這裡只負責在確定是英文軌時把它打開。
     *
     * ⚠️ 這裡**只讀不寫**，絕不呼叫 setTimedTextVisibility()。
     * 實測用它開關字幕後，Netflix 會把字幕位置重置，不是還原成使用者
     * 原本的位置。遮蔽改由 ISOLATED 用一條 CSS 規則做 —— 播放器的字幕
     * 狀態完全不動，就沒有東西會被重置。
     */
    let loggedTrack = false;
    function syncSubtitles(): void {
      const language = selectedSubtitleLanguage();

      if (!loggedTrack && language !== null) {
        loggedTrack = true;
        // 這個物件的形狀沒有實際探勘過，印一次供確認取值是否正確
        console.log('[lexicap] 目前字幕軌語言：', language);
      }
      // 讀不到就什麼都別做，保守處理勝過亂關使用者的字幕
      if (language === null) return;

      const takeOver = overlayWanted && /^en/i.test(language);
      if (takeOver === applied) return;
      applied = takeOver;

      postState(takeOver);
    }

    setInterval(() => {
      syncSubtitles();
      // 只有這裡問得到播放器現在在播哪一集。ISOLATED 靠它認出換集，
      // 才不會把上一集的台詞掛在新一集的時間軸上
      const movieId = currentMovieId();
      if (movieId) postEpisode(movieId);
    }, 1000);

    installStringifyHook();
    installParseHook(byMovie, () => tryEmit(byMovie, () => sentFor, (id) => (sentFor = id)));

    // SPA 換集時網址與 movieId 會變，但不會重新載入頁面
    setInterval(() => tryEmit(byMovie, () => sentFor, (id) => (sentFor = id)), 2000);
  },
});

/**
 * 把 WebVTT profile 注入 manifest 請求，換得 WebVTT 而非 DFXP/TTML。
 * WebVTT 的時間單位直接是秒；TTML 是 tick（1 秒 = 10,000,000），
 * 解析難度差一個數量級。
 *
 * 實測命中兩個路徑，兩個都要注入：
 *   params.profiles / params.profileGroups[].profiles
 *
 * ⚠️ 必須 clone 後再改。直接對 Netflix 的物件 push 會污染它的內部狀態，
 *    實測會造成 `TypeError: Cannot read properties of undefined (reading 'startTime')`。
 */
function installStringifyHook(): void {
  const original = JSON.stringify;

  JSON.stringify = function (this: unknown, value: unknown, ...rest: unknown[]) {
    const text = (original as (...a: unknown[]) => string).call(this, value, ...rest);

    try {
      const isManifestRequest =
        typeof text === 'string' &&
        text.length < 300_000 &&
        text.includes('"profiles"') &&
        /manifest|viewableId|licensedManifest/i.test(text) &&
        !text.includes(WEBVTT_PROFILE) &&
        typeof rest[0] !== 'function'; // 有 replacer 就別動，避免改變語意

      if (isManifestRequest) {
        const clone = JSON.parse(text) as unknown;
        const arrays = findByKey(clone, 'profiles').filter(
          (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'),
        );
        if (arrays.length) {
          arrays.forEach((a) => a.push(WEBVTT_PROFILE));
          return (original as (...a: unknown[]) => string).call(this, clone, ...rest);
        }
      }
    } catch {
      // 注入失敗不該讓 Netflix 的請求掛掉，靜默退回原始輸出
    }

    return text;
  } as typeof JSON.stringify;
}

/** 攔截 manifest 回應，取出 `$.result.textTracks` 與 `$.result.movieId` */
function installParseHook(byMovie: Map<string, NetflixTextTrack[]>, onFound: () => void): void {
  const original = JSON.parse;

  JSON.parse = function (this: unknown, text: string, ...rest: unknown[]) {
    const parsed = (original as (...a: unknown[]) => unknown).call(this, text, ...rest);

    try {
      // 先用原始字串做廉價過濾，命中才深掃 —— Netflix 每秒會 parse 很多東西
      if (typeof text === 'string' && text.length > 2000 && text.includes('"textTracks"')) {
        const result = (parsed as { result?: Record<string, unknown> })?.result;
        const tracks = findByKey(parsed, 'textTracks').find(
          (v): v is NetflixTextTrack[] => Array.isArray(v) && v.length > 0,
        );
        const movieId = result?.['movieId'];

        if (tracks && movieId != null) {
          byMovie.set(String(movieId), tracks);
          onFound();
        }
      }
    } catch {
      // 同上，絕不讓探測失敗影響 Netflix 本身
    }

    return parsed;
  } as typeof JSON.parse;
}

/**
 * 只送出「當前正在播的那一集」的字幕。
 * 不比對 movieId 的話，會偶發性地把別集的字幕掛到這集上 —— 難查到極點。
 */
function tryEmit(
  byMovie: Map<string, NetflixTextTrack[]>,
  getSent: () => string | null,
  setSent: (id: string) => void,
): void {
  const movieId = currentMovieId();
  if (!movieId || getSent() === movieId) return;

  const tracks = byMovie.get(movieId);
  if (!tracks) return;

  const track = pickEnglishTrack(tracks);
  if (!track) return;

  const url = webvttUrlFor(track);
  if (!url) return;

  setSent(movieId);
  void fetch(url)
    .then((r) => r.text())
    .then((vtt) => postCues({ type: CUES_MESSAGE, movieId, vtt, trackLabel: track.languageDescription }))
    .catch(() => {});
}
