// Ortak normalleştirme: GTIN doğrulama, varyant (RAM/depolama/renk/W) ayrıştırma, kategori sınıflama, kayıt üretimi.
// Fiyat türleri ASLA karıştırılmaz: price (herkese açık güncel fiyat) ayrı; listPrice (üstü çizili), appPrice (uygulama),
// memberPrice (üyelik) ayrı alanlardır ve karşılaştırmaya katılmaz.

const tr = (s) => String(s == null ? '' : s).toLocaleLowerCase('tr-TR');
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function gtinOk(code) {
  const s = String(code == null ? '' : code).replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(s.length)) return false;
  const d = s.split('').map(Number);
  const chk = d.pop();
  let sum = 0;
  d.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === chk;
}

const COLORS = [
  'siyah', 'beyaz', 'gri', 'grafit gri', 'grafit', 'antrasit', 'gümüş', 'altın', 'bakır', 'bronz', 'krem', 'bej',
  'mavi', 'buz mavisi', 'buz mavi', 'açık mavi', 'gece mavisi', 'okyanus mavisi', 'deniz mavisi', 'lacivert',
  'mor', 'kobalt mor', 'lavanta', 'lavanta moru', 'lila', 'yaban mersini',
  'pembe', 'açık pembe', 'mercan', 'şeftali', 'kırmızı', 'turuncu', 'sarı',
  'yeşil', 'çam yeşili', 'su yeşili', 'nane yeşili', 'açık yeşil',
  'titanyum gri', 'titanyum siyah', 'titanyum gümüş', 'titanyum mavi', 'titanyum mor', 'safir',
].sort((a, b) => b.length - a.length);

export function parseVariant(title) {
  const t = String(title || '');
  let ram = null;
  let storage = null;
  const m = t.match(/(\d{1,2})\s*\/\s*(\d{2,4})\s*(GB|TB)?/i);
  if (m) {
    ram = Number(m[1]);
    storage = m[2] + (m[3] || 'GB').toUpperCase();
  } else {
    const r = t.match(/(\d{1,2})\s*GB\s*RAM/i);
    if (r) ram = Number(r[1]);
    const all = [...t.matchAll(/(\d{1,4})\s*(GB|TB)/gi)]
      .filter((x) => !(r && x.index === r.index))
      .map((x) => ({ s: x[1] + x[2].toUpperCase(), gb: Number(x[1]) * (x[2].toUpperCase() === 'TB' ? 1024 : 1) }))
      .sort((a, b) => b.gb - a.gb);
    if (all.length) storage = all[0].s;
  }
  const low = tr(t);
  let color = null;
  let best = -1;
  for (const c of COLORS) {
    const re = new RegExp('(^|[^a-zçğıöşü])' + escRe(c) + '(?![a-zçğıöşü])', 'g');
    let mm;
    let last = -1;
    while ((mm = re.exec(low))) last = mm.index + mm[1].length + c.length;
    if (last > best) { best = last; color = c; }
  }
  const w = t.match(/(\d{2,3})\s?W(?:att)?\b/i);
  return { ram, storage, color, watt: w ? Number(w[1]) : null };
}

// Kategori sınıflama: önce başlık (güçlü sinyal), sonra kategori yolu.
const RULES = [
  ['service', /kurulum|servis paket|garanti|sigorta|hasar koruma|destek paket/],
  ['adapter', /adapt[öo]r|şarj (cihaz|alet|adapt)|hızlı şarj|charger|power adapter/],
  ['accessory', /kılıf|kapak|koruyucu|aksesuar|kordon|kayış|tutucu|powerbank|power bank|kablo|stand\b|şarj istasyon/],
  ['wearable', /galaxy watch|akıllı saat|galaxy fit|akıllı bileklik|galaxy buds|kulaklık|galaxy ring|akıllı yüzük/],
  ['tablet', /\btablet\b|galaxy tab\b|tab [as]\d/],
  ['phone', /akıllı telefon|cep telefon|galaxy\s*z\s*(fold|flip)|galaxy\s*(s|a|m|f|xcover)\s?\d/],
];
function matchRule(text) {
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  return null;
}
export function classify(title, categoryText = '') {
  return matchRule(tr(title)) || matchRule(tr(categoryText)) || 'other';
}

export function cleanLabel(title, brand) {
  let s = String(title || '').replace(/\s+/g, ' ').trim();
  if (brand) s = s.replace(new RegExp('^' + escRe(brand) + '\\s+', 'i'), '');
  s = s.replace(/\s*(Akıllı Telefon|Cep Telefonu|Tam Dokunmatik Tablet|Akıllı Saat)\s*/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const slug = (s) => tr(s).replace(/[^a-z0-9çğıöşü+]+/g, '-').replace(/^-|-$/g, '');
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);

/**
 * Mağaza kolektörünün (kabul kuralını geçmiş) alanlarından feed kaydı üretir.
 * f: {ch,id,title,brand,url,ean,mpn,price,listPrice,appPrice,memberPrice,inStock,sellerCheck,sellerName,categoryText}
 */
export function buildItem(f, nowIso) {
  const v = parseVariant(f.title);
  const cat = classify(f.title, f.categoryText);
  const label = cleanLabel(f.title, f.brand);
  const ean = gtinOk(f.ean) ? String(f.ean).replace(/\D/g, '') : null;
  const price = num(f.price);
  let listPrice = num(f.listPrice);
  if (listPrice != null && price != null && listPrice <= price) listPrice = null; // anlamsız üstü çizili fiyat
  return {
    ch: f.ch,
    key: ean || 'm:' + slug(label),
    match: ean ? 'ean' : 'baslik',
    cat,
    label,
    name: f.title,
    price,
    priceKind: 'standard',
    listPrice,
    appPrice: num(f.appPrice),
    memberPrice: num(f.memberPrice),
    url: f.url,
    productId: f.id == null ? null : String(f.id),
    ean,
    mpn: f.mpn || null,
    ram: v.ram,
    storage: v.storage,
    color: v.color,
    watt: v.watt,
    inStock: f.inStock === undefined ? null : f.inStock,
    verified: true,
    sellerCheck: f.sellerCheck,
    sellerName: f.sellerName || null,
    variants: 1,
    checkedAt: nowIso,
    since: nowIso,
    prev: null,
    prevAt: null,
    flag: null,
  };
}
