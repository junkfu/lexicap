import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // 預設是 .output —— 開頭的點會讓 macOS Finder 與 Chrome 的
  // 「載入未封裝項目」選取視窗把它當隱藏資料夾，選不到
  outDir: 'dist',
  manifest: {
    name: 'Lexicap',
    description: '一本會自動長大的看片筆記本',
    // 名稱與描述不得含 Netflix / YouTube（商標與 Chrome Web Store 政策）
    // 最小權限：alarms 曾經是為了 SW 定時富化而要的，富化改在清單頁做之後
    // 就用不到了。未使用的權限只會讓安裝時的權限提示變嚇人
    permissions: ['storage', 'unlimitedStorage'],
    action: { default_title: 'Lexicap — 打開筆記本' },
    // 只要 https。`*://` 會連明文 HTTP 一起涵蓋，那等於允許我們的
    // MAIN world hook 在可被中間人竄改的頁面上執行
    host_permissions: ['https://*.netflix.com/*'],
    // 句子翻譯依賴 Chrome 內建 Translator API（Chrome 138 起穩定）。不設下限的話，
    // 舊版瀏覽器的使用者裝了會以為功能壞掉 —— 商店會直接擋下不相容的瀏覽器
    minimum_chrome_version: '138',
  },
});
