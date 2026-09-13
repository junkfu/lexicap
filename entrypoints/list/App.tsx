import { useEffect, useMemo, useState } from 'react';
import type { Capture } from '@/lib/types';
import { clock, toCsv, toMarkdown, download } from '@/lib/export';
import { BuiltinEnricher } from '@/lib/enrich/builtin';
import type { Enrichment } from '@/lib/enrich/types';

type EnrichUI =
  | { kind: 'idle' }
  | { kind: 'unsupported'; reason: string }
  /** Chrome 規定：availability 為 downloadable/downloading 時，下載必須由使用者手勢觸發 */
  | { kind: 'needs-gesture' }
  | { kind: 'downloading'; ratio: number }
  | { kind: 'working'; done: number; total: number };

export function App() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [enrichUI, setEnrichUI] = useState<EnrichUI>({ kind: 'idle' });

  useEffect(() => {
    void (async () => {
      const all = await reload();
      if (!all.some((c) => c.enrichStatus === 'raw')) return;

      // 直接跑 —— 單字查的是打包進來的離線詞典，不需要任何前置條件。
      // 只有句子翻譯會卡在語言包下載，那個在 runEnrichment 之後才處理
      await runEnrichment();
    })();
  }, []);

  async function reload(): Promise<Capture[]> {
    const all = (await browser.runtime.sendMessage({ type: 'lexicap:list' })) as Capture[];
    setCaptures(all);
    setLoading(false);
    return all;
  }

  /** 從按鈕呼叫時，整條路徑都在使用者手勢的有效期內 */
  async function runEnrichment() {
    const all = (await browser.runtime.sendMessage({ type: 'lexicap:list' })) as Capture[];
    const pending = all.filter((c) => c.enrichStatus === 'raw');
    if (pending.length === 0) return setEnrichUI({ kind: 'idle' });

    const enricher = new BuiltinEnricher();
    try {
      await enricher.prepare((ratio) => setEnrichUI({ kind: 'downloading', ratio }));
    } catch (error) {
      return setEnrichUI({ kind: 'unsupported', reason: (error as Error).message });
    }

    // 同一部影片的擷取放同一批 —— 模型看得到劇情連續性，語境詞義品質明顯較好
    const ordered = [...pending].sort((a, b) => a.videoId.localeCompare(b.videoId));

    const CHUNK = 10;
    for (let i = 0; i < ordered.length; i += CHUNK) {
      const batch = ordered.slice(i, i + CHUNK);
      setEnrichUI({ kind: 'working', done: i, total: ordered.length });

      let enrichments: Enrichment[] = [];
      try {
        enrichments = await enricher.enrich(batch);
      } catch (error) {
        // 整批失敗（Ollama 沒開、key 錯、額度用完）就停下來報錯，
        // 這批留在 raw 下次再試 —— 不要標成 failed 讓它永遠不再重試
        return setEnrichUI({ kind: 'unsupported', reason: (error as Error).message });
      }

      const succeeded = new Set(enrichments.map((e) => e.id));
      await browser.runtime.sendMessage({
        type: 'lexicap:enriched',
        enrichments,
        failedIds: batch.filter((c) => !succeeded.has(c.id)).map((c) => c.id),
      });
      await reload();
    }

    // 詞典查不到的字與整句擷取需要 Chrome 內建翻譯，而語言包還沒下載時，
    // Chrome 規定下載必須由使用者手勢觸發 —— 那些會留在待翻譯狀態
    const left = (await browser.runtime.sendMessage({ type: 'lexicap:list' })) as Capture[];
    if (enricher instanceof BuiltinEnricher && left.some((c) => c.enrichStatus === 'raw')) {
      const diagnosis = await enricher.diagnoseTranslator();
      console.log('[lexicap] 內建翻譯診斷：', diagnosis);
      return diagnosis.ok
        ? setEnrichUI({ kind: 'needs-gesture' })
        : setEnrichUI({ kind: 'unsupported', reason: diagnosis.reason });
    }

    setEnrichUI({ kind: 'idle' });
  }

  /** 富化邏輯改善後，把舊資料重跑一次 */
  async function retranslate() {
    await browser.runtime.sendMessage({ type: 'lexicap:reset-enrichment' });
    await reload();
    await runEnrichment();
  }

  async function remove(id: string) {
    await browser.runtime.sendMessage({ type: 'lexicap:delete', id });
    setCaptures((prev) => prev.filter((c) => c.id !== id));
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return captures;
    return captures.filter((c) =>
      [c.text, c.word, c.translation, c.wordMeaning, c.videoTitle, c.note].some((v) =>
        v?.toLowerCase().includes(q),
      ),
    );
  }, [captures, query]);

  const groups = useMemo(() => {
    const map = new Map<string, Capture[]>();
    for (const c of filtered) {
      const key = c.videoTitle || c.videoId;
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    // 新擷取的排最上面。
    // （原本是依影片時間排，翻閱時跟著劇情走；但「剛存的馬上看得到」
    //   在使用當下更重要，剛存完卻要在中間找它很不直覺。）
    for (const list of map.values()) list.sort((a, b) => b.capturedAt - a.capturedAt);
    return [...map.entries()];
  }, [filtered]);

  return (
    <main>
      <header>
        <h1>Lexicap</h1>
        <input
          type="search"
          placeholder="搜尋句子、單字、影片…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="actions">
          <span className="count">{filtered.length} 筆</span>
          <EnrichStatus state={enrichUI} onStart={() => void runEnrichment()} />
          <button onClick={() => download('lexicap.md', toMarkdown(filtered), 'text/markdown')}>
            Markdown
          </button>
          <button onClick={() => download('lexicap.csv', toCsv(filtered), 'text/csv')}>CSV</button>
          <button onClick={() => void retranslate()} title="換了富化引擎後，用它把已存的資料重跑一次">
            重新翻譯
          </button>

        </div>
      </header>

      {loading ? (
        <p className="empty">載入中…</p>
      ) : groups.length === 0 ? (
        <p className="empty">
          {captures.length === 0
            ? '還沒有任何擷取。看片時點單字，或按 S 存當前句、A 存上一句。'
            : '沒有符合的結果。'}
        </p>
      ) : (
        groups.map(([videoTitle, list]) => (
          <section key={videoTitle}>
            <h2>
              {videoTitle} <span className="count">{list.length}</span>
            </h2>
            {list.map((capture) => (
              <Row key={capture.id} capture={capture} onDelete={() => remove(capture.id)} />
            ))}
          </section>
        ))
      )}
    </main>
  );
}

