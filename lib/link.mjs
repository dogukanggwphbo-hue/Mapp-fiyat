// Kanallar arası eşleştirme (ürün KODUNA değil, ürün ÖZELLİKLERİNE göre).
//
// Aynı ürün farklı mağazalarda farklı yazılır ("Watch9 44mm" / "Watch 9 44 mm", "12+256GB" / "12/256GB", "Gri" / "Gray").
// Her kayıttan şu "imza" çıkarılır:
//   telefon / tablet : marka(Samsung) + model + depolama + renk (+ 5G / LTE bilgisi; RAM biliniyorsa uyuşmalı)
//   akıllı saat      : model + boyut (mm) + renk (+ LTE)         kulaklık: model + renk
//   adaptör          : ürün kodu (EP-T2510N gibi) + renk
// İmzası birebir aynı olan ve FARKLI kanallardan gelen kayıtlar aynı ürün sayılır (EAN farklı da olsa).
// İLKE: yanlış eşleşme göstermektense eşleşmemeyi tercih et. Şu durumlarda hiç eşleştirme yapılmaz:
//   - imza için gerekli bilgi eksikse (ör. saatte boyut/renk yok)
//   - aynı kanalda aynı imzaya sahip birden fazla farklı ürün varsa
//   - RAM veya depolama çelişiyorsa
import { COLORS } from './normalize.mjs';

const tr = (s) => String(s == null ? '' : s).toLocaleLowerCase('tr-TR');
const fold = (s) => tr(s).replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');

// ---- renkler ----
const EN = { gray: 'gri', grey: 'gri', black: 'siyah', white: 'beyaz', silver: 'gumus', blue: 'mavi', green: 'yesil', pink: 'pembe', navy: 'lacivert', purple: 'mor', violet: 'mor', gold: 'altin', red: 'kirmizi', yellow: 'sari', orange: 'turuncu', cream: 'krem', lavender: 'lavanta', mint: 'nane', titanium: 'titanyum', graphite: 'grafit' };
const SUFFIX = { siyahi: 'siyah', mavisi: 'mavi', grisi: 'gri', moru: 'mor', yesili: 'yesil', pembesi: 'pembe', kirmizisi: 'kirmizi', turuncusu: 'turuncu', sarisi: 'sari', gumusu: 'gumus', beyazi: 'beyaz', altini: 'altin', lavantasi: 'lavanta', rengi: '' };
// Renk adlarını tamamlayan sözcükler (koyu gri, açık pembe, gök mavisi, kum rengi...). Model adı olamazlar.
const COLOR_EXTRA = ['koyu', 'acik', 'gok', 'buz', 'gece', 'mint', 'nane', 'kum', 'camel', 'rengi', 'yaban', 'mersini', 'murdum', 'mercan', 'seftali', 'safir', 'cam', 'su', 'okyanus', 'deniz', 'kobalt', 'titanyum', 'grafit', 'bakir', 'bronz', 'altin', 'krem', 'bej', 'lila', 'lavanta'];
const COLOR_WORDS = new Set(COLORS.flatMap((c) => fold(c).split(' ')).concat(Object.keys(EN), Object.keys(SUFFIX), COLOR_EXTRA));
const canonColor = (w) => (w in EN ? EN[w] : w in SUFFIX ? SUFFIX[w] : w);

// Model adında anlam taşımayan sözcükler
const DROP = new Set(['samsung', 'galaxy', 'akilli', 'telefon', 'telefonu', 'cep', 'tablet', 'tam', 'dokunmatik', 'saat', 'kulaklik', 'kulak', 'ici', 'kablosuz', 'kablolu', 'bluetooth', 'bt', 'wifi', 'wi', 'fi', 'android', 'ile', 've', 'gb', 'tb', 'ram', 'inc', 'inch', 'ghz', 'hizli', 'sarj', 'adaptoru', 'cihazi', 'aleti', 'type', 'c', 'typec', 'yeni', 'orijinal']);

function stripCodes(s) {
  // "TabletSM-X940..." gibi yapışık yazımlarda sözcük kodla birlikte silinmesin
  s = s.replace(/(tablet|telefonu|telefon|saat|kulaklik)(?=(?:sm|ep|eo|ee)-)/g, '$1 ');
  return s.replace(/[a-z]{0,2}sm-[a-z0-9]+/g, ' ').replace(/\b(?:ep|eo|ee)-[a-z0-9]+/g, ' ');
}

/** Metinden tam ürün kodlarını toplar: sm-a276bzkctur, ep-t2510nbegww ... */
function rawCodes(it) {
  const out = new Set();
  const txt = fold(`${it.name || ''} ${it.mpn || ''}`);
  for (const m of txt.matchAll(/(?:sm|ep|eo|ee)-[a-z0-9]{3,}/g)) out.add(m[0]);
  return out;
}

