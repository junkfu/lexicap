/**
 * Netflix 字幕軌的挑選與下載點取得。
 * 所有欄位名都是 2026-09-12 實測確認的，見 spike/FINDINGS.md。
 */

/** 注入這個 profile，Netflix 才會回 WebVTT 而不是 DFXP/TTML */
export const WEBVTT_PROFILE = 'webvtt-lssdh-ios8';

export interface NetflixTextTrack {
  language: string | null;
  languageDescription: string;
  /** 'subtitles' | 'closedcaptions' */
  rawTrackType?: string;
  trackType?: string;
  isNoneTrack: boolean;
  isForcedNarrative: boolean;
  hydrated: boolean;
  /** 以 profile 名稱為 key。欄位名是 `downloadables`，不是 `ttDownloadables` */
  downloadables?: Record<string, unknown>;
  ttDownloadables?: Record<string, unknown>;
}

const downloadablesOf = (t: NetflixTextTrack): Record<string, unknown> =>
  t.downloadables ?? t.ttDownloadables ?? {};

/**
 * 選英文軌。
 *
 * 優先 closedcaptions 而非 subtitles —— 核心原則 3 是「回跳重聽原音」，
 * 字幕必須逐字貼近實際台詞。實測同一集 CC 軌 368 句 vs subtitles 軌 260 句，
 * 差 108 句，證實 subtitles 軌為了閱讀速度被大幅精簡改寫。
 * 音效描述可以 regex 剝除，**被改寫過的台詞救不回來**。
 */
export function pickEnglishTrack(tracks: NetflixTextTrack[]): NetflixTextTrack | null {
  const candidates = tracks.filter(
    (t) =>
      !t.isNoneTrack &&
      /^en/i.test(t.language ?? '') &&
      // 只有靠近使用者語言偏好的幾軌會被 hydrate，其餘 downloadables 是空的
      Object.keys(downloadablesOf(t)).length > 0,
  );

  const score = (t: NetflixTextTrack): number => {
    const type = t.rawTrackType ?? t.trackType;
    let n = 0;
    if (type === 'closedcaptions') n += 4;
    else if (type === 'subtitles') n += 1;
    // forced narrative 只翻片中的外語對白，不是完整字幕。
    // 實測它的 languageDescription 會是「關閉」，不要用描述文字判斷
    if (!t.isForcedNarrative) n += 2;
    if (downloadablesOf(t)[WEBVTT_PROFILE]) n += 1;
    return n;
  };

  return candidates.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * 從 downloadable 取出下載 URL。
 *
 * 不寫死欄位名 —— `timedtexttracks`→`textTracks`、`ttDownloadables`→`downloadables`
 * 兩個關鍵欄位都已經改過名。深掃出第一個 http 字串最耐改版。
 */
export function extractDownloadUrl(downloadable: unknown): string | null {
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): string | null => {
    if (node == null || depth > 6) return null;
    if (typeof node === 'string') return /^https?:\/\//.test(node) ? node : null;
    if (typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    for (const value of Object.values(node)) {
      const hit = walk(value, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  return walk(downloadable, 0);
}

/** 取英文軌的 WebVTT 下載點；取不到回 null */
export function webvttUrlFor(track: NetflixTextTrack): string | null {
  const d = downloadablesOf(track);
  const profile = d[WEBVTT_PROFILE] ? WEBVTT_PROFILE : Object.keys(d)[0];
  if (!profile) return null;
  return extractDownloadUrl(d[profile]);
}
