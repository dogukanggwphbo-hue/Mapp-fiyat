// Teknosa toplayıcı. Kabul kuralı: seller.is_teknosa === true (marketplace mağazaları kesinlikle alınmaz).
// İstek ayrıca seller=teknosa ve Samsung marka kodu ile daraltılır; kural yine de her satırda tekrar doğrulanır.
import { buildItem, classify, isWebExclusive, USED_RE } from '../lib/normalize.mjs';
import { validateItem, SELLER_CHECK } from '../lib/validate.mjs';
import { BudgetError, ReefError, isEmptyResult, isFatal } from '../lib/reef.mjs';

export const STORE = 'teknosa';

export function accept(row) {
  if (!row || !row.seller) return 'satici-bilgisi-yok';
  if (row.seller.is_teknosa !== true) return 'pazaryeri-satici';
  if (row.seller.name && !/teknosa/i.test(row.seller.name)) return 'satici-adi-uyusmuyor';
  if (!/^samsung$/i.test(String(row.brand || '').trim())) return 'marka-samsung-degil';
  if (USED_RE.test(String(row.title || ''))) return 'outlet-ikinci-el';
  if (!(typeof row.price === 'number' && row.price > 0)) return 'fiyat-yok';
  if (!row.url || !/^https:\/\/(www\.)?teknosa\.com\//.test(row.url)) return 'url-gecersiz';
  return null;
}

export function toFields(row) {
  return {
    ch: STORE,
    id: row.product_id,
    title: row.title,
    brand: row.brand,
    url: row.url,
    ean: row.barcode,
    mpn: row.mpn,
    price: row.price,
    listPrice: row.was_price,
    appPrice: null,
    memberPrice: row.member_price, // TeknoClub üye fiyatı: ayrı alan, karşılaştırmaya girmez
    cartPrice: null,
    webExclusive: isWebExclusive(row.badges),
    inStock: row.in_stock === true ? true : null,
    sellerCheck: SELLER_CHECK[STORE],
    sellerName: row.seller.name,
    categoryText: [row.category].concat(row.category_path || []).join(' '),
  };
}

const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

export async function collect({ client, cfg, scope, now }) {
  const nowIso = now.toISOString();
  const stats = { pages: 0, rows: 0, accepted: 0, rejected: {}, credits: 0, empty: [] };
  const start = client.spent;
  const items = new Map();
  let error = null;
  let useBrand = !!cfg.brandCode;
  outer:
  for (const q of cfg.queries) {
    if (!scope.includes(q.scope)) continue;
    for (let page = 1; page <= q.maxPages; page++) {
      const params = { seller: cfg.seller, page };
      if (q.category) params.category = q.category; else params.query = q.q;
      if (useBrand) params.brand = cfg.brandCode;
      let r;
      try {
        r = await client.call('teknosa', 'search', params, { cost: cfg.creditsPerCall });
      } catch (e) {
        // Marka kodu reddedilirse bir kez markasız dene (marka yine satır bazında doğrulanır)
        if (useBrand && e instanceof ReefError && (e.status === 400 || e.status === 422)) { useBrand = false; page--; continue; }
        if (isEmptyResult(e)) { stats.empty.push(q.q || q.category); break; } // bu aramada ürün yok: sonraki aramaya geç
        if (isFatal(e)) { error = e; break outer; } // kredi/yetki: tüm turu durdur
        error = error || e; break; // başka hata: bu aramayı bırak, diğerlerine devam et (durum 'partial')
      }
      const d = r.data || {};
      const rows = Array.isArray(d.results) ? d.results : [];
      stats.pages++; stats.rows += rows.length;
      let wanted = 0;
      let relevant = 0; // satıcı fark etmeksizin BU aramanın kategorisindeki Samsung ürünleri: sayfalamayı bitirme ölçütü
      for (const row of rows) {
        if (classify(row.title, [row.category].concat(row.category_path || []).join(' ')) === q.scope && /^samsung$/i.test(String(row.brand || '').trim())) relevant++;
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
