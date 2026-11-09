// Fiyat toplama orkestratörü. Günde 2 tur (10:30 ve 16:30); her turda sıradaki API anahtarı öncelikli olur (1 → 2 → 3 → 1 …); uygulama açıldığında HİÇBİR sorgu yapılmaz.
// Çıktı: data/prices.json (uygulamanın okuduğu doğrulanmış dosya) ve data/state.json (günlük sınır kaydı).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient, keyFp } from './lib/reef.mjs';
import { readJson, writeJson, istDay, runsToday, recentRun, mergeItems, flagOutliers } from './lib/store.mjs';
import { validateFeed, CATS, CHANNEL_NAMES, CAT_LABELS } from './lib/validate.mjs';
import { linkItems } from './lib/link.mjs';
import * as teknosa from './collectors/teknosa.mjs';
import * as mediamarkt from './collectors/mediamarkt.mjs';
import * as vatan from './collectors/vatan.mjs';

const COLLECTORS = [teknosa, mediamarkt, vatan]; // ucuzdan pahalıya; biri çökse diğerleri etkilenmez
const ORDER = { mediamarkt: 0, teknosa: 1, vatan: 2 };

export const emptyFeed = () => ({ schema: 2, updated: null, cats: [], sites: {}, items: [], run: null });

/**
 * Anahtar sırası: son 24 saatte "kredi bitti / geçersiz" işaretlenenler en sona alınır (kredi harcanmadan yeni anahtarla başlanır);
 * 24 saat sonra eski önceliğine döner (kredisi yenilenmiş olabilir). Hepsi işaretliyse yine hepsi sırayla denenir.
 */
export function orderKeys(keys, state, now = new Date()) {
  const bad = (state && state.badKeys) || {}, t = now.getTime();
  const isBad = (k) => { const b = bad[keyFp(k)]; return !!b && t - Date.parse(b.at) < 24 * 3600e3; };
  return keys.filter((k) => !isBad(k)).concat(keys.filter(isBad));
}

/**
 * Sıralı dönüş: son NORMAL (deneme olmayan) turda kullanılan yuvadan sonraki anahtar bu turda öncelikli olur: 1 → 2 → 3 → 1 …
 * Yuvalar seyrek olabilir (ör. yalnızca 1 ve 3 tanımlı). `from` (ISO tarih) öncesi turlar sayılmaz: dönüş o tarihten itibaren ilk anahtarla başlar.
 * Kullanılamaz (kredisi biten) anahtarı sona atmak orderKeys'in işidir; kalan anahtarlar kendi aralarında dönmeye devam eder.
 */
export function rotateKeys(entries, state, from) {
  const es = entries.slice().sort((a, b) => a.slot - b.slot);
  if (es.length < 2) return es;
  const t0 = from ? Date.parse(from) : 0;
  const last = ((state && state.runs) || []).filter((r) => !r.force && r.slot && Date.parse(r.at) >= t0)
    .reduce((m, r) => (!m || Date.parse(r.at) > Date.parse(m.at) ? r : m), null);
  if (!last) return es;
  const i = es.findIndex((e) => e.slot > last.slot);
  return i <= 0 ? es : es.slice(i).concat(es.slice(0, i));
}

const KEY_NAMES = ['REEFAPI_KEY', 'REEFAPI_KEY_2', 'REEFAPI_KEY_3'];
/**
 * Ortamdaki anahtarları öncelik sırasıyla okur. REEFAPI_ONLY=2|3 (elle deneme turu): yalnızca o yuvadaki anahtar kullanılır, yedeğe geçilmez.
 * Dönen: { entries: [{k, slot}], only, missing }
 */
export function pickKeys(env) {
  const all = KEY_NAMES.map((n, i) => ({ k: String(env[n] || '').trim(), slot: i + 1 })).filter((e) => e.k);
  const only = /^[23]$/.test(String(env.REEFAPI_ONLY || '').trim()) ? Number(String(env.REEFAPI_ONLY).trim()) : 0;
  if (only) { const e = all.find((x) => x.slot === only); return { entries: e ? [e] : [], only, missing: !e }; }
  return { entries: all.filter((e, i, a) => a.findIndex((x) => x.k === e.k) === i), only: 0, missing: false };
}

