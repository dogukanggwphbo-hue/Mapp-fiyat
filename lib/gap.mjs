// Tamamlama turu (kanallar arası doğrudan arama).
//
// Neden: mağaza sitelerindeki anahtar sözcük aramaları eksiksiz değildir (sonuç listesi sınırlı, sıra/sayfa turdan tura kayar); bu yüzden satışta
// olan bazı ürünler genel taramada hiç görünmeyebilir (ör. MediaMarkt'ta Tab S10 FE+ Mavi 12/256, Buds4 Siyah). Genel taramalardan sonra,
// BAŞKA bir kanalda bu turda görülen (stokta) ama bu kanalda görülmeyen ürünler için o kanalda doğrudan arama yapılır:
//   MediaMarkt : barkodun kendisi (tam eşleşir, tek sonuç)               · barkodsuz hedefte model adı
//   Teknosa    : model adı (barkod aranamaz; sonuç satırında barkod gelir) · barkod eşitliğiyle doğrulanır
//   Vatan      : model adı (barkod yok; model adı tüm renk/depolama seçeneklerini tek sorguda getirir) · imza eşleştirmesiyle doğrulanır
// Bulunan satır YALNIZCA o kanalın kendi kabul kuralından (satıcı, marka, outlet, fiyat...) geçerse alınır; kurallar gevşetilmez.
// Doğrulama: aday satırlar hedef ürün grubuyla lib/link.mjs'nin (ürün özelliklerine dayalı, temkinli) eşleştiricisinden geçirilir; yanlış eşleşme
// göstermektense "bulunamadı" denir. Sonuç (verdict): 'bulundu' | 'pazaryeri' (yalnızca pazaryeri satıcıda var) | 'yok'.
// Her karar durum dosyasındaki olumsuz önbelleğe yazılır (state.gaps.<kanal>[hedef]): bulunamayanlar 3, yalnızca pazaryerinde olanlar 7 gün
// yeniden aranmaz. 'bulundu' kararı önbellekte "kanıtlanmış" olarak kalır: genel taramada yine görünmediği sürece fiyatı tazelemek için her tur aranır.
import { linkItems, isColorWord, accCode, fold } from './link.mjs';
import { buildItem } from './normalize.mjs';
import { validateItem } from './validate.mjs';
import { BudgetError, isEmptyResult, isFatal } from './reef.mjs';
import { mergeItems } from './store.mjs';

const DAY = 86400e3;
export const isEan = (k) => /^\d{8,14}$/.test(String(k || ''));
const idOf = (i) => i.ownKey || i.key;

// ---- arama metni -------------------------------------------------------------------------------------------------------------------------
// Renk ve depolama kanallar arasında farklı yazılır (Navy/Mavi, 12/256 GB / 12Gb 256Gb); bu yüzden arama MODEL düzeyindedir, ayrım doğrulamada yapılır.
const STORAGE = [
  /(?<![A-Za-z\d.])\d{1,2}\s*(?:gb)?\s*(?:\/|\+)\s*(?:\d{2,4}\s*(?:gb|tb)?|\d{1,2}\s*tb)(?![A-Za-z\d])/gi, // 8/256, 12+256GB, 16GB/1TB, 16/1 TB
  /(?<![A-Za-z\d.])\d{1,4}\s*(?:gb|tb)(?![A-Za-z\d])/gi, // 128GB, 1 TB
];
const FLUFF = new Set(['samsung', 'akilli', 'telefon', 'telefonu', 'cep', 'tablet', 'tam', 'dokunmatik', 'android', 'bluetooth', 'kulak', 'ici', 'kulaklik', 'saat', 'kablosuz', 'kablolu', '5g', 'lte', '4g']);

const GALAXY_CATS = new Set(['phone', 'tablet', 'wearable']);

/**
 * Bir kayıttan model düzeyinde arama metni: "Galaxy Tab S10 FE+", "Galaxy Watch8 Classic 46mm"; şarj/kulaklıkta ürün kodu ("EP-T2510N").
 * Samsung'un resmî yazımına yaklaştırılır ("Watch 8" → "Watch8", "Z Fold 7" → "Fold7"): kanallar bu adı farklı bölerek yazar. Yetersizse null.
 */
