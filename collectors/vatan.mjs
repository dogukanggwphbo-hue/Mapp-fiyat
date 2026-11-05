// Vatan Bilgisayar toplayıcı.
// Vatan'da pazaryeri/üçüncü taraf satıcı yoktur (siteyi Vatan kendi satışı olarak işletir; ReefAPI Vatan yanıtında satıcı alanı da
// sunmaz, MediaMarkt/Teknosa'dan farklı olarak). Bu yüzden satıcı alanı aranmaz; bunun yerine şu güvenceler uygulanır:
//   - adres vatanbilgisayar.com olmalı, Samsung markası (istek filtresi + başlık) ve stokta (in_stock_only) olmalı
//   - outlet / ikinci el / yenilenmiş / teşhir ürünler alınmaz
//   - normal fiyat (price) ile "Sepette" fiyatı (basket_price) karışmaz: sepette fiyatı ayrı alandır
//   - "Web'e Özel" fiyatı price içinde gelir; etiketlenir, normal fiyat regular_price olarak saklanır
// Vatan ürünlerinde EAN yoktur: kayıt kimliği ürün kodu (MPN); kanallar arası eşleştirme lib/link.mjs'de yapılır.
import { buildItem, classify, USED_RE } from '../lib/normalize.mjs';
import { validateItem, SELLER_CHECK } from '../lib/validate.mjs';
import { BudgetError, isEmptyResult, isFatal } from '../lib/reef.mjs';

export const STORE = 'vatan';
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function accept(row) {
  if (!row) return 'bos';
  if (!/^samsung\b/i.test(String(row.title || '').trim())) return 'marka-samsung-degil';
  if (row.is_outlet === true || USED_RE.test(String(row.title || ''))) return 'outlet-ikinci-el';
  if (!(typeof row.price === 'number' && row.price > 0)) return 'fiyat-yok';
  if (!row.url || !/^https:\/\/(www\.)?vatanbilgisayar\.com\//.test(row.url)) return 'url-gecersiz';
  if (!row.product_code && !row.slug) return 'kimlik-yok';
  return null;
}

export function toFields(row) {
  const webEx = /web.{0,3}e?\s*özel/i.test(String(row.price_label || '')) || !!row.web_exclusive_badge;
  return {
    ch: STORE,
    id: row.product_code || row.slug,
    ownKey: 'v:' + slug(row.product_code || row.slug),
    title: row.title,
    brand: 'Samsung',
    url: row.url,
    ean: null,
    mpn: row.product_code || null,
    price: row.price,
    listPrice: row.regular_price || row.was_price,
    appPrice: null,
    memberPrice: null,
    cartPrice: row.basket_price,
    cartLabel: row.basket_price ? (row.basket_price_label || null) : null,
    webExclusive: webEx,
    inStock: true, // yalnızca stoktakiler istenir (in_stock_only)
    sellerCheck: SELLER_CHECK[STORE],
    sellerName: 'Vatan Bilgisayar',
    categoryText: '',
  };
}

const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

export async function collect({ client, cfg, scope, now }) {
  const nowIso = now.toISOString();
  const stats = { pages: 0, rows: 0, accepted: 0, rejected: {}, credits: 0, empty: [] };
  const start = client.spent;
  const items = new Map();
  let error = null;
  outer:
  for (const q of cfg.queries) {
    if (!scope.includes(q.scope)) continue;
    for (let page = 1; page <= q.maxPages; page++) {
      const params = { query: q.q, brand: cfg.brand, page };
      if (cfg.inStockOnly) params.in_stock_only = true;
      let r;
      try { r = await client.call('vatan', 'search', params, { cost: cfg.creditsPerCall }); }
      catch (e) {
        if (isEmptyResult(e)) { stats.empty.push(q.q); break; }
        if (isFatal(e)) { error = e; break outer; }
        error = error || e; break;
      }
      const d = r.data || {};
      const rows = Array.isArray(d.results) ? d.results : [];
      stats.pages++; stats.rows += rows.length;
      let relevant = 0;
      for (const row of rows) {
        if (/^samsung\b/i.test(String(row.title || '')) && classify(row.title, '') === q.scope) relevant++;
        const why = accept(row);
        if (why) { bump(stats.rejected, why); continue; }
        const it = buildItem(toFields(row), nowIso);
        if (!scope.includes(it.cat)) { bump(stats.rejected, 'kategori:' + it.cat); continue; }
        const bad = validateItem(it);
        if (bad) { bump(stats.rejected, 'dogrulama:' + bad); continue; }
        if (items.has(it.ownKey)) { bump(stats.rejected, 'yinelenen'); continue; }
        items.set(it.ownKey, it);
        stats.accepted++;
      }
      const last = Number(d.total_pages || 1);
      if (page >= q.maxPages && page < last && relevant) stats.capped = true;
      if (!rows.length || page >= last || !relevant) break;
    }
  }
  stats.credits = client.spent - start;
  let status = 'ok';
  if (error) status = items.size ? 'partial' : 'error';
  else if (!items.size) status = 'error';
  return {
    store: STORE,
    status,
    items: [...items.values()],
    stats,
    error: error ? String(error.message || error) : (!items.size ? 'Hiç ürün doğrulanamadı (site/API yapısı değişmiş olabilir).' : null),
    note: [stats.capped ? 'Sayfa sınırına ulaşıldı; bazı ürünler eksik olabilir (config.json > maxPages).' : null, stats.empty.length ? 'Sonuç dönmeyen aramalar: ' + stats.empty.join(', ') : null].filter(Boolean).join(' · ') || null,
    budgetStop: error instanceof BudgetError,
  };
}
