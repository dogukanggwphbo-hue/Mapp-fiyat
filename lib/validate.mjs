// Doğrulama katmanı: uygulamaya giden hiçbir kayıt bu kapıdan geçmeden yayınlanmaz.

export const CHANNELS = ['mediamarkt', 'teknosa']; // Vatan: satıcı doğrulanamadığı için bilinçli olarak yok
const HOSTS = {
  mediamarkt: /^https:\/\/(www\.)?mediamarkt\.com\.tr\//,
  teknosa: /^https:\/\/(www\.)?teknosa\.com\//,
};
export const SELLER_CHECK = {
  mediamarkt: 'seller.type=retailer',
  teknosa: 'seller.is_teknosa=true',
};
export const CATS = ['phone', 'tablet', 'wearable', 'adapter'];

export function validateItem(it) {
  if (!it || typeof it !== 'object') return 'bos';
  if (!HOSTS[it.ch]) return 'kanal-gecersiz';
  if (it.verified !== true || it.sellerCheck !== SELLER_CHECK[it.ch]) return 'satici-dogrulanmamis';
  if (it.priceKind !== 'standard') return 'fiyat-turu';
  if (!(typeof it.price === 'number' && isFinite(it.price) && it.price >= 50 && it.price <= 2000000)) return 'fiyat-gecersiz';
  if (!HOSTS[it.ch].test(String(it.url || ''))) return 'url-gecersiz';
  if (!it.key || !it.label) return 'anahtar-yok';
  if (!CATS.includes(it.cat)) return 'kategori-gecersiz';
  if (!it.checkedAt || isNaN(Date.parse(it.checkedAt))) return 'tarih-yok';
  return null;
}

export function validateFeed(feed) {
  const problems = [];
  if (!feed || feed.schema !== 2) problems.push('şema');
  if (!feed || !Array.isArray(feed.items)) { problems.push('items yok'); return problems; }
  const seen = new Set();
  feed.items.forEach((it, i) => {
    const why = validateItem(it);
    if (why) problems.push(`kayıt ${i} (${it && it.ch}/${it && it.key}): ${why}`);
    const id = (it && it.ch) + '|' + (it && it.key);
    if (seen.has(id)) problems.push('yinelenen kayıt ' + id);
    seen.add(id);
  });
  return problems;
}