function EnrichStatus({ state, onStart }: { state: EnrichUI; onStart: () => void }) {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'needs-gesture':
      // Chrome 不允許自動開始下載模型，必須由使用者觸發
      return (
        <button className="primary" onClick={onStart}>
          下載語言包以翻譯整句
        </button>
      );
    case 'downloading':
      return <em className="badge">下載語言包 {Math.round(state.ratio * 100)}%</em>;
    case 'working':
      return (
        <em className="badge">
          翻譯中 {state.done}/{state.total}
        </em>
      );
    case 'unsupported':
      return <em className="badge warn">無法翻譯：{state.reason}</em>;
  }
}

function Row({ capture, onDelete }: { capture: Capture; onDelete: () => void }) {
  return (
    <article>
      <button className="jump" onClick={() => jumpTo(capture)} title="回到影片的這一秒">
        ▶ {clock(capture.startTime)}
      </button>

      <div className="body">
        {/* 單字擷取只顯示那個字，不顯示原句 */}
        <p className="text">{capture.word ?? capture.text}</p>

        {capture.wordMeaning && (
          <p className="translation">
            {capture.pos && <em className="pos">{capture.pos} </em>}
            {capture.wordMeaning}
          </p>
        )}

        {/*
          * 單字擷取只顯示該字的詞義，不顯示整句中譯。
          * 句子仍然存著 —— 它是 LLM 富化的語境來源，也會出現在匯出的筆記裡，
          * 只是不佔清單頁的版面。
          */}
        {!capture.word && capture.translation && (
          <p className="translation">{capture.translation}</p>
        )}
        {!capture.translation && !capture.wordMeaning && (
          <p className="pending">{capture.enrichStatus === 'failed' ? '翻譯失敗' : '尚未翻譯'}</p>
        )}
      </div>

      <a
        className="external"
        href={googleTranslateUrl(capture.word ?? capture.text)}
        target="_blank"
        rel="noreferrer"
        title="用 Google 翻譯查這一則"
      >
        譯
      </a>

      <button className="remove" onClick={onDelete} title="刪除">
        ×
      </button>
    </article>
  );
}

/**
 * 送到 Google 翻譯。
 *
 * 對單一個字特別有用 —— Google 翻譯會列出多個詞義與詞性，
 * 而內建 Translator 只能硬選一個意思（所以會出現 so → 便）。
 */
function googleTranslateUrl(text: string): string {
  const params = new URLSearchParams({ sl: 'en', tl: 'zh-TW', op: 'translate', text });
  return `https://translate.google.com/?${params}`;
}

/**
 * 回跳。優先讓已經開著該影片的分頁直接 seek —— 開新分頁要重新緩衝，
 * 而且會失去當前的觀看位置。
 */
async function jumpTo(capture: Capture) {
  const tabs = await browser.tabs.query({ url: `*://*.netflix.com/watch/${capture.videoId}*` });
  const tab = tabs[0];

  if (tab?.id) {
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId!, { focused: true });
    await browser.tabs.sendMessage(tab.id, { type: 'lexicap:seek', seconds: capture.startTime });
    return;
  }

  await browser.tabs.create({ url: `https://www.netflix.com/watch/${capture.videoId}` });
}
