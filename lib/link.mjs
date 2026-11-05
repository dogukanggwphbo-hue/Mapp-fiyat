// Kanallar arası eşleştirme: barkodu (EAN) olmayan kayıtları (ör. Vatan) başka kanaldaki aynı ürünün EAN'li kaydına bağlar.
// İLKE: yanlış eşleşme göstermektense eşleşmemeyi tercih et. Emin olunamazsa kayıt kendi grubunda kalır.
// Eşleşme yolları (ikisi de belirsizlik halinde reddeder):
//   1) Uzun model kodu (SM-A276BZKCTUR gibi, >=12 karakter) tek bir EAN grubunda geçiyorsa
//   2) Aynı kategori + aynı model adı + aynı depolama + aynı renk (birebir) tek bir EAN grubunda varsa
import { COLORS } from './normalize.mjs';

const tr = (s) => String(s == null ? '' : s).toLocaleLowerCase('tr-TR');
const fold = (s) => tr(s).replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');

const EN = { gray: 'gri', grey: 'gri', black: 'siyah', white: 'beyaz', silver: 'gumus', blue: 'mavi', green: 'yesil', pink: 'pembe', navy: 'lacivert', purple: 'mor', violet: 'mor', gold: 'altin', red: 'kirmizi', yellow: 'sari', orange: 'turuncu', cream: 'krem', lavender: 'lavanta' };
const SUFFIX = { siyahi: 'siyah', mavisi: 'mavi', grisi: 'gri', moru: 'mor', yesili: 'yesil', pembesi: 'pembe', kirmizisi: 'kirmizi', turuncusu: 'turuncu', sarisi: 'sari', gumusu: 'gumus', beyazi: 'beyaz', altini: 'altin', lavantasi: 'lavanta' };
const COLOR_WORDS = new Set(COLORS.flatMap((c) => fold(c).split(' ')).concat(Object.keys(EN), Object.keys(SUFFIX)));
const canonColor = (w) => EN[w] || SUFFIX[w] || w;
const DROP = new Set(['samsung', 'galaxy', 'akilli', 'telefon', 'telefonu', 'cep', 'tablet', 'tam', 'dokunmatik', 'saat', 'kulaklik', 'gb', 'tb', 'ram', 'ile']);

/** Başlıktan model adı (renk/depolama/RAM/kod/genel sözcükler atılmış) ve renk. */
export function modelParts(label) {
  let s = fold(label);
  s = s.replace(/\bsm-[a-z0-9]+\b/g, ' ');
  s = s.replace(/(?<![a-z\d.])\d{1,2}\s*(?:gb)?(?:\s*\/\s*|\+)(?:\d{2,4}\s*(?:gb|tb)?|\d{1,2}\s*tb)\b/g, ' '); // 8/256, 12+256GB, 16GB/1TB, 16/1 TB
  s = s.replace(/\b\d{1,4}\s*(gb|tb)\b/g, ' ');
  s = s.replace(/[^a-z0-9+ ]+/g, ' ');
  const model = [];
  const color = [];
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (COLOR_WORDS.has(w)) color.push(canonColor(w));
    else if (!DROP.has(w)) model.push(w);
  }
  return { model: model.join(' '), color: color.join(' ') };
}

const CODE_RE = /\b[a-z]{2}-[a-z0-9]{8,}\b/gi;
function codesOf(it) {
  const out = new Set();
  const add = (c) => { c = String(c || '').toLowerCase(); if (c.length >= 12) out.add(c); };
  add(it.mpn);
  for (const m of String(it.name || '').matchAll(CODE_RE)) add(m[0]);
  return out;
}

function baseSig(it) {
  if (it.cat !== 'phone' && it.cat !== 'tablet') return null;
  if (!it.storage) return null;
  const p = modelParts(it.label);
  if (!p.model || !p.color) return null;
  return [it.cat, p.model, it.storage, p.color].join('|');
}
const ramOk = (a, b) => a.ram == null || b.ram == null || a.ram === b.ram;
const storOk = (a, b) => !a.storage || !b.storage || a.storage === b.storage;

/** items'ı yerinde günceller; bağlanan kayıt sayısını döndürür. */
export function linkItems(items) {
  for (const it of items) if (it.ownKey) { it.key = it.ownKey; if (it.match === 'model') it.match = 'baslik'; }
  const anchors = items.filter((i) => i.match === 'ean');
  const bySig = new Map();
  const byCode = new Map();
  const put = (m, k, key, it) => { if (!m.has(k)) m.set(k, new Map()); m.get(k).set(key, it); };
  for (const a of anchors) {
    const s = baseSig(a);
    if (s) put(bySig, s, a.key, a);
    for (const c of codesOf(a)) put(byCode, c, a.key, a);
  }
  const taken = new Set(items.map((i) => i.ch + '|' + i.key));
  const plan = [];
  const loose = items.filter((i) => i.match !== 'ean');
  for (const it of loose) {
    let cand = null;
    // 1) model kodu
    const hits = new Map();
    for (const c of codesOf(it)) for (const [k, a] of byCode.get(c) || []) hits.set(k, a);
    const okByCode = [...hits.values()].filter((a) => a.cat === it.cat && ramOk(it, a) && storOk(it, a));
    if (hits.size === 1 && okByCode.length === 1) cand = okByCode[0];
    // 2) birebir özellik eşitliği
    if (!cand) {
      const s = baseSig(it);
      const group = s ? [...(bySig.get(s) || new Map()).values()].filter((a) => ramOk(it, a)) : [];
      if (new Set(group.map((a) => a.key)).size === 1) cand = group[0];
    }
    if (cand) plan.push({ it, key: cand.key });
  }
  // Aynı kanalda iki kayıt aynı ürüne işaret ediyorsa ya da o ürünü o kanal zaten taşıyorsa: belirsiz, hiçbirini bağlama.
  const want = new Map();
  for (const p of plan) { const id = p.it.ch + '|' + p.key; want.set(id, (want.get(id) || 0) + 1); }
  let n = 0;
  for (const { it, key } of plan) {
    const id = it.ch + '|' + key;
    if (want.get(id) !== 1 || taken.has(id)) continue;
    it.key = key;
    it.match = 'model';
    n++;
  }
  return n;
}