/** Kısa adaptör/kulaklık kodu: EP-T2510N (renk/bölge soneki atılır) */
function accCode(it) {
  const txt = fold(`${it.name || ''} ${it.mpn || ''}`);
  const m = txt.match(/\b((?:ep|eo|ee)-[a-z]{1,2}\d{3,4}[a-z]?)/);
  return m ? m[1] : null;
}

// ---- depolama / RAM / boyut temizliği ----
const STORAGE_PATTERNS = [
  /(?<![a-z\d.])\d{1,2}\s*(?:gb)?(?:\s*\/\s*|\+)(?:\d{2,4}\s*(?:gb|tb)?|\d{1,2}\s*tb)\b/g, // 8/256, 12+256GB, 16GB/1TB, 16/1 TB
  /\b\d{1,4}\s*(?:gb|tb)\b/g, // 128GB, 12Gb, 1 TB
  /\b\d+(?:[.,]\d+)?\s*ghz\b/g,
  /\b\d+(?:[.,]\d+)?\s*(?:''|"|”|’’|inc|inch)(?=[a-z\s]|$)/g, // ekran 14.6"
];

/**
 * Bir kaydın karşılaştırma özellikleri.
 * Dönüş: { model, color, size, storage, ram, g5, lte } (model/renk ayrıştırılamazsa boş string)
 */
export function features(it) {
  let s = fold(it.name || it.label || '');
  s = s.replace(/\bplus\b/g, '+').replace(/\bz\s+(fold|flip)/g, '$1');
  s = stripCodes(s);
  const g5 = /(^|[^a-z0-9])5g(?![a-z0-9])/.test(s);
  const lte = /(^|[^a-z0-9])(lte|4g|4\.5g|cellular)(?![a-z0-9])/.test(s);
  s = s.replace(/(^|[^a-z0-9])(5g|lte|4g|4\.5g|cellular)(?![a-z0-9])/g, '$1 ');
  let size = null;
  const mm = s.match(/(?<![a-z\d])(\d{2})\s*mm\b/) || s.match(/\bw(\d{2})\b/);
  if (mm) { size = mm[1]; s = s.replace(mm[0], ' '); }
  for (const re of STORAGE_PATTERNS) s = s.replace(re, ' ');
  s = s.replace(/[^a-z0-9+ ]+/g, ' ');
  const model = [];
  const color = [];
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (COLOR_WORDS.has(w)) { const c = canonColor(w); if (c) color.push(c); }
    else if (!DROP.has(w)) model.push(w);
  }
  return { model: model.join(''), color: color.join(' '), size, storage: it.storage || null, ram: it.ram == null ? null : it.ram, g5, lte };
}

function sigOf(it, eff) {
  const f = features(it);
  const code = accCode(it);
  if ((it.cat === 'adapter' || it.cat === 'wearable') && code) {
    const color = f.color || (eff && eff.get(code)) || 'yok';
    return { sig: ['K', it.cat, code, color].join('|') };
  }
  if (it.cat === 'phone' || it.cat === 'tablet') {
    if (!f.model || !f.color || !f.storage) return null;
    const conn = it.cat === 'tablet' ? `${f.g5 ? 5 : 0}${f.lte ? 'L' : 0}` : `${f.g5 ? 5 : 0}`;
    return { sig: ['P', it.cat, f.model, f.storage, f.color, conn].join('|') };
  }
  if (it.cat === 'wearable') {
    if (!f.model || !f.color) return null;
    const isWatch = /watch|ultra|fit|ring/.test(f.model);
    // Ultra serisinin tek boyutu var; diğer saatlerde boyut yoksa eşleştirilmez (40/44 mm karışmasın)
    const ultra = /ultra/.test(f.model);
    if (isWatch && !f.size && !ultra) return null;
    return { sig: ['W', f.model, f.size || (ultra ? 'u' : '-'), f.color, f.lte ? 'L' : 0].join('|') };
  }
  return null;
}

// Geriye dönük uyumluluk: model adı ve renk özeti
export function modelParts(label) {
  const f = features({ name: label, label });
  return { model: f.model, color: f.color };
}

/**
 * items'ı yerinde günceller; başka kayıtla aynı ürüne bağlanan (yeniden anahtarlanan) kayıt sayısını döndürür.
 * Kayıtların kendi kimliği (ownKey) korunur, bu yüzden fiyat geçmişi (önceki fiyat / ilk görülme) kaybolmaz.
 */
