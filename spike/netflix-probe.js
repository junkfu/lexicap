/* ============================================================
 * Lexicap — Netflix 探勘 spike（步驟 0）v10
 *
 * v3 改動（v2 的實測結果：stringify 注入成功、manifest 確實經過 JSON.parse，
 *   但 timedtexttracks 這個 key 找不到 —— 欄位名或結構已改）：
 *   1. 不再只找 timedtexttracks，改成掃所有符合 /timed.?text|subtitle|caption|
 *      texttrack/i 的 key，並印出實際 key 名與路徑。
 *   2. 直接印出 manifest 的 Object.keys(result)，一眼看出真實欄位名。
 *   3. 印出原始字串裡 "timedtext" 實際出現的位置與前後文，
 *      確認當初到底是什麼東西命中了過濾條件。
 *   4. 攔到的 manifest 全部存進 lexicap.manifests，可在 console 直接展開翻。
 *   5. 過濾掉 /events?playbackContextId 這類 beacon 雜訊。
 *
 * 【使用順序】
 *   1. 開 https://www.netflix.com/browse   ← 不要在播放頁
 *   2. F12 → Console → 貼上整段 → Enter
 *   3. 點進一集，**真的開始播放正片**（不是預告片）
 *   4. 執行  lexicap.status()      ← 先看這個
 *   5. 執行  await lexicap.grab()
 *   6. 執行  await lexicap.compare()   ← CC 軌 vs subtitles 軌 逐句對照
   7. 執行  lexicap.env()
 * ============================================================ */