export async function run({ makeClient, cfg, dir, now = new Date(), force = false, dry = false, log = console.log }) {
  const feedPath = path.join(dir, 'data/prices.json');
  const statePath = path.join(dir, 'data/state.json');
  const prev = readJson(feedPath, emptyFeed());
  if (!Array.isArray(prev.items)) prev.items = [];
  prev.sites = prev.sites || {};
  const state = readJson(statePath, { runs: [] });
  const nowIso = now.toISOString();
  const L = cfg.limits;

  // 1) Günlük sınır: en fazla maxRunsPerDay tur ve maxCreditsPerDay kredi
  const today = runsToday(state, now, cfg.tz);
  const spentToday = today.reduce((a, r) => a + (r.credits || 0), 0);
  if (!force && today.length >= L.maxRunsPerDay) {
    log(`Günlük sınır doldu (${today.length}/${L.maxRunsPerDay} tur). Sorgu yapılmadı.`);
    return { skipped: 'tur-siniri' };
  }
  // Yedek zamanlar (GitHub zamanlayıcısı gecikebilir ya da bir turu atlayabilir): yakın zamanda başarılı tur yapıldıysa bu tur atlanır, kredi harcanmaz.
  if (!force && L.minGapHours && recentRun(state, now, L.minGapHours)) {
    log(`Son ${L.minGapHours} saat içinde başarılı bir tur yapıldı; yedek tur atlandı. Sorgu yapılmadı.`);
    return { skipped: 'yakin-tur' };
  }
  const dayLeft = force ? L.maxCreditsPerRun : L.maxCreditsPerDay - spentToday;
  if (dayLeft <= 0) { log('Günlük kredi sınırı doldu. Sorgu yapılmadı.'); return { skipped: 'kredi-siniri' }; }
  const client = makeClient(Math.min(L.maxCreditsPerRun, dayLeft), state);
  if (dry) {
    log(`KURU TUR: kredi harcanmadı, mağazalara sorgu yapılmadı. Gerçek tur olsaydı çalışırdı (bugün ${today.length}/${L.maxRunsPerDay} tur, ${spentToday} kredi).`);
    return { dry: true };
  }

  // 2) Mağaza başına bağımsız toplama
  const scope = cfg.scope.filter((c) => CATS.includes(c));
  const sites = { ...prev.sites };
  let items = prev.items.slice();
  const runInfo = { at: nowIso, stores: {} };
  let anyFresh = false;
  const results = {};

  for (const c of COLLECTORS) {
    const sc = cfg.stores[c.STORE] || { enabled: false };
    let res;
    if (!sc.enabled) {
      res = { store: c.STORE, status: 'off', items: [], stats: { pages: 0, rows: 0, accepted: 0, rejected: {}, credits: 0 }, error: null, note: 'Kapalı.' };
    } else {
      try { res = await c.collect({ client, cfg: sc, scope, now }); }
      catch (e) {
        res = { store: c.STORE, status: 'error', items: [], stats: { pages: 0, rows: 0, accepted: 0, rejected: {}, credits: 0 }, error: String(e && e.message || e) };
      }
    }
    results[c.STORE] = res;
    const old = prev.sites[c.STORE] || {};
    const prevStoreItems = items.filter((i) => i.ch === c.STORE);
    const others = items.filter((i) => i.ch !== c.STORE);
    let merged = prevStoreItems;
    if (res.items.length) { merged = mergeItems(prevStoreItems, res.items, nowIso, L.retainDays); anyFresh = true; }
    else { const cutoff = Date.parse(nowIso) - L.retainDays * 86400000; merged = prevStoreItems.filter((i) => Date.parse(i.checkedAt) >= cutoff); }
    items = others.concat(merged);
    sites[c.STORE] = {
      status: res.status,
      ok: res.status === 'ok',
      at: res.status === 'ok' ? nowIso : (old.at || null), // son BAŞARILI tam toplama
      attemptAt: nowIso,
      count: merged.length,
      note: res.note || null,
      error: res.error ? String(res.error).slice(0, 300) : null,
    };
    runInfo.stores[c.STORE] = { status: res.status, ...res.stats };
    log(`[${c.STORE}] ${res.status} · ${res.stats.pages} sayfa · ${res.stats.rows} satır · ${res.stats.accepted} kabul · ${res.stats.credits} kredi` +
      (Object.keys(res.stats.rejected).length ? ' · elenen: ' + JSON.stringify(res.stats.rejected) : '') + (res.error ? ' · HATA: ' + res.error : '') + (res.note ? ' · ' + res.note : ''));
  }

  // 2b) MediaMarkt tamamlama turu: genel aramalarda görünmeyen ürünler için barkodla doğrudan arama (mediamarkt.mjs başındaki açıklamaya bakın).
  //     Yalnızca MediaMarkt genel taraması başarılıysa ve başka kanallardan taze kayıt varsa çalışır; bütçe dolarsa tur bozulmaz.
  const mmCfg = cfg.stores.mediamarkt || {};
  const mmRes = results.mediamarkt;
  if (mmCfg.enabled && mmCfg.gap && mmCfg.gap.enabled !== false && mmRes && mmRes.status === 'ok' && !mmRes.budgetStop) {
    state.gaps = state.gaps || {};
    const cache = state.gaps.mediamarkt = state.gaps.mediamarkt || {};
    const pick = mediamarkt.pickGapTargets({ items, nowIso, cache, gap: mmCfg.gap, now });
    const targets = pick.targets.slice(0, Math.max(0, mmCfg.gap.maxQueries ?? 12));
    const info = { targets: pick.missing, cached: pick.cached, queried: 0, found: 0, marketplace: 0, none: 0, deferred: pick.targets.length - targets.length, credits: 0 };
    if (targets.length) {
      const have = new Set(items.filter((i) => i.ch === 'mediamarkt' && i.checkedAt === nowIso).map((i) => i.key));
      const gr = await mediamarkt.completeGaps({ client, cfg: mmCfg, scope, now, targets, have });
      Object.assign(info, { queried: gr.stats.checked, found: gr.stats.found, marketplace: gr.stats.marketplace, none: gr.stats.none, credits: gr.stats.credits });
      if (gr.stats.budgetStop) info.budgetStop = true;
      if (gr.stats.error) info.error = String(gr.stats.error).slice(0, 200);
      if (gr.items.length) {
        const mmNow = items.filter((i) => i.ch === 'mediamarkt');
        const merged = mergeItems(mmNow, gr.items, nowIso, L.retainDays);
        items = items.filter((i) => i.ch !== 'mediamarkt').concat(merged);
        sites.mediamarkt.count = merged.length;
      }
      for (const [k, v] of Object.entries(gr.verdicts)) { if (v === 'bulundu') delete cache[k]; else cache[k] = { at: nowIso, why: v }; }
    }
    for (const k of Object.keys(cache)) if (Date.parse(nowIso) - Date.parse(cache[k].at) > 30 * 86400e3) delete cache[k];
    if (!Object.keys(cache).length) delete state.gaps.mediamarkt;
    if (!Object.keys(state.gaps).length) delete state.gaps;
    runInfo.stores.mediamarkt.gap = info;
    const gnote = info.queried ? `Tamamlama: ${info.queried} üründe barkodla arandı, ${info.found} bulundu` + (info.marketplace ? `, ${info.marketplace} yalnızca pazaryeri satıcıda` : '') + (info.deferred ? `, ${info.deferred} ürün sonraki tura kaldı` : '') + '.' : null;
    if (gnote) sites.mediamarkt.note = [sites.mediamarkt.note, gnote].filter(Boolean).join(' · ');
    log(`[mediamarkt] tamamlama · ${info.targets} üründe eksik görüldü · ${info.cached} önbellekte (yakın zamanda denendi) · ${info.queried} arandı · ${info.found} bulundu · ${info.marketplace} pazaryeri · ${info.none} yok · ${info.credits} kredi` + (info.deferred ? ` · ${info.deferred} sonraki tura` : '') + (info.budgetStop ? ' · bütçe doldu' : '') + (info.error ? ' · HATA: ' + info.error : ''));
  }

  // 3) Kanallar arası eşleştirme (barkodsuz kayıtlar), aykırı fark işareti, sıralama, doğrulama
  const nLink = linkItems(items);
  if (nLink) log(`${nLink} barkodsuz kayıt model kodu/özellik eşitliğiyle başka kanaldaki ürüne bağlandı.`);
  const nOut = flagOutliers(items, L.maxPriceGap);
  if (nOut) log(`${nOut} üründe kanallar arası fark ${L.maxPriceGap}x'ten büyük: 'kontrol gerekli' işaretlendi.`);
  items.sort((a, b) => a.cat.localeCompare(b.cat) || a.label.localeCompare(b.label, 'tr') || ORDER[a.ch] - ORDER[b.ch]);
  const feed = {
    schema: 2,
    updated: anyFresh ? nowIso : prev.updated,
    cats: scope,
    // Uygulama kanal/kategori adlarını ve sırasını buradan okur: yeni kanal/kategori eklemek HTML değişikliği gerektirmez.
    channels: (cfg.channelOrder || Object.keys(CHANNEL_NAMES)).filter((id) => CHANNEL_NAMES[id] && (cfg.stores[id] || {}).enabled).map((id) => ({ id, name: CHANNEL_NAMES[id] })),
    catLabels: Object.fromEntries(scope.map((k) => [k, CAT_LABELS[k] || k])),
    sites,
    items,
    run: { ...runInfo, credits: client.spent },
  };
  const problems = validateFeed(feed);

  // 4) Çalışma kaydı (kredi harcandıysa ya da veri tazelendiyse sayılır)
  let wrote = false;
  if (problems.length) {
    log('DOĞRULAMA BAŞARISIZ, prices.json değiştirilmedi:\n - ' + problems.slice(0, 10).join('\n - '));
  } else {
    writeJson(path.join(dir, 'data/prices.json'), feed);
    wrote = true;
  }
  // Anahtar durumu: kullanılamaz çıkan anahtar parmak iziyle (anahtarın kendisi değil) 24 saat işaretlenir; çalışan anahtarın işareti kalkar.
  const badNew = (client.badKeys || []).filter((b) => b.persist);
  (client.badKeys || []).forEach((b) => log(`Anahtar ${b.fp} kullanılamadı (${b.why === 'kredi' ? 'kredisi bitti' : b.why === 'gecersiz' ? 'geçersiz' : 'yetki hatası'}, HTTP ${b.status})` +
    (client.keyIndex > 0 ? ` · tur ${client.keyIndex + 1}. anahtarla sürdürüldü.` : ' · yedek anahtar yok ya da o da kullanılamadı.')));
  let keyChanged = false;
  if (badNew.length) {
    state.badKeys = state.badKeys || {};
    for (const b of badNew) state.badKeys[b.fp] = { at: nowIso, why: b.why };
    keyChanged = true;
  }
  if (client.spent > 0 && client.activeFp && state.badKeys && state.badKeys[client.activeFp] && !badNew.some((b) => b.fp === client.activeFp)) { delete state.badKeys[client.activeFp]; keyChanged = true; }
  if (state.badKeys) {
    const cut = Date.parse(nowIso) - 14 * 86400000;
    for (const k of Object.keys(state.badKeys)) if (Date.parse(state.badKeys[k].at) < cut) { delete state.badKeys[k]; keyChanged = true; }
    if (!Object.keys(state.badKeys).length) delete state.badKeys;
  }
  if (client.spent > 0 || anyFresh) {
    const keep = Date.parse(nowIso) - 30 * 86400000;
    state.runs = (state.runs || []).filter((r) => Date.parse(r.at) >= keep).concat([{ at: nowIso, credits: client.spent, ok: anyFresh, force: !!force, ...(client.activeFp ? { fp: client.activeFp } : {}), ...(client.activeSlot ? { slot: client.activeSlot } : {}) }]);
    writeJson(statePath, state, 1);
  } else if (keyChanged) writeJson(statePath, state, 1);
  log(`Bitti · bu tur ${client.spent} kredi · bugün toplam ${spentToday + client.spent} · ${feed.items.length} kayıt · ${istDay(now, cfg.tz)}`);
  return { feed, wrote, problems, credits: client.spent };
}

