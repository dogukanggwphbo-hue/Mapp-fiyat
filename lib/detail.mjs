// Ürün detayı kontrolü (--detail): seçilen Teknosa ürün kodları için ReefAPI product/detail çağrılır; "sayfa kimin teklifini gösteriyor?" sorusunu yanıtlar.
// Veri yazmaz, durum dosyasına dokunmaz. Ürün başına en çok 2 kredi: (1) varsayılan görünüm (buy-box satıcısı), (2) seller_id=teknosa (Teknosa'nın kendi teklifi).
import { ReefError } from './reef.mjs';

export const parseIds = (s) => [...new Set(String(s == null ? '' : s).split(/[\s,;]+/).filter((x) => /^\d{6,15}$/.test(x)))].slice(0, 8);

const tl = (n) => (typeof n === 'number' ? n.toLocaleString('tr-TR') + ' TL' : '-');
const who = (s) => (s ? `${s.name || '?'} [shop_id=${s.shop_id == null ? '-' : s.shop_id}, is_teknosa=${s.is_teknosa === true}]` : '-');

/** Bir product/detail yanıtından okunur satırlar üretir (saf işlev). */
export function describe(p, head) {
  if (!p) return [`${head}: ürün kaydı yok`];
  const L = [`${head}: ${p.title || '?'} · fiyat ${tl(p.price)}${p.was_price ? ` (üstü çizili ${tl(p.was_price)})` : ''}${p.member_price ? ` · TeknoClub ${tl(p.member_price)}` : ''}`];
  L.push(`   buy-box satıcı: ${who(p.seller)} · stok/uygunluk: ${p.availability == null ? '-' : p.availability} / ${p.teknosa_stock_label == null ? '-' : p.teknosa_stock_label} · adres: ${p.url || '-'}`);
  const oo = Array.isArray(p.other_offers) ? p.other_offers : [];
  L.push(`   diğer satıcı teklifi: ${oo.length}`);
  for (const o of oo.slice(0, 8)) L.push(`   - ${who(o.seller)} · ${tl(o.price)} · seller_id_param=${o.seller_id_param == null ? '-' : o.seller_id_param}`);
  return L;
}

export async function detailCheck({ client, ids, log = console.log }) {
  const out = [];
  for (const id of ids) {
    log(`--- ${id} ---`);
    const rec = { id, buybox: null, own: null };
    for (const [key, params, head] of [['buybox', { product_id: id }, 'Varsayılan görünüm'], ['own', { product_id: id, seller_id: 'teknosa' }, 'Teknosa teklifi (seller_id=teknosa)']]) {
      try {
        const r = await client.call('teknosa', 'product/detail', params, { cost: 1 });
        const p = (r && r.data && r.data.product) || null;
        rec[key] = p;
        describe(p, head).forEach((l) => log(l));
      } catch (e) {
        log(`${head}: HATA ${e instanceof ReefError ? `HTTP ${e.status} ` : ''}${String(e && e.message ? e.message : e).slice(0, 200)}`);
        if (e instanceof ReefError && e.keyProblem) { log('Anahtar sorunu; kontrol durduruldu.'); return out; }
      }
    }
    out.push(rec);
  }
  return out;
}