(() => {
  const S = 'color:#fff;background:#e50914;padding:2px 6px;border-radius:3px;font-weight:bold';
  const log = (...a) => console.log('%c[lexicap]', S, ...a);
  const warn = (...a) => console.warn('%c[lexicap]', S, ...a);

  if (window.__lexicapProbe) {
    warn('已安裝過 hook。請按 F5 重新整理後再貼一次，否則會疊成兩層。');
    return;
  }
  window.__lexicapProbe = true;

  const WEBVTT = 'webvtt-lssdh-ios8';
  const _parse = JSON.parse;
  const _stringify = JSON.stringify;

  const state = {
    inject: true,
    parseCalls: 0,
    rawHits: 0,
    injected: 0,
    stringifySamples: [],
    manifestUrls: [],
    hits: [],
    manifests: [],
    byMovie: {},
    autoRan: {},
    auto: true,
    tracksPath: null,
    tracks: null,
    movieId: null,
    cues: null,
  };

  // 深掃找 key（有深度上限與環狀保護）
  function findKey(root, key, maxDepth = 10) {
    const out = [];
    const seen = new WeakSet();
    (function walk(o, path, d) {
      if (!o || typeof o !== 'object' || d > maxDepth || seen.has(o)) return;
      seen.add(o);
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (k === key) out.push({ path: path + '.' + k, value: v, parent: o });
        if (v && typeof v === 'object') walk(v, path + '.' + k, d + 1);
      }
    })(root, '$', 0);
    return out;
  }

  // 掃「key 名稱符合 regex」的所有節點
  function findKeysMatching(root, re, maxDepth = 12) {
    const out = [];
    const seen = new WeakSet();
    (function walk(o, path, d) {
      if (!o || typeof o !== 'object' || d > maxDepth || seen.has(o)) return;
      seen.add(o);
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (re.test(k)) {
          out.push({
            path: path + '.' + k,
            key: k,
            kind: Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v,
            value: v,
          });
        }
        if (v && typeof v === 'object') walk(v, path + '.' + k, d + 1);
      }
    })(root, '$', 0);
    return out;
  }

  // 目前網址列上正在播的那一集
  const currentMovieId = () => location.pathname.match(/\/watch\/(\d+)/)?.[1] || null;

  // 原始字串裡某個子字串實際出現在哪、前後文長什麼樣
  function whereIs(text, needle, max = 4) {
    const out = [];
    let i = -1;
    while ((i = text.indexOf(needle, i + 1)) !== -1 && out.length < max) {
      out.push('…' + text.slice(Math.max(0, i - 70), i + 90) + '…');
    }
    return out;
  }

  // ---------------------------------------------------------------
  // 1. stringify hook —— clone 後注入，絕不碰 Netflix 原本的物件
  // ---------------------------------------------------------------
  JSON.stringify = function (value, ...rest) {
    const text = _stringify.call(this, value, ...rest);
    try {
      if (
        state.inject &&
        typeof text === 'string' &&
        text.length < 300000 &&
        text.includes('"profiles"') &&
        /manifest|viewableId|licensedManifest/i.test(text) &&
        !text.includes(WEBVTT) &&
        typeof rest[0] !== 'function'   // 有 replacer 就不動，避免語意改變
      ) {
        if (state.stringifySamples.length < 5) state.stringifySamples.push(text.slice(0, 600));
        const clone = _parse(text);
        const arrs = findKey(clone, 'profiles').filter(
          (f) => Array.isArray(f.value) && f.value.every((x) => typeof x === 'string')
        );
        if (arrs.length) {
          arrs.forEach((a) => a.value.push(WEBVTT));
          state.injected++;
          log(`✅ 注入 WebVTT profile（第 ${state.injected} 次） 路徑：${arrs.map((a) => a.path).join(' , ')}`);
          return _stringify.call(this, clone, ...rest);
        }
      }
    } catch (_) {}
    return text;
  };

  // ---------------------------------------------------------------
  // 2. parse hook —— 先用原始字串做廉價過濾，再深掃
  // ---------------------------------------------------------------
  JSON.parse = function (text, ...rest) {
    const obj = _parse.call(this, text, ...rest);
    state.parseCalls++;
    try {
      const looksLikeManifest =
        typeof text === 'string' &&
        text.length > 2000 &&
        !text.startsWith('[{"href"') &&      // 排除 /events beacon 雜訊
        // 只認真正帶 track 陣列的 payload。
        // 用 viewableId/profiles 當條件會誤判 Netflix 的遙測 beacon
        // （locid, esn, browsername, appLogSeqNum… 那一票）。
        /"(textTracks|audioTracks|videoTracks|timedtexttracks)"/.test(text);

      if (looksLikeManifest) {
        state.manifests.push(obj);
        const res = obj?.result ?? obj;
        const keys = res && typeof res === 'object' ? Object.keys(res) : [];
        log(`📦 攔到疑似 manifest（第 ${state.manifests.length} 個，${text.length} bytes）`);
        log('   result 的 key：', keys.join(', ') || '(無)');

        // 找所有跟字幕沾邊的 key
        // audioTracks[].defaultTimedText / allowedTextTracks / selectableTextTracks
        // 每軌都有一份，97 列裡有 93 列是這種雜訊，會蓋掉真正有用的輸出
        const NOISE = /^(defaultTimedText|allowedTextTracks|selectableTextTracks)$/;
        const subKeys = findKeysMatching(obj, /timed.?text|subtitle|caption|texttrack/i)
          .filter((k) => !NOISE.test(k.key));
        if (subKeys.length) {
          log('   字幕相關 key：');
          console.table(subKeys.map(({ path, key, kind }) => ({ path, key, kind })));
          const arr = subKeys.find((k) => Array.isArray(k.value) && k.value.length);
          if (arr) {
            const mid = String(
              res?.movieId ?? findKey(obj, 'movieId')[0]?.value ?? findKey(obj, 'viewableId')[0]?.value ?? ''
            );
            // ⚠️ Netflix 會預抓下一集／推薦內容的 manifest，一次播放可能攔到多份。
            //    依 movieId 分開存，絕不互相覆蓋。
            state.byMovie[mid] = { tracks: arr.value, path: arr.path, duration: res?.duration };
            state.tracks = arr.value;
            state.tracksPath = arr.path;
            state.movieId = mid;
            const cur = currentMovieId();
            const mark = cur ? (mid === cur ? '✅ 就是當前播放的這集' : `⚠️ 非當前播放（網址是 ${cur}）→ 預抓的別集`) : '(網址不在播放頁)';
            log(`🎯 ${arr.path}（${arr.value.length} 軌） movieId=${mid} ${mark}`);

            // 攔到當前這集就自動往下跑，不用手動在 console 打指令
            if (state.auto && cur && mid === cur && !state.autoRan[mid]) {
              state.autoRan[mid] = true;
              log('⏳ 自動執行 grab() → compare()…');
              setTimeout(() => {
                grab()
                  .then(() => compare())
                  .then(() => log('✅ 全部跑完。最後執行 lexicap.env() 探測播放器環境'))
                  .catch((e) => warn('自動執行失敗：', e));
              }, 300);
            }
            log('   第一個 track 的 key：', Object.keys(arr.value[0] || {}).join(', '));
            console.table(
              arr.value.slice(0, 20).map((t) => ({
                language: t.language,
                desc: t.languageDescription,
                type: t.rawTrackType ?? t.trackType,
                isNone: t.isNoneTrack,
                downloadables: Object.keys(t.ttDownloadables || t.downloadables || {}).join(', '),
              }))
            );
            log('下一步： await lexicap.grab()');
          } else {
            log('   ⚠️ 有相關 key 但都不是非空陣列，展開 lexicap.manifests 手動翻');
          }
        } else {
          log('   ⚠️ 完全找不到字幕相關 key。');
          log('   "timedtext" 出現在原始字串的位置：', whereIs(text, 'timedtext'));
          log('   "TimedText" 出現的位置：', whereIs(text, 'TimedText'));
          log('   → 展開 lexicap.manifests[' + (state.manifests.length - 1) + '] 手動翻');
        }
      }
    } catch (_) {}
    return obj;
  };

  // ---------------------------------------------------------------
  // 3. 網路請求 URL 記錄（只記 URL，不碰 body）
  // ---------------------------------------------------------------
  const isManifesty = (u) => /manifest|licensedManifest|\/msl|playapi|\/nq\//i.test(String(u));
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const u = typeof input === 'string' ? input : input?.url;
      if (isManifesty(u)) state.manifestUrls.push({ via: 'fetch', url: String(u).slice(0, 200) });
    } catch (_) {}
    return _fetch.apply(this, arguments);
  };
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...r) {
    try {
      if (isManifesty(url)) state.manifestUrls.push({ via: 'xhr', url: String(url).slice(0, 200) });
    } catch (_) {}
    return _open.call(this, method, url, ...r);
  };

  // ---------------------------------------------------------------
  // 4. 現況回報 —— 先跑這個
  // ---------------------------------------------------------------
  function status() {
    log('--- 現況 ---');
    log(`JSON.parse 呼叫次數：${state.parseCalls}`);
    log(`攔到的疑似 manifest 數：${state.manifests.length}`);
    log(`profile 注入次數：${state.injected}`);
    log(`manifest 類請求數：${state.manifestUrls.length}`);
    if (state.manifestUrls.length) console.table(state.manifestUrls.slice(-10));
    const cur = currentMovieId();
    log(`網址上的 movieId：${cur || '(不在播放頁)'}`);
    const ids = Object.keys(state.byMovie);
    if (ids.length) {
      log('已攔到的 manifest（Netflix 會預抓別集，所以可能不只一份）：');
      console.table(ids.map((id) => ({
        movieId: id,
        軌數: state.byMovie[id].tracks.length,
        時長秒: state.byMovie[id].duration,
        當前這集: id === cur ? '✅' : '',
      })));
    }
    log(`字幕清單：${tracksForCurrent() ? '✅ 可用' : '❌ 尚未取得'}`);

    if (!state.tracks) {
      if (state.manifestUrls.length === 0) {
        warn('判讀：完全沒有 manifest 請求 → 你可能還沒開始播放正片。去點一集播放後再跑一次。');
      } else if (state.manifests.length === 0) {
        warn('判讀：有 manifest 請求，但 JSON.parse 沒攔到任何疑似 manifest 的 payload。');
        warn('      → manifest 可能不是透過 JSON.parse 解出來的，§6.3 前提要重新評估。');
      } else {
        warn('判讀：攔到 manifest 但找不到字幕陣列。上面已印出 result 的 key 與字幕相關 key。');
        warn('      → 直接展開 lexicap.manifests[0].result 翻，或把上面的輸出貼回來。');
      }
    }
    return state;
  }

  // ---------------------------------------------------------------
  // 5. 下載並解析英文字幕
  // ---------------------------------------------------------------
  const dl = (t) => t.ttDownloadables || t.downloadables || {};

  // 實測（2026-09）：陣列在 $.result.textTracks，下載欄位是 downloadables，
  // 且只有部分軌被 hydrate（其餘 downloadables 為空）。
  // 一律取「網址上這一集」的軌；取不到才退回最後攔到的那份
  function tracksForCurrent() {
    const cur = currentMovieId();
    if (cur && state.byMovie[cur]) return state.byMovie[cur].tracks;
    const ids = Object.keys(state.byMovie);
    if (cur) warn(`⚠️ 沒攔到當前這集(${cur})的 manifest。已攔到的：${ids.join(', ') || '無'}`);
    return state.tracks;
  }

  function pickEnglishTrack() {
    const tracks = tracksForCurrent();
    if (!tracks) return null;
    const cand = tracks.filter(
      (t) => !t.isNoneTrack && /^en/i.test(t.language || '') && Object.keys(dl(t)).length > 0
    );
    // closedcaptions 會夾帶 [tapping] 這類音效描述，對學語言是雜訊 → 優先 subtitles
    // 原則 3「回跳重聽原音」→ 字幕必須逐字貼近實際台詞。
    // 英語原聲內容：CC/SDH 最逐字；plain subtitles 常為閱讀速度被精簡改寫。
    // 音效描述與說話者標籤可以 regex 剝除，被改寫過的台詞救不回來 → 優先 CC。
    const score = (t) => {
      const type = t.rawTrackType ?? t.trackType;
      let n = 0;
      if (type === 'closedcaptions') n += 4;
      else if (type === 'subtitles') n += 1;
      if (!t.isForcedNarrative) n += 2;   // forced narrative 只翻外語對白，不是完整字幕
      if (dl(t)[WEBVTT]) n += 1;
      return n;
    };
    const ranked = cand.map((t) => ({ t, n: score(t) })).sort((a, b) => b.n - a.n);
    if (ranked.length) {
      log('英文軌候選（分數高者勝）：');
      console.table(ranked.map(({ t, n }) => ({
        score: n,
        language: t.language,
        desc: t.languageDescription,
        type: t.rawTrackType ?? t.trackType,
        forced: !!t.isForcedNarrative,
        hydrated: t.hydrated,
      })));
    }
    return ranked[0]?.t || null;
  }

  // 不猜欄位名（上一輪的教訓）：深掃出第一個 http 字串就是下載點
  function extractUrl(d) {
    const urls = [];
    const seen = new WeakSet();
    (function walk(o, depth) {
      if (o == null || depth > 6) return;
      if (typeof o === 'string') { if (/^https?:\/\//.test(o)) urls.push(o); return; }
      if (typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      for (const v of Object.values(o)) walk(v, depth + 1);
    })(d, 0);
    return urls[0] || null;
  }

  // 音效描述 [door slams] (laughs) ♪ ，以及行首的說話者標籤 "-MAN:" "KURAPIKA:"
  const SFX = /\[[^\]]*\]|\([^)]*\)|♪/g;
  const SPEAKER = /^\s*-?\s*[A-Z][A-Z0-9 .'’-]{1,24}:\s*/;
  const stripSfx = (t) => t.replace(SFX, '').replace(SPEAKER, '').replace(/\s+/g, ' ').trim();

  function parseVtt(text) {
    const toSec = (t) => {
      const m = t.trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
      if (!m) return NaN;
      return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    };
    const cues = [];
    for (const block of text.replace(/\r/g, '').split('\n\n')) {
      const lines = block.split('\n').filter(Boolean);
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i === -1) continue;
      const [a, b] = lines[i].split('-->');
      const parts = lines.slice(i + 1).map((l) => l.replace(/<[^>]+>/g, ''));
      const raw = parts.join(' ').replace(/\s+/g, ' ').trim();
      // 逐行清理：說話者標籤只出現在行首，join 之後就抓不到了
      const text = parts
        .map((l) => l.replace(SFX, '').replace(SPEAKER, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (raw) cues.push({ start: toSec(a), end: toSec(b), text, raw });
    }
    return cues;
  }

  async function grab() {
    const track = pickEnglishTrack();
    if (!track) {
      warn('❌ 找不到英文 track。先跑 lexicap.status()，或看 lexicap.tracks');
      return null;
    }
    const d = dl(track);
    const profile = d[WEBVTT] ? WEBVTT : Object.keys(d)[0];
    if (profile !== WEBVTT) {
      warn(`⚠️ 沒拿到 WebVTT，只有 ${profile}。注入次數=${state.injected}。`);
      warn('   看 lexicap.stringifySamples 確認 profiles 陣列實際長什麼樣。');
    }
    const url = extractUrl(d[profile]);
    if (!url) {
      warn('❌ 深掃不到 http URL。該 profile 的原始物件：', d[profile]);
      warn('   完整 downloadables：', d);
      return null;
    }
    log('選用 track：', {
      language: track.language,
      desc: track.languageDescription,
      type: track.rawTrackType ?? track.trackType,
      profile,
    });
    log(`下載中… (${track.language} / ${profile})`);
    const text = await (await fetch(url)).text();
    if (profile !== WEBVTT) {
      log('非 WebVTT，原始前 500 字：\n' + text.slice(0, 500));
      return null;
    }
    const cues = parseVtt(text);
    state.cues = cues;
    const dirty = cues.filter((c) => c.text !== c.raw);
    const empty = cues.filter((c) => !c.text);
    log(`✅ 解析出 ${cues.length} 句；其中 ${dirty.length} 句含音效描述或說話者標籤，`
      + `${empty.length} 句清理後全空（純音效，擷取時應略過）`);
    log('前 8 句（text = 清理後，raw = 原始）：');
    console.table(cues.slice(0, 8).map((c) => ({ start: c.start, end: c.end, text: c.text, raw: c.raw })));
    if (dirty.length) {
      log('被清理掉東西的句子（前 8 句），確認 regex 沒誤殺：');
      console.table(dirty.slice(0, 8).map((c) => ({ start: c.start, text: c.text, raw: c.raw })));
    }
    return cues;
  }

  // ---------------------------------------------------------------
  // 5b. CC 軌 vs subtitles 軌 對照
  //
  //  為什麼要比：CC/SDH 逐字貼近台詞但夾帶 [door slams] ♪ 這類音效描述；
  //  plain subtitles 乾淨，但常為了閱讀速度被精簡改寫。
  //  本專案核心資產是「回跳重聽原音」—— 字幕與音對不上是致命的，
  //  而音效描述剝掉只要一行 regex。所以要用真實資料確認兩軌差多少。
  // ---------------------------------------------------------------

  async function cuesOf(track) {
    if (!track) return null;
    const d = dl(track);
    if (!d[WEBVTT]) { warn('該軌沒有 WebVTT profile：', track.languageDescription); return null; }
    const url = extractUrl(d[WEBVTT]);
    if (!url) { warn('取不出 URL：', d[WEBVTT]); return null; }
    return parseVtt(await (await fetch(url)).text());
  }

  const overlap = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start);

  async function compare(n = 15) {
    const tracks = tracksForCurrent();
    if (!tracks) return warn('還沒攔到 track，先播放正片');
    const en = tracks.filter(
      (t) => !t.isNoneTrack && /^en/i.test(t.language || '') && Object.keys(dl(t)).length > 0
    );
    const sub = en.find((t) => (t.rawTrackType ?? t.trackType) === 'subtitles' && !t.isForcedNarrative);
    const cc = en.find((t) => (t.rawTrackType ?? t.trackType) === 'closedcaptions');
    log('subtitles 軌：', sub ? sub.languageDescription : '❌ 無', ' / CC 軌：', cc ? cc.languageDescription : '❌ 無');

    const [cSub, cCc] = await Promise.all([cuesOf(sub), cuesOf(cc)]);
    state.cuesSub = cSub;
    state.cuesCc = cCc;

    if (cSub) {
      const sfx = cSub.filter((c) => c.text !== c.raw).length;
      log(`subtitles：${cSub.length} 句，含音效描述 ${sfx} 句`);
    }
    if (cCc) {
      const sfx = cCc.filter((c) => c.text !== c.raw).length;
      log(`CC       ：${cCc.length} 句，含音效描述 ${sfx} 句`);
    }
    if (!cSub || !cCc) return log('只有一軌可用，無從比較 → 直接用那軌');

    // 以 CC 為基準，找時間重疊最多的 subtitles 句配對
    const rows = [];
    let diff = 0;
    for (const c of cCc) {
      let best = null, bestOv = 0;
      for (const t of cSub) {
        if (t.start > c.end) break;
        const ov = overlap(c, t);
        if (ov > bestOv) { bestOv = ov; best = t; }
      }
      const a = c.text, b = best ? best.text : '';   // 兩邊都用清理後的版本比
      if (a && a !== b) diff++;
      if (rows.length < n) rows.push({ t: c.start.toFixed(1), CC: c.text, subtitles: b, 同: a === b ? '✅' : '✳️' });
    }
    log(`逐句比對：${cCc.length} 句中有 ${diff} 句不一致（CC 已先剝除音效描述後再比）`);
    console.table(rows);
    log(diff / cCc.length > 0.15
      ? '👉 差異大 → 兩軌內容確實不同，用 CC（逐字貼近原音）+ 剝除音效描述'
      : '👉 差異小 → 兩軌內容幾乎一樣，用哪個都行，選 subtitles 省一道 regex');
    log('完整資料：lexicap.cuesCc / lexicap.cuesSub');
  }

  // ---------------------------------------------------------------
  // 6. 播放器環境探測
  //
  //  v9 實測結果：
  //    ⚠️ 寫 video.currentTime 會被播放器覆寫 → 回跳必須走 Netflix player API
  //    ⚠️ document.title 只有 'Netflix' → 影集名/季/集數要另外找
  //    ⚠️ 控制列監聽零輸出 → 監聽範圍或屬性不對，改掃 #appMountPoint + style
  // ---------------------------------------------------------------
  function playerObj() {
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.();
      const vp = api?.videoPlayer;
      const sess = vp?.getAllPlayerSessionIds?.()?.[0];
      return sess ? vp.getVideoPlayerBySessionId(sess) : null;
    } catch (e) {
      warn('取 player 失敗：', e.message);
      return null;
    }
  }

  // 連 prototype chain 一起列舉（Netflix 的 player 方法都在 prototype 上）
  function membersOf(o, re) {
    const names = new Set();
    let cur = o;
    while (cur && cur !== Object.prototype) {
      Object.getOwnPropertyNames(cur).forEach((n) => names.add(n));
      cur = Object.getPrototypeOf(cur);
    }
    return [...names]
      .filter((n) => re.test(n))
      .sort()
      .map((n) => {
        let t = '?';
        try { t = typeof o[n]; } catch (_) {}
        return { name: n, type: t };
      });
  }

  // --- 6a. 找 seek 方法 ---
  function envSeek() {
    const pl = playerObj();
    if (!pl) return warn('❌ 取不到 player 物件');
    log('player 上與 seek / time 相關的成員：');
    console.table(membersOf(pl, /seek|time|duration|position|play|pause/i));

    window.lexicap.seek = (sec) => {
      const ms = Math.round(sec * 1000);
      const v = document.querySelector('video');
      for (const m of ['seek', 'seekTo', 'setCurrentTime', 'setPosition']) {
        if (typeof pl[m] !== 'function') continue;
        try {
          pl[m](ms);
          setTimeout(() => log(`✅ ${m}(${ms}) → currentTime=${v.currentTime.toFixed(2)}`), 600);
          return m;
        } catch (e) { warn(`${m}() 丟錯：`, e.message); }
      }
      warn('沒有現成可用的 seek 方法，照上面表格手動試 pl.xxx(毫秒)');
      window.lexicap.player = pl;
      log('player 物件已放在 lexicap.player');
    };
    log('👉 試跳：lexicap.seek(300)   （參數是秒）');
  }

  // --- 6b. 找影集名 / 季 / 集數 ---
  function envMeta() {
    log('--- 影集名 / 季 / 集數 ---');
    const pl = playerObj();
    if (pl) {
      for (const m of ['getMetadata', 'getVideoMetadata', 'getTitle', 'getMovieId', 'getEpisodeId', 'getCurrentVideoId']) {
        if (typeof pl[m] === 'function') {
          try { log(`player.${m}() =`, pl[m]()); } catch (e) { warn(`${m}()`, e.message); }
        }
      }
      log('player 上與 meta / title 相關的成員：');
      console.table(membersOf(pl, /meta|title|episode|season|movie|viewable/i));
    }
    // Netflix 的片名多半只在控制列顯示時才掛上 DOM
    for (const sel of ['[data-uia="video-title"]', '.video-title', '[data-uia*="title"]', '.ellipsize-text']) {
      document.querySelectorAll(sel).forEach((el) => {
        const t = (el.innerText || '').trim();
        if (t) log(`DOM ${sel} →`, JSON.stringify(t.slice(0, 120)));
      });
    }
    log('※ 片名多半只在控制列出現時才掛上 DOM → 先動一下滑鼠再跑一次 lexicap.envMeta()');
  }

  // --- 6c. 控制列顯隱時到底什麼在變 ---
  function envControls(sec = 20) {
    log(`--- 控制列監聽（${sec} 秒）---`);
    log('請「移動滑鼠 → 停住不動等它淡出 → 再移動」重複兩次。');
    const root = document.querySelector('#appMountPoint') || document.body;
    const seen = new Set();
    let n = 0;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        const el = m.target;
        if (!(el instanceof Element)) continue;
        const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
        const key = m.attributeName + '|' + el.tagName + '|' + cls;
        if (seen.has(key)) continue;
        seen.add(key);
        n++;
        log(`[${m.attributeName}] <${el.tagName.toLowerCase()} ${el.getAttribute('data-uia') || ''}>`,
            m.attributeName === 'class' ? cls : el.getAttribute('style'));
      }
    });
    mo.observe(root, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
    setTimeout(() => {
      mo.disconnect();
      log(`監聽結束，共 ${n} 種不重複變動。`);
      if (n === 0) warn('仍然零輸出 → Netflix 可能用 CSS animation / :hover 而非屬性切換，Overlay 避讓要改用別的偵測方式');
    }, sec * 1000);
  }

  function env() {
    const video = document.querySelector('video');
    if (!video) return warn('❌ 找不到 <video>，你在播放頁嗎？');
    log('video.currentTime =', video.currentTime, '（秒）');
    log('掛載點：.watch-video =', !!document.querySelector('.watch-video'),
        ' / fullscreenElement =', document.fullscreenElement);
    envSeek();
    envMeta();
    log('👉 控制列要單獨跑：lexicap.envControls()   （會要你動滑鼠）');
  }

  window.lexicap = state;
  window.lexicap.status = status;
  window.lexicap.grab = grab;
  window.lexicap.compare = compare;
  window.lexicap.stripSfx = stripSfx;
  window.lexicap.env = env;
  window.lexicap.envSeek = envSeek;
  window.lexicap.envMeta = envMeta;
  window.lexicap.envControls = envControls;

  log('v10 hook 已安裝 ✅  現在去點一集，開始播放正片。');
  log('去點一集播放，grab() 與 compare() 會自動跑。');
  log('跑完後手動執行： lexicap.env()   （要在 15 秒內移動滑鼠讓控制列出現再消失）');
  log('想關掉自動執行：lexicap.auto = false');
})();