async function main() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cfg = readJson(path.join(dir, 'config.json'), null);
  if (!cfg) throw new Error('config.json okunamadı');
  const force = process.argv.includes('--force');
  const dry = process.argv.includes('--dry'); // kuru tur: zamanlama/anahtar sırası denemesi, kredi harcamaz
  // Anahtarlar öncelik sırasıyla: REEFAPI_KEY, REEFAPI_KEY_2, REEFAPI_KEY_3. Biri biterse/geçersizse sıradaki ile kesintisiz devam edilir.
  const pk = pickKeys(process.env);
  console.log('Anahtar parmak izleri: ' + (pk.entries.map((e) => `${e.slot}=${keyFp(e.k)}`).join(' ') || 'yok'));
  if (pk.only) console.log(`Deneme turu: yalnızca ${pk.only}. anahtar kullanılır, yedeğe geçilmez.` + (pk.missing ? ` HATA: REEFAPI_KEY_${pk.only} gizli kasada tanımlı değil.` : ''));
  const out = await run({
    makeClient: (max, state) => {
      const rot = rotateKeys(pk.entries, state, cfg.keyRotationFrom);
      const ordered = orderKeys(rot.map((e) => e.k), state, new Date());
      const slots = ordered.map((k) => rot.find((e) => e.k === k).slot);
      console.log('Bu turun anahtar sırası: ' + (ordered.map((k, i) => `${slots[i]}. anahtar (${keyFp(k)})`).join(' → ') || 'yok'));
      return createClient({ keys: ordered, slots, maxCredits: max });
    },
    cfg, dir, force, dry,
  });
  if (out.problems && out.problems.length) process.exitCode = 1;
  // Tek mağazanın hatası işi kırmaz (son başarılı veri korunur, durum prices.json'da görünür).
  // Ama hiçbir mağaza çalışmadıysa (ör. anahtar eksik) iş KIRMIZI biter ki fark edilsin.
  if (out.feed) {
    const act = Object.values(out.feed.sites).filter((x) => x.status !== 'off' && x.status !== 'unverified');
    if (act.length && act.every((x) => x.status === 'error')) {
      console.error('Hiçbir mağaza toplanamadı: ' + act.map((x) => x.error).filter(Boolean).slice(0, 2).join(' | '));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('Hata:', e && e.message ? e.message : e); process.exit(1); });
}
