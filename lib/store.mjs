// Dosya okuma/yazma, günlük sınır ve son-başarılı-fiyat önbelleği (geçmiş izleme dahil).
import fs from 'node:fs';
import path from 'node:path';
import { USED_RE } from './normalize.mjs';

export function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
export function writeJson(p, obj, indent = 0) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, indent) + '\n');
  fs.renameSync(tmp, p);
}

export function istDay(date, tz = 'Europe/Istanbul') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function runsToday(state, now, tz) {
  const d = istDay(now, tz);
  return (state.runs || []).filter((r) => istDay(new Date(r.at), tz) === d);
}

/**
 * Yeni gözlemleri eskilerle birleştirir.
 * - Fiyat aynıysa: since/prev/prevAt korunur.
 * - Fiyat değiştiyse: prev = eski fiyat, prevAt = eski fiyatın ilk görüldüğü an, since = şimdi.
 * - Bu turda görülmeyen eski kayıtlar retainDays boyunca son bilinen fiyatla tutulur (checkedAt eski kalır).
 */
export function mergeItems(prevItems, newItems, nowIso, retainDays) {
  const id = (i) => i.ownKey || i.key; // barkodsuz kayıtlarda kanal içi kalıcı kimlik
  const prevMap = new Map(prevItems.map((i) => [id(i), i]));
  const out = [];
  const seenKeys = new Set();
  for (const it of newItems) {
    const o = prevMap.get(id(it));
    const n = { ...it };
    if (o) {
      if (o.price === n.price) { n.since = o.since || nowIso; n.prev = o.prev ?? null; n.prevAt = o.prevAt ?? null; }
      else { n.prev = o.price; n.prevAt = o.since || o.checkedAt || nowIso; n.since = nowIso; }
    }
    seenKeys.add(id(it));
    out.push(n);
  }
  const cutoff = Date.parse(nowIso) - retainDays * 86400000;
  for (const o of prevItems) {
    if (seenKeys.has(id(o))) continue;
    // yenilenmiş / outlet / ikinci el ürün bir turda kabul kuralından geçemediyse önbellekte de tutulmaz
    if (USED_RE.test(String(o.name || o.label || ''))) continue;
    if (Date.parse(o.checkedAt) >= cutoff) out.push(o); // son başarılı fiyat önbellekte kalır
  }
  return out;
}

/** Aynı ürün (EAN) farklı kanallarda 'maxGap' kat farklıysa doğrulanamamış sayılır: 'sapma' işaretlenir. */
export function flagOutliers(items, maxGap) {
  const by = new Map();
  for (const it of items) { it.flag = null; (by.get(it.key) || by.set(it.key, []).get(it.key)).push(it); }
  let n = 0;
  for (const arr of by.values()) {
    const ps = arr.filter((x) => x.inStock !== false).map((x) => x.price);
    if (ps.length < 2) continue;
    if (Math.max(...ps) / Math.min(...ps) > maxGap) { arr.forEach((x) => { x.flag = 'sapma'; }); n++; }
  }
  return n;
}
