# Netflix 平台探勘結果

> **驗證日期**：2026-09-12　**驗證方式**：`netflix-probe.js` 在真實播放頁執行
> **使用者情境**：為了學英文，Netflix 字幕一律開英文（實測當下用的是 English CC 軌）
> **重要**：這些是逆向得來的、會隨 Netflix 改版失效的事實。
> 任何一項對不上時，重跑 probe 而不是猜。

## ✅ 已驗證成立

### 字幕 track 清單

hook `JSON.parse`，攔截 manifest 回應：

| 項目 | 值 |
|---|---|
| 陣列路徑 | **`$.result.textTracks`** |
| ~~舊路徑~~ | ~~`result.timedtexttracks`~~ — **已不存在**，網路上多數教學已過期 |
| 影片 id | `$.result.movieId`（實測 `70296643`） |
| track 數 | 25 |

Track 物件的 key：

```
type, trackType, rawTrackType, id, language, languageDescription,
downloadableIds, downloadables, rank, hydrated, encodingProfileNames,
trackMapIndex, allowedVideoTracks, selectableVideoTracks,
allowedAudioTracks, selectableAudioTracks, selectionGroupId,
isNoneTrack, isLanguageLeftToRight, isForcedNarrative
```

下載欄位是 **`downloadables`**（不是 `ttDownloadables`），以 profile 名稱為 key：
`imsc1.1`, `webvtt-lssdh-ios8`, `simplesdh`, `dfxp-ls-sdh`。

### WebVTT profile 注入

hook `JSON.stringify`，在 manifest 請求送出前把 `webvtt-lssdh-ios8` 加進 profiles。
實測命中兩個路徑，**兩個都要注入**：

- `$.params.profiles`
- `$.params.profileGroups[].profiles`

**必須 clone 後再改，不可原地修改 Netflix 的物件** —— v1 直接 `push()` 造成
`TypeError: Cannot read properties of undefined (reading 'startTime')`。

### 時機

manifest 只在**開始播放正片時**請求一次。hook 必須在那之前裝好
（正式版用 `world: "MAIN"` + `run_at: "document_start"`）。
browse 頁的自動播放預告片也會觸發 manifest，不要誤判成正片。

### ⚠️ 一次播放會攔到多份 manifest（最容易寫出 bug 的地方）

實測一次播放攔到 **三份不同影片的 manifest**：

| movieId | 軌數 |
|---|---|
| 82054154 | 40 |
| 81696659 | 77 |
| 70296643 | 25 |

Netflix 會預抓下一集與推薦內容的 manifest
（`$.result.recommendedMedia.textTrackId` 印證了這點）。

**規則：攔到 `textTracks` 後必須用 `$.result.movieId` 與當前播放的影片比對，
不符就丟棄。** 當前播放的 id 取自網址 `netflix.com/watch/{id}`。

不做這個比對的話，會偶發性地把別集的字幕掛到這集上 —— 而且因為只是偶發，
極難查。probe v6 以前就有這個 bug（`state.tracks` 被最後一份覆蓋）。

### `$.result` 其他有用欄位

`duration`（總長秒數）、`bookmark`（上次看到哪）、`timecodeAnnotations`、
`partiallyHydrated`、`maxRecommendedTextRank`、`links`、`licenses`。

## ⚠️ 選軌規則（影響字幕品質，不只是能不能抓到）

1. **`hydrated` 是懶載入的** —— 25 軌裡只有靠近使用者語言偏好的那幾軌
   `downloadables` 是滿的，其餘（tr / id / he / pl / ar / th / uk）是空物件。
   → 選軌必須先過濾 `Object.keys(downloadables).length > 0`。

2. **選 `closedcaptions`（CC / SDH），不選 `subtitles`** ← 已定案

   使用者確認主要看**英語原聲影集**，所以語音與字幕本來就同語言。

   | | 逐字貼近台詞 | 雜訊 |
   |---|---|---|
   | `closedcaptions`（SDH） | ✅ 最接近實際說出來的話 | 夾帶 `[door slams]` `♪` `-MAN:` |
   | `subtitles` | ⚠️ 常為閱讀速度被**精簡改寫** | 乾淨 |

   **決策依據是核心原則 3「回跳重聽原音」**：字幕與語音對不上是致命的。
   音效描述與說話者標籤可以 regex 剝除，**被改寫過的台詞救不回來**。

   清理（必須逐行做，說話者標籤只出現在行首）：

   ```js
   const SFX     = /\[[^\]]*\]|\([^)]*\)|♪/g;
   const SPEAKER = /^\s*-?\s*[A-Z][A-Z0-9 .'’-]{1,24}:\s*/;
   ```

   Capture 應同時保留 `raw`（原始）與 `text`（清理後）；
   清理後為空的 cue（純音效）擷取時略過。

3. **避開 `isForcedNarrative`** —— 那種軌只翻片中的外語對白，不是完整字幕。

