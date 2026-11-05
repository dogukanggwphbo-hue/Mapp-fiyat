// MediaMarkt TR toplayıcı. Kabul kuralı: seller.type === 'retailer' (pazaryeri satıcıları kesinlikle alınmaz).
import { buildItem, classify, isWebExclusive } from '../lib/normalize.mjs';
import { validateItem, SELLER_CHECK } from '../lib/validate.mjs';
import { BudgetError } from '../lib/reef.mjs';

export const STORE = 'mediamarkt';

/**
 * Normal (raf) fiyatı ile sepette indirimli fiyatı ayırır. "Sepette indirim" rozetli üründe API'nin price alanı
 * indirimli çıkabilir (ör. 38.999 TL → 37.049,05 TL); taksit toplamı (installment.total_amount) raf fiyatını verir.
 * Raf fiyatı güvenle belirlenemezse ürün alınmaz (yanlış fiyat göstermemek için).
 * @returns {{price:number|null, cartPrice:number|null, reject:string|null}}
 */
export function shelfPrice(row) {
  const price = row && row.price;
  if (!(typeof price === 'number' && price > 0)) return { price: null, cartPrice: null, reject: 'fiyat-yok' };
  const cartBadge = Array.isArray(row.badges) && row.badges.some((b) => /sepette/i.test(String(b)));
  if (!cartBadge) return { price, cartPrice: null, reject: null };
  const total = row.installment && row.installment.total_amount;
  if (typeof total === 'number' && total > 0) {
    if (total <= price) return { price, cartPrice: null, reject: null }; // fiyat zaten raf fiyatı
    if (price / total >= 0.5) return { price: total, cartPrice: price, reject: null }; // raf = taksit toplamı
  }
  return { price: null, cartPrice: null, reject: 'sepet-fiyati-belirsiz' };
}

/** Satırı kabul eder (null) ya da red nedenini döndürür. */
export function accept(row) {
  if (!row || !row.seller) return 'satici-bilgisi-yok';
  if (row.seller.type !== 'retailer') return 'pazaryeri-satici';
  if (row.seller.name && !/media\s*markt/i.test(row.seller.name)) return 'satici-adi-uyusmuyor';
  if (!/^samsung$/i.test(String(row.brand || '').trim())) return 'marka-samsung-degil';
  if (row.refurbished === true) return 'yenilenmis';
  const sp = shelfPrice(row);
  if (sp.reject) return sp.reject;
  if (!row.url || !/^https:\/\/(www\.)?mediamarkt\.com\.tr\//.test(row.url)) return 'url-gecersiz';
  return null;
}

export function toFields(row) {
  const av = row.availability;
  const sp = shelfPrice(row);
  return {
    ch: STORE,
    id: row.product_id,
    title: row.title,
    brand: row.brand,
    url: row.url,
    ean: row.ean,
    mpn: null,
    price: sp.price,
    listPrice: row.was_price,
    appPrice: row.app_price,
    memberPrice: row.member_price,
    cartPrice: sp.cartPrice,
    webExclusive: isWebExclusive(row.badges),
    inStock: av ? (av.buyable_online === false ? false : true) : null,
    sellerCheck: SELLER_CHECK[STORE],
    sellerName: row.seller.name,
    categoryText: [row.category].concat(row.breadcrumb || []).join(' '),
  };
}

const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

export async function collect({ client, cfg, scope, now }) {
  const nowIso = now.toISOString();
  const stats = { pages: 0, rows: 0, accepted: 0, rejected: {}, credits: 0 };
  const start = client.spent;
  const items = new Map();
  let error = null;
  outer:
  for (const q of cfg.queries) {
    if (!scope.includes(q.scope)) continue;
    for (let page = 1; page <= q.maxPages; page++) {
      let r;
      try {
        r = await client.call('mediamarkt', 'search', { query: q.q, country: cfg.country, brand: cfg.brand, page }, { cost: cfg.creditsPerCall });
      } catch (e) { error = e; break outer; }
      const d = r.data || {};
      const rows = Array.isArray(d.results) ? d.results : [];
      stats.pages++; stats.rows += rows.length;
      let wanted = 0;
      let relevant = 0; // satıcı fark etmeksizin kapsamdaki Samsung ürünleri: sayfalamayı bitirme ölçütü
      for (const row of rows) {
        if (scope.includes(classify(row.title, [row.category].concat(row.breadcrumb || []).join(' '))) && /^samsung$/i.test(String(row.brand || '').trim())) relevant++;
        const why = accept(row);
        if (why) { bump(stats.rejected, why); continue; }
        const it = buildItem(toFields(row), nowIso);
        if (!scope.includes(it.cat)) { bump(stats.rejected, 'kategori:' + it.cat); continue; }
        const bad = validateItem(it);
        if (bad) { bump(stats.rejected, 'dogrulama:' + bad); continue; }
        wanted++;
        if (items.has(it.key)) { bump(stats.rejected, 'yinelenen'); continue; }
        items.set(it.key, it);
        stats.accepted++;
      }
      const last = Number(d.max_page || d.page_count || 1);
      if (page >= q.maxPages && page < last && relevant) stats.capped = true;
      if (!rows.length || page >= last || !relevant) break; // sonuçlar bitti ya da ilgili ürün kalmadı
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
    note: stats.capped ? 'Sayfa sınırına ulaşıldı; bazı ürünler eksik olabilir (config.json > maxPages).' : null,
    budgetStop: error instanceof BudgetError,
  };
}