export function linkItems(items) {
  // 0) önceki turdan kalan bağları sıfırla
  for (const it of items) {
    if (it.ownKey) { it.key = it.ownKey; it.match = it.ean ? 'ean' : 'baslik'; }
    else if (it.match === 'model') it.match = it.ean ? 'ean' : 'baslik';
  }
  // adaptör kodu -> tek renk (başlıkta rengi olmayan kayıt, kodun tek rengi varsa onu alır)
  const colorsByCode = new Map();
  for (const it of items) {
    if (it.cat !== 'adapter' && it.cat !== 'wearable') continue;
    const code = accCode(it);
    if (!code) continue;
    const c = features(it).color;
    if (!colorsByCode.has(code)) colorsByCode.set(code, new Set());
    if (c) colorsByCode.get(code).add(c);
  }
  const eff = new Map([...colorsByCode].filter(([, set]) => set.size === 1).map(([k, set]) => [k, [...set][0]]));

  // 1) gruplar (mevcut anahtara göre) ve imzalar
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.key)) groups.set(it.key, { key: it.key, items: [], channels: new Set(), cat: it.cat, rams: new Set(), storages: new Set() });
    const g = groups.get(it.key);
    g.items.push(it); g.channels.add(it.ch);
    if (it.ram != null) g.rams.add(it.ram);
    if (it.storage) g.storages.add(it.storage);
  }
  const bySig = new Map(); // imza -> Set(key)
  const put = (sig, key) => { if (!bySig.has(sig)) bySig.set(sig, new Set()); bySig.get(sig).add(key); };
  for (const it of items) {
    const sg = sigOf(it, eff);
    if (sg) put(sg.sig, it.key);
    // uzun model kodu (>=12 karakter) tam eşitse ek bağ (kategori / RAM / depolama uyumu aşağıda doğrulanır)
    for (const c of rawCodes(it)) if (c.length >= 12) put('C|' + it.cat + '|' + c, it.key);
  }

  // 2) birleştirme: ayrık kanal kümeleri, RAM/depolama çelişkisi yok, kategori aynı
  const comp = new Map();
  for (const g of groups.values()) comp.set(g.key, { keys: new Set([g.key]), channels: new Set(g.channels), cat: g.cat, rams: new Set(g.rams), storages: new Set(g.storages) });

  const tryMerge = (comps) => {
    if (comps.length < 2) return;
    const ch = new Set();
    const rams = new Set();
    const sts = new Set();
    for (const c of comps) {
      if (c.cat !== comps[0].cat) return;
      for (const x of c.channels) { if (ch.has(x)) return; ch.add(x); } // aynı kanalda iki aday: belirsiz
      c.rams.forEach((r) => rams.add(r)); c.storages.forEach((r) => sts.add(r));
    }
    if (rams.size > 1 || sts.size > 1) return;
    const target = comps[0];
    for (const c of comps.slice(1)) {
      c.keys.forEach((k) => { target.keys.add(k); comp.set(k, target); });
      c.channels.forEach((x) => target.channels.add(x));
      c.rams.forEach((x) => target.rams.add(x));
      c.storages.forEach((x) => target.storages.add(x));
    }
  };

  for (const sig of [...bySig.keys()].sort()) {
    const keys = [...bySig.get(sig)];
    if (keys.length < 2) continue;
    const comps = [...new Set(keys.map((k) => comp.get(k)))];
    if (comps.length < 2) continue;
    // RAM'i bilinen adaylar RAM'e göre ayrı kümelenir; RAM'i bilinmeyen aday ancak tek RAM değeri varsa katılır
    const byRam = new Map();
    const wild = [];
    let bad = false;
    for (const c of comps) {
      if (c.rams.size > 1) bad = true;
      else if (c.rams.size === 1) { const r = [...c.rams][0]; if (!byRam.has(r)) byRam.set(r, []); byRam.get(r).push(c); }
      else wild.push(c);
    }
    if (bad) continue;
    if (byRam.size <= 1) { tryMerge(comps); continue; }
    for (const list of byRam.values()) tryMerge(list);
  }

  // 3) her bileşen için temsilci anahtar: en çok kanalı olan grup; eşitlikte barkodlu (EAN) ve küçük olan
  const isEan = (k) => /^\d{8,14}$/.test(k);
  let relinked = 0;
  const seen = new Set();
  for (const c of comp.values()) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (c.keys.size < 2) continue;
    const rep = [...c.keys].sort((a, b) => {
      const ga = groups.get(a);
      const gb = groups.get(b);
      return (gb.channels.size - ga.channels.size) || ((isEan(b) ? 1 : 0) - (isEan(a) ? 1 : 0)) || (a < b ? -1 : a > b ? 1 : 0);
    })[0];
    for (const k of c.keys) {
      if (k === rep) continue;
      for (const it of groups.get(k).items) {
        it.ownKey = it.ownKey || it.key; // kalıcı kimlik
        it.key = rep;
        it.match = 'model';
        relinked++;
      }
    }
  }
  return relinked;
}