4. **`language: 'en'` 但 `languageDescription: '關閉'`** 的軌確實存在（index 5），
   不要用 languageDescription 判斷語言。

5. **manifest 一次給出全部 25 軌**，所以不受使用者當下選了哪一軌限制。
   （使用者已確認：為了學英文，字幕一律開英文，所以跨語言取軌的需求不存在。
   但這個紅利仍讓我們能自由在 CC 軌與 subtitles 軌之間選擇。）

### ✅ WebVTT 下載與解析（已驗證）

實測某集 260 句，全程無異常：

```
{start: 3.253,  end: 4.338,  text: 'Fearsome monsters.'}
{start: 5.714,  end: 6.882,  text: 'Exotic creatures.'}
{start: 19.353, end: 21.98,  text: 'The magic that comes from the word "unknown"'}
```

- **時間是乾淨的秒數**，不是 TTML tick，adapter 不需要任何換算
- 標點、大小寫完整；`<i>` 之類標籤用 `/<[^>]+>/g` 剝除後無殘留
- 選軌評分驗證有效：`en/英語/subtitles/forced:false` = 7 分勝出
- **`languageDescription: '關閉'` 的 en 軌確認就是 `isForcedNarrative` 軌**，已正確排除

### ⚠️ 「英文字幕」不一定對應「英文語音」（dub vs sub）

實測的是動畫（日語原聲）。Netflix 對非英語內容的慣例：

| 軌 | 實際內容 |
|---|---|
| `en` + `subtitles` | **原語音的翻譯字幕**（日語 → 英文） |
| `en` + `closedcaptions` | **英語配音版的 CC**，對應英文語音 |

兩者內容常有明顯差異（業界稱 dubtitles vs subtitles 問題）。

**這直接衝擊核心原則 3「回跳重聽原音」**：
若語音是日語而字幕是英譯，回跳聽到的不是筆記上那句英文，
整個「重聽原音」的價值就不成立。

manifest 裡的 `audioTracks[].allowedTextTracks` / `selectableTextTracks` /
`defaultTimedText` 正是用來描述這個對應關係的，選軌時應該納入。

**選軌規則應為：先確定語音軌語言，再選對應的文字軌** ——
英語語音 → CC 軌；非英語語音 → subtitles 軌（但此時「重聽原音」語意不同）。

### ✅ CC 軌實測（英語原聲影集）

| | CC 軌 | subtitles 軌 |
|---|---|---|
| 句數 | **368** | 260 |

**差 108 句** —— 印證 subtitles 軌確實被大幅精簡，選 CC 正確。

清理效果（`text` = 清理後，`raw` = 原始）：

```
'[roaring]'                            → ''                （純音效）
'[narrator] Strange beasts'            → 'Strange beasts'
'[Johness] I’ll tear your body apart.' → 'I’ll tear your body apart.'
```

- 368 句中 **123 句**含音效描述或說話者標籤
- 其中 **64 句（17%）清理後全空** —— 純音效 cue

**⚠️ 說話者標籤是 `[narrator]` 方括號形式**，由 SFX regex 處理。
`SPEAKER`（`MAN:` 形式）那條 regex 在此片**一次都沒觸發**，
目前是未經驗證且有誤殺風險的程式碼 → 保留但需在其他片源驗證，
或直接移除。

### ⚠️ 17% 的 cue 是純音效 → 擷取不能直接對 cue 陣列操作

按 `S` 時若當下正好是 `[roaring]`，沒有台詞可存。

**規則：維護兩個清單**
- **顯示用**：全部 cue（或直接隱藏純音效 cue）
- **可擷取**：`text` 非空的 cue

`S`（當前句）與 `A`（上一句）都只在「可擷取」清單上移動，
當下落在純音效 cue 時往前找最近的有台詞句。

### ✅ Netflix player API（回跳與控制的唯一正解）

寫 `video.currentTime` **會被播放器覆寫**，必須走 player API：

```js
const api  = netflix.appContext.state.playerApp.getAPI();
const vp   = api.videoPlayer;
const sess = vp.getAllPlayerSessionIds()[0];   // 'watch-83fe49d1-…'
const pl   = vp.getVideoPlayerBySessionId(sess);

pl.seek(300000);   // ✅ 實測成功 → currentTime=300.07。**參數是毫秒**
```

實測可用的方法（方法都在 prototype 上，`Object.keys` 看不到，要走 prototype chain）：

| 方法 | 用途 |
|---|---|
| `seek(ms)` | **回跳**。已驗證 |
| `getCurrentTime()` / `getDuration()` | 時間 |
| `play()` / `pause()` / `isPlaying()` / `getPaused()` | 播放控制 |
| **`setTimedTextVisibility(false)`** | **官方的隱藏原生字幕介面** |
| `getTimedTextTrack()` / `setTimedTextTrack()` | 讀寫使用者選的字幕軌 |
| `getTimedTextTrackList()` | 字幕軌清單 |
| `setTimedTextBounds/Margins/Size()` | 原生字幕的位置與字級 |
| `getMovieId()` | **當前這集的 id** |
| `playNextEpisode()` / `playSegment()` | — |

