# 隱私權政策 / Privacy Policy

**Lexicap**
最後更新：2026-09-14 · Last updated: 2026-09-14

---

## 中文

### 一句話版本

Lexicap 不收集、不傳送、不販售任何個人資料。你擷取的所有內容都只存在你自己電腦的瀏覽器裡。

### 我們儲存什麼

擴充功能會在你主動操作（點選字幕上的單字、按下 `S` 或 `A`）時，將以下內容寫入瀏覽器本機的 IndexedDB：

- 你點選的單字，或整句台詞
- 該句的前後文
- 影片中的時間點（用於一鍵回跳）
- 影片的識別碼與標題
- 事後自動產生的中文解釋或翻譯

這些資料**完全保存在本機**，不會上傳到任何伺服器。我們沒有伺服器，也沒有帳號系統。

### 我們不做什麼

- 不收集你的身分、email、位置或任何可識別個人的資訊
- 不做任何形式的分析、追蹤、埋點或廣告
- 不讀取你在 Netflix 的帳號、觀看紀錄或付款資訊
- 不會把你的資料傳送給第三方，也不會販售

### 對外的網路連線

擴充功能本身不會把你的資料送到任何地方。執行過程中只有兩類網路行為：

1. **讀取字幕檔** —— 向 Netflix 自己的字幕網址請求該集的英文字幕（WebVTT）。這與你播放影片時瀏覽器本來就會做的請求相同，且僅發生在 `netflix.com` 網域內。
2. **Chrome 內建翻譯的語言包下載** —— 句子翻譯使用 Chrome 瀏覽器內建的 Translator API。首次使用時 Chrome 會下載離線語言模型，該下載由 Chrome 執行，其資料處理適用 Google 的隱私權政策。**下載完成後翻譯在你的裝置上離線執行，句子內容不會離開你的電腦。**

單字解釋查詢的是隨擴充功能一起打包的離線英漢詞典，完全不需連網。

### 權限用途

| 權限 | 用途 |
|---|---|
| `storage` | 儲存你的使用偏好與擷取狀態於本機 |
| `unlimitedStorage` | 筆記與離線詞典存放於 IndexedDB，可能超過預設容量上限 |
| `netflix.com` 網域存取 | 繪製字幕 Overlay、讀取字幕軌。功能僅在此網域運作，其他網站完全休眠 |

### 你的控制權

- 每一筆筆記都可以在清單頁單獨刪除
- 匯出 Markdown / CSV 會直接產生本機檔案，不經過任何伺服器
- 移除擴充功能時，Chrome 會一併刪除所有本機資料

### 聯絡方式

問題或疑慮請開 issue：<https://github.com/junkfu/lexicap/issues>

---

## English

### In one sentence

Lexicap collects no personal data, transmits nothing, and sells nothing. Everything you capture stays in your own browser.

### What is stored

When you take an explicit action (clicking a word in the subtitles, or pressing `S` / `A`), the extension writes the following to IndexedDB on your own machine:

- The word you clicked, or the full subtitle line
- The surrounding lines for context
- The timestamp within the video (used to jump back)
- The video's identifier and title
- A Chinese definition or translation generated afterwards

This data stays **entirely on your device**. There is no server and no account system.

### What we do not do

- We do not collect your identity, email, location, or any personally identifiable information
- We perform no analytics, telemetry, tracking, or advertising
- We do not read your Netflix account, viewing history, or payment information
- We do not share or sell your data to anyone

### Network activity

The extension never sends your data anywhere. Only two kinds of network activity occur:

1. **Fetching the subtitle file** — a request to Netflix's own subtitle URL for the English WebVTT track of the episode you are watching. This is the same request the page already makes, and it happens only within the `netflix.com` origin.
2. **Chrome's built-in translation language pack** — sentence translation uses Chrome's built-in Translator API. On first use Chrome downloads an on-device language model; that download is performed by Chrome and is governed by Google's privacy policy. **After the download, translation runs locally on your device and sentence content never leaves your computer.**

Word definitions are looked up in an offline English–Chinese dictionary bundled with the extension, requiring no network access at all.

### Permissions

| Permission | Why it is needed |
|---|---|
| `storage` | Persists your preferences and capture state locally |
| `unlimitedStorage` | Notes and the offline dictionary live in IndexedDB and may exceed the default quota |
| Access to `netflix.com` | Renders the subtitle overlay and reads the subtitle track. The extension is dormant on every other site |

### Your control

- Every note can be deleted individually from the notebook page
- Markdown / CSV export writes a local file directly; no server is involved
- Uninstalling the extension causes Chrome to delete all local data

### Contact

Please open an issue: <https://github.com/junkfu/lexicap/issues>
