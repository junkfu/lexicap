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
    permissions: ['storage', 'unlimitedStorage', 'alarms'],
    action: { default_title: 'Lexicap — 打開筆記本' },
    host_permissions: ['*://*.netflix.com/*'],
  },
});