export function searchText(it) {
  const code = (it.cat === 'adapter' || it.cat === 'wearable') ? accCode(it) : null;
  if (code) return code.toUpperCase();
  let s = String(it.label || it.name || '');
  for (const re of STORAGE) s = s.replace(re, ' ');
  s = s.replace(/\d+(?:[.,]\d+)?\s*(?:''|"|”|’’|inç|inc|inch)\w*/gi, ' ').replace(/\d+(?:[.,]\d+)?\s*ghz/gi, ' '); // Vatan başlıklarındaki ekran / işlemci gürültüsü
  s = s.replace(/\b(watch|fold|flip|buds)\s+(\d{1,2})(?!\d)/gi, '$1$2').replace(/(^|\s)z\s+(?=(?:fold|flip))/gi, '$1');
  const out = [];
  for (const w of s.split(/\s+/)) {
    const fw = fold(w);
    const f = fw.replace(/[^a-z0-9+]/g, '');
    if (!f) continue;
    if (/^(sm|ep|eo|ee)-/.test(fw)) continue;
    if (FLUFF.has(f) || isColorWord(f)) continue;
    const t = w.replace(/^[-–,]+|[-–,]+$/g, '');
    if (t) out.push(t);
  }
  if (GALAXY_CATS.has(it.cat) && out.length && !out.some((w) => /^galaxy$/i.test(w))) out.unshift('Galaxy');
  const q = out.join(' ').trim();
  return out.length >= 2 && q.length >= 5 ? q : null;
}

/** Hedef grubun metin üretilebilen ilk kaydından arama metni (bilgisi en çok olan kayıt önce). */
export function targetText(t) {
  const rank = (i) => -[i.ram, i.storage, i.color].filter((x) => x != null).length;
  for (const i of t.items.slice().sort((a, b) => rank(a) - rank(b))) { const q = searchText(i); if (q) return q; }
  return null;
}

// ---- hedef seçimi ---------------------------------------------------------------------------------------------------------------------------
/**
 * `store` kanalında bu turda görülmeyen ama başka kanalda görülen (taze, stokta) ürün grupları.
 * items: linkItems'tan geçmiş birleşik kayıtlar (grup = key). cache: { [hedef]: { at, why } }.
 * Sıra: önce daha önce bulunmuş ("kanıtlanmış"), sonra daha çok kanalda olanlar, sonra anahtar sırası.
 * canQuery(hedef) false ise (aranacak metin çıkarılamıyorsa) hedef atlanır.
 */
export function pickTargets({ store, items, nowIso, cache = {}, gap = {}, now, canQuery = () => true }) {
  const fresh = (i) => i.checkedAt === nowIso;
  const here = new Set(items.filter((i) => i.ch === store && fresh(i)).map((i) => i.key));
  const groups = new Map();
  for (const i of items) {
    if (i.ch === store || !fresh(i) || i.inStock === false) continue;
    if (!groups.has(i.key)) groups.set(i.key, { key: i.key, items: [], chs: new Set() });
    const g = groups.get(i.key);
    g.items.push(i); g.chs.add(i.ch);
  }
  const t = (now instanceof Date ? now : new Date(now)).getTime();
  const ttl = (c) => (c.why === 'pazaryeri' ? (gap.retryMarketplaceDays ?? 7) : (gap.retryNotFoundDays ?? 3)) * DAY;
  const minCh = gap.minChannels ?? 1;
  const out = { targets: [], missing: 0, cached: 0, unsearchable: 0 };
  for (const g of groups.values()) {
    if (here.has(g.key) || g.chs.size < minCh) continue;
    out.missing++;
    const c = cache[g.key];
    const hit = !!c && c.why === 'bulundu';
    if (c && !hit && t - Date.parse(c.at) < ttl(c)) { out.cached++; continue; }
    const target = { key: g.key, items: g.items, nch: g.chs.size, hit };
    if (!canQuery(target)) { out.unsearchable++; continue; }
    out.targets.push(target);
  }
  out.targets.sort((a, b) => (b.hit - a.hit) || (b.nch - a.nch) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** Hedefleri aynı arama isteğine göre birleştirir: "Galaxy Z Fold8" gibi model düzeyinde bir arama tüm renk/depolama hedeflerini tek krediyle kapatır. */
export function toUnits(targets, mod, cfg) {
  const units = new Map();
  for (const t of targets) {
    const req = mod.gapRequest(t, cfg);
    if (!req) continue;
    const k = JSON.stringify(req);
    if (!units.has(k)) units.set(k, { req, targets: [] });
    units.get(k).targets.push(t);
  }
  return [...units.values()];
}

/**
 * Tur bütçesini kanallar arasında sırayla (birer birer) dağıtır; her kanalın tavanı (cap) ve sorgu maliyeti (cost) ayrı.
 * plans: [{ store, units, cost, cap }]. Dönüş: Map(store -> seçilen units).
 */
export function allocate(plans, budget) {
  const taken = new Map(plans.map((p) => [p.store, []]));
  let left = budget;
  for (let again = true; again;) {
    again = false;
    for (const p of plans) {
      const got = taken.get(p.store);
      if (got.length >= p.cap || got.length >= p.units.length || p.cost > left) continue;
      got.push(p.units[got.length]); left -= p.cost; again = true;
    }
  }
  return taken;
}

// ---- doğrulama ------------------------------------------------------------------------------------------------------------------------------
/** Aday kayıtlardan hedef ürüne bağlananlar: önce anahtar eşitliği (barkod), yoksa linkItems ile özellik eşleştirmesi (yalnız hedef grubu + adaylar). */
export function matchTarget(cands, target) {
  if (!cands.length) return [];
  const g = target.items.map((x) => ({ ...x }));
  const f = cands.map((x) => ({ ...x }));
  linkItems([...g, ...f]);
  const ok = new Set(g.map((x) => x.key));
  return cands.filter((c, i) => ok.has(f[i].key));
}

// ---- arama ----------------------------------------------------------------------------------------------------------------------------------
export async function completeGaps({ client, mod, cfg, scope, now, units, have = new Set() }) {
  const nowIso = now.toISOString();
  const stats = { queries: 0, checked: 0, found: 0, marketplace: 0, none: 0, credits: 0, error: null, budgetStop: false };
  const verdicts = {};
  const items = new Map();
  const start = client.spent;
  for (const u of units) {
    let r;
    try {
      r = await client.call(mod.STORE, 'search', u.req, { cost: cfg.creditsPerCall });
    } catch (e) {
      if (e instanceof BudgetError) { stats.budgetStop = true; break; } // bütçe doldu: tur bozulmaz, kalanlar sonraki tura
      if (isEmptyResult(e)) r = null; // arama sonuç vermedi: hedefler için "yok"
      else if (isFatal(e)) { stats.error = String(e.message || e); break; } // kredi/yetki: dur
      else { stats.error = stats.error || String(e && e.message || e); continue; } // geçici hata: karar yok (önbelleğe yazılmaz), sonraki turda yeniden denenir
    }
    stats.queries++;
    const rows = r ? (mod.gapRows ? mod.gapRows(r.data) : (((r.data || {}).results) || [])) : [];
    const cands = [];
    const rejected = [];
    for (const row of rows) {
      const why = mod.accept(row);
      if (why) { rejected.push([row, why]); continue; }
      const it = buildItem(mod.toFields(row), nowIso);
      if (!scope.includes(it.cat) || validateItem(it)) continue;
      cands.push(it);
    }
    for (const c of cands) if (!have.has(idOf(c)) && !items.has(idOf(c))) items.set(idOf(c), c);
    for (const t of u.targets) {
      stats.checked++;
      const hit = matchTarget(cands, t).some((c) => !have.has(idOf(c))); // zaten taze ama bağlanmamış kayıt "bulundu" sayılmaz (her tur boşuna aranmasın)
      const mp = !hit && !!mod.gapMarketplace && rejected.some(([row, why]) => mod.gapMarketplace(row, why, t));
      if (hit) { stats.found++; verdicts[t.key] = 'bulundu'; }
      else if (mp) { stats.marketplace++; verdicts[t.key] = 'pazaryeri'; }
      else { stats.none++; verdicts[t.key] = 'yok'; }
    }
  }
  stats.credits = client.spent - start;
  return { items: [...items.values()], verdicts, stats };
}

// ---- tur ------------------------------------------------------------------------------------------------------------------------------------
/**
 * Tamamlama turunun tamamı: hedefleri seçer, bütçeyi dağıtır, kanal kanal arar, bulunanları kanalın kayıtlarına katar, olumsuz önbelleği günceller.
 * items: tüm kanalların birleşik kayıtları (genel taramalar yapılmış). Dönüş: { items }. sites / runInfo / state yerinde güncellenir.
 */
export async function gapPass({ client, modules, cfg, scope, now, items, results, state, sites, runInfo, retainDays, log = () => {} }) {
  const nowIso = now.toISOString();
  const active = [];
  for (const m of modules) {
    const sc = cfg.stores[m.STORE] || {};
    const g = sc.gap;
    const res = results[m.STORE];
    if (!sc.enabled || !g || g.enabled === false || typeof m.gapRequest !== 'function') continue;
    if (!res || res.status !== 'ok' || res.budgetStop) continue; // genel tarama çökmüşse ya da bütçe bitmişse kredi harcanmaz
    active.push({ m, sc, g });
  }
  if (!active.length) return { items };

  linkItems(items); // kanallar arası gruplar (barkodsuz Vatan kayıtları dahil); tur sonunda yeniden yapılır
  state.gaps = state.gaps || {};
  const picks = new Map();
  const plans = [];
  for (const a of active) {
    const store = a.m.STORE;
    const cache = state.gaps[store] = state.gaps[store] || {};
    const pick = pickTargets({ store, items, nowIso, cache, gap: a.g, now, canQuery: (t) => !!a.m.gapRequest(t, a.sc) });
    picks.set(store, pick);
    plans.push({ store, units: toUnits(pick.targets, a.m, a.sc), cost: a.sc.creditsPerCall ?? 1, cap: Math.max(0, a.g.maxQueries ?? 10) });
  }
  const rem = typeof client.remaining === 'number' ? client.remaining : Infinity;
  const budget = Math.min(rem, cfg.limits.gapCredits ?? Infinity);
  const taken = allocate(plans, budget);

  for (const a of active) {
    const store = a.m.STORE;
    const pick = picks.get(store);
    const cache = state.gaps[store];
    const units = taken.get(store);
    const info = { targets: pick.missing, cached: pick.cached, queried: 0, found: 0, marketplace: 0, none: 0, deferred: 0, credits: 0 };
    const nTargets = pick.targets.length;
    if (units.length) {
      const have = new Set(items.filter((i) => i.ch === store && i.checkedAt === nowIso).map(idOf));
      const gr = await completeGaps({ client, mod: a.m, cfg: a.sc, scope, now, units, have });
      Object.assign(info, { queried: gr.stats.queries, found: gr.stats.found, marketplace: gr.stats.marketplace, none: gr.stats.none, credits: gr.stats.credits });
      info.deferred = nTargets - gr.stats.checked;
      if (gr.stats.budgetStop) info.budgetStop = true;
      if (gr.stats.error) info.error = String(gr.stats.error).slice(0, 200);
      if (gr.items.length) {
        const cur = items.filter((i) => i.ch === store);
        const merged = mergeItems(cur, gr.items, nowIso, retainDays);
        items = items.filter((i) => i.ch !== store).concat(merged);
        if (sites[store]) sites[store].count = merged.length;
      }
      for (const [k, v] of Object.entries(gr.verdicts)) cache[k] = { at: nowIso, why: v };
    } else info.deferred = nTargets;
    for (const k of Object.keys(cache)) if (Date.parse(nowIso) - Date.parse(cache[k].at) > 30 * DAY) delete cache[k];
    if (!Object.keys(cache).length) delete state.gaps[store];
    if (runInfo.stores[store]) runInfo.stores[store].gap = info;
    const gnote = info.queried ? `Tamamlama: ${info.queried} aramayla ${info.found} ürün bulundu` + (info.marketplace ? `, ${info.marketplace} ürün yalnızca pazaryeri satıcıda` : '') + (info.deferred ? `, ${info.deferred} ürün sonraki tura kaldı` : '') + '.' : null;
    if (gnote && sites[store]) sites[store].note = [sites[store].note, gnote].filter(Boolean).join(' · ');
    log(`[${store}] tamamlama · ${info.targets} ürün başka kanalda var/burada görülmedi · ${info.cached} önbellekte · ${info.queried} arama · ${info.found} bulundu · ${info.marketplace} pazaryeri · ${info.none} yok · ${info.credits} kredi` + (info.deferred ? ` · ${info.deferred} sonraki tura` : '') + (info.budgetStop ? ' · bütçe doldu' : '') + (info.error ? ' · HATA: ' + info.error : ''));
  }
  if (!Object.keys(state.gaps).length) delete state.gaps;
  return { items };
}
