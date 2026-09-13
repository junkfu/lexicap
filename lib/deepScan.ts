/**
 * 依 key 名稱深掃物件。
 *
 * 存在的理由：Netflix 的欄位名會改（`timedtexttracks`→`textTracks`、
 * `ttDownloadables`→`downloadables` 都已實際發生過）。寫死路徑必然過期，
 * 用結構比對找才耐改版。有深度上限與環狀保護。
 */
export function findByKey(root: unknown, key: string, maxDepth = 10): unknown[] {
  const out: unknown[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): void => {
    if (node == null || typeof node !== 'object' || depth > maxDepth) return;
    if (seen.has(node)) return;
    seen.add(node);

    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };

  walk(root, 0);
  return out;
}