> **用 `setTimedTextVisibility(false)` 隱藏原生字幕，不要用 CSS `display:none`
> 打 `.player-timedtext`** —— 後者會跟 React 重繪打架，前者是播放器自己的狀態。

### ✅ 影集名 / 季 / 集數

`document.title` 只有 `'Netflix'`，沒用。兩個可用來源：

```js
pl.getMovieId()                                  // 70296643（集的 id）
document.querySelector('[data-uia="video-title"]').innerText
// → "獵人 x 獵人第 12 集：最後 x 的 x 覺悟"
```

- ⚠️ **片名會跟著 Netflix UI 語言在地化**（此處是繁中）。
  資料模型的 `videoTitle` 會存到中文片名，不是英文原名。
- ⚠️ 該元素**只在控制列顯示時才掛上 DOM** → 需在控制列出現時抓取並快取，
  或用 MutationObserver 等它出現。

**`getMovieId()` 也讓「manifest 比對」變簡單**：
不必解析網址，直接跟 `pl.getMovieId()` 比即可。

### ✅ 控制列顯隱：`[data-uia="player"]` 的 `active` / `inactive`

實測 20 秒內 14 種變動，決定性的是這兩行：

```
[class] <div data-uia="player"> inactive default-ltr-iqcdef-cache-fntwn3
[class] <div data-uia="player"> active   default-ltr-iqcdef-cache-fntwn3
```

→ Overlay 避讓：MutationObserver 監聽 `[data-uia="player"]` 的 class，
   有 `active` 就把 Overlay 往上挪。

> ### 🔑 `data-uia` 是唯一該依賴的選擇器介面
>
> 那些 `default-ltr-iqcdef-cache-fntwn3` 是 CSS-in-JS 產生的雜湊 class，
> **Netflix 每次改版重建都會變**，絕對不能依賴。
> `data-uia` 是 Netflix 自己的測試自動化屬性，是這個頁面上最穩定的識別面。
> 所有 DOM 選取一律用 `[data-uia="..."]`。

### 掛載點（實測存在）

`.watch-video` ✅　`.watch-video--player-view` ✅　`#appMountPoint` ✅　
`.VideoContainer` ❌（不存在）

## ❌ 已確認過期 / 錯誤的假設（原計畫書 v0.1）

| 原文件敘述 | 實際 |
|---|---|
| §6.3「hook `XMLHttpRequest`」取得字幕 | manifest 走 MSL 加密，網路層無明文。必須 hook `JSON.parse` |
| §6.3 字幕為 TTML/XML | 可透過 profile 注入取得 **WebVTT**，解析簡單一個數量級 |
| `timedtexttracks` 欄位 | 已改名 **`textTracks`** |
| `ttDownloadables` 欄位 | 已改名 **`downloadables`** |

## 🔲 驗證進度

- [x] ~~`downloadables['webvtt-lssdh-ios8']` 內的下載 URL 實際結構~~ 深掃 http 字串即可
- [x] ~~WebVTT 下載與解析~~ 已驗證，見上
- [x] ~~CC 與 subtitles 差異比例~~ 368 vs 260 句，差異顯著，選 CC
- [x] ~~`video.currentTime` 可否寫入跳秒~~ **不行**，被覆寫，須用 player API
- [x] ~~全螢幕掛載容器~~ `.watch-video` / `#appMountPoint`
- [x] ~~Netflix player 的 seek 方法~~ `pl.seek(ms)`，已驗證
- [x] ~~影集名 / 季 / 集數~~ `[data-uia="video-title"]`（在地化）+ `pl.getMovieId()`
- [x] ~~控制列顯隱~~ `[data-uia="player"]` 的 `active`/`inactive`
- [x] ~~movieId 與網址 id 比對~~ 改用 `pl.getMovieId()`，不必解析網址

**步驟 0 已全部完成。** 以下留待實作期間順帶驗證，非阻斷項：

- [ ] SPEAKER regex（`MAN:` 形式）在其他片源是否會誤殺（本片未觸發，
      目前是未驗證且有誤殺風險的程式碼，可考慮直接移除）
- [ ] `https://www.netflix.com/watch/{id}?t={sec}` 是否真能跳秒
      （已非必要 —— 同分頁回跳用 `pl.seek()` 即可）

## 實作提醒

**不猜欄位名。** 這次兩個關鍵欄位都改名了，靠記憶或網路教學寫死 selector
必然踩雷。adapter 應該用「深掃 + 結構比對」而不是硬編路徑，
並在找不到時給出明確錯誤，而不是靜默失敗。
