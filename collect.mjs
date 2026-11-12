// Fiyat toplama orkestratörü. Günde 2 tur (10:30 ve 16:30); her turda sıradaki API anahtarı öncelikli olur (1 → 2 → 3 → 4 → 5 → 6 → 1 …); uygulama açıldığında HİÇBİR sorgu yapılmaz.
// Çıktı: data/prices.json (uygulamanın okuduğu doğrulanmış dosya) ve data/state.json (günlük sınır kaydı).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient, keyFp, ReefError, isEmptyResult } from './lib/reef.mjs';
import { readJson, writeJson, istDay, runsToday, recentRun, mergeItems, flagOutliers } from './lib/store.mjs';
import { validateFeed, CATS, CHANNEL_NAMES, CAT_LABELS } from './lib/validate.mjs';
import { linkItems } from './lib/link.mjs';
import { gapPass } from './lib/gap.mjs';
import * as teknosa from './collectors/teknosa.mjs';
import * as mediamarkt from './collectors/mediamarkt.mjs';
import * as vatan from './collectors/vatan.mjs';
import { detailCheck, parseIds } from './lib/detail.mjs';

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
 * Sıralı dönüş: son NORMAL (deneme olmayan) turda kullanılan yuvadan sonraki anahtar bu turda öncelikli olur: 1 → 2 → … → 6 → 1 …
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

const KEY_NAMES = ['REEFAPI_KEY', 'REEFAPI_KEY_2', 'REEFAPI_KEY_3', 'REEFAPI_KEY_4', 'REEFAPI_KEY_5', 'REEFAPI_KEY_6'];
/**
 * Ortamdaki anahtarları öncelik sırasıyla okur. REEFAPI_ONLY=2..6 (elle deneme turu): yalnızca o yuvadaki anahtar kullanılır, yedeğe geçilmez
 * (config'teki `keySlots` bu elle denemeyi kısıtlamaz).
 * `enabled` (config.json > keySlots, ör. [1, 2]): normal turlarda yalnızca bu yuvalar sırayla kullanılır; diğer yuvalardaki anahtarlar gizli kasada kalsa da
 * devre dışıdır. Boş/tanımsızsa tanımlı bütün yuvalar kullanılır.
 * Dönen: { entries: [{k, slot}], only, missing }
 */
export function pickKeys(env, enabled) {
  const all = KEY_NAMES.map((n, i) => ({ k: String(env[n] || '').trim(), slot: i + 1 })).filter((e) => e.k);
  const only = /^[2-6]$/.test(String(env.REEFAPI_ONLY || '').trim()) ? Number(String(env.REEFAPI_ONLY).trim()) : 0;
  if (only) { const e = all.find((x) => x.slot === only); return { entries: e ? [e] : [], only, missing: !e }; }
  const on = Array.isArray(enabled) && enabled.length ? enabled.map(Number) : null;
  const use = on ? all.filter((e) => on.includes(e.slot)) : all;
  return { entries: use.filter((e, i, a) => a.findIndex((x) => x.k === e.k) === i), only: 0, missing: false };
}

/**
 * Anahtar sınaması (--probe): gizli kasada tanımlı HER yuvadaki anahtar (keySlots'tan bağımsız) ayrı ayrı, Vatan'a tek sayfalık 1 kredilik bir istek atar.
 * Veri yazmaz, durum dosyasını değiştirmez; yalnızca her anahtarın çalışıp çalışmadığını bildirir. Toplam harcama en çok anahtar sayısı kadar kredidir.
 * Dönen: [{ slot, fp, state: 'calisiyor'|'kredi'|'gecersiz'|'yetki'|'hata', status, credits, msg }]
 */
export async function probeKeys({ entries, cfg, fetchImpl, log = console.log }) {
  const v = (cfg && cfg.stores && cfg.stores.vatan) || {};
  const params = { query: 'samsung galaxy', brand: v.brand || 'samsung', page: 1 };
  const out = [];
  for (const e of entries) {
    const client = createClient({ keys: [e.k], slots: [e.slot], maxCredits: 2, ...(fetchImpl ? { fetchImpl } : {}) });
    const r = { slot: e.slot, fp: keyFp(e.k), state: 'calisiyor', status: 200, credits: 0, msg: '' };
    try { await client.call('vatan', 'search', params, { cost: 1 }); }
    catch (err) {
      if (err instanceof ReefError && isEmptyResult(err)) { r.msg = 'arama boş döndü (anahtar çalışıyor)'; }
      else {
        r.state = err instanceof ReefError ? (err.keyProblem || 'hata') : 'hata';
        r.status = err instanceof ReefError ? err.status : 0;
        r.msg = String(err && err.message ? err.message : err).slice(0, 160);
      }
    }
    r.credits = client.spent;
    const lab = { calisiyor: 'ÇALIŞIYOR', kredi: 'KREDİSİ BİTMİŞ', gecersiz: 'GEÇERSİZ (ReefAPI anahtarı tanımıyor)', yetki: 'YETKİ HATASI', hata: 'HATA' }[r.state];
    log(`Yuva ${r.slot} (${r.fp}): ${lab}${r.state === 'calisiyor' ? '' : ` · HTTP ${r.status}`} · ${r.credits} kredi${r.msg ? ' · ' + r.msg : ''}`);
    out.push(r);
  }
  return out;
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

  // 2b) Tamamlama turu: başka kanalda görülüp bu kanalda genel aramada görünmeyen ürünler için doğrudan arama (lib/gap.mjs başındaki açıklamaya bakın).
  //     Yalnızca o kanalın genel taraması başarılıysa çalışır; bütçe kanallar arasında paylaştırılır ve dolarsa tur bozulmaz.
  ({ items } = await gapPass({ client, modules: COLLECTORS, cfg, scope, now, items, results, state, sites, runInfo, retainDays: L.retainDays, log }));

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
  // Kredi bakiyesi (elle bildirilir): state.balance = { credits, at, fp }. Aynı anahtarla (fp) harcanan her tur düşülür; kalan tahmini günlüğe yazılır.
  // Gerçek bakiye ReefAPI panelindedir; bu yalnızca iki bildirim arasındaki tahmindir.
  let balNote = '';
  const bal = state.balance;
  if (bal && Number.isFinite(bal.credits)) {
    if (client.spent > 0 && (!bal.fp || bal.fp === client.activeFp)) { bal.credits = Math.max(0, bal.credits - client.spent); bal.updated = nowIso; }
    balNote = ` · tahmini kalan ${bal.credits} kredi`;
  }
  if (client.spent > 0 || anyFresh) {
    const keep = Date.parse(nowIso) - 30 * 86400000;
    state.runs = (state.runs || []).filter((r) => Date.parse(r.at) >= keep).concat([{ at: nowIso, credits: client.spent, ok: anyFresh, force: !!force, ...(client.activeFp ? { fp: client.activeFp } : {}), ...(client.activeSlot ? { slot: client.activeSlot } : {}) }]);
    writeJson(statePath, state, 1);
  } else if (keyChanged) writeJson(statePath, state, 1);
  log(`Bitti · bu tur ${client.spent} kredi${balNote} · bugün toplam ${spentToday + client.spent} · ${feed.items.length} kayıt · ${istDay(now, cfg.tz)}`);
  return { feed, wrote, problems, credits: client.spent };
}

async function main() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cfg = readJson(path.join(dir, 'config.json'), null);
  if (!cfg) throw new Error('config.json okunamadı');
  const force = process.argv.includes('--force');
  const dry = process.argv.includes('--dry'); // kuru tur: zamanlama/anahtar sırası denemesi, kredi harcamaz
  // Anahtarlar öncelik sırasıyla: REEFAPI_KEY, REEFAPI_KEY_2 … REEFAPI_KEY_6. Biri biterse/geçersizse sıradaki ile kesintisiz devam edilir.
  const pk = pickKeys(process.env, cfg.keySlots);
  // Gizli kasada tanımlı bütün yuvalar listelenir; keySlots dışında kalanlar "(kapalı)" işaretlenir (anahtar kaybolup kaybolmadığını görmek için).
  const offSlot = (s) => !pk.only && Array.isArray(cfg.keySlots) && cfg.keySlots.length && !cfg.keySlots.map(Number).includes(s);
  console.log('Anahtar parmak izleri: ' + (pickKeys(process.env).entries.map((e) => `${e.slot}=${keyFp(e.k)}${offSlot(e.slot) ? '(kapalı)' : ''}`).join(' ') || 'yok'));
  if (process.argv.includes('--probe')) { // anahtar sınaması: veri yazmaz, sıra/durum dosyasına dokunmaz
    const all = pickKeys(process.env).entries;
    console.log(`Anahtar sınaması: ${all.length} yuva, her biri için 1 kredilik tek istek (keySlots'tan bağımsız).`);
    if (!all.length) console.log('Hiç anahtar tanımlı değil.');
    await probeKeys({ entries: all, cfg });
    return;
  }
  if (process.argv.includes('--detail')) { // ürün detayı kontrolü: veri yazmaz, sıra/durum dosyasına dokunmaz (lib/detail.mjs)
    const ids = parseIds(process.env.DETAIL_IDS);
    if (!ids.length) { console.log('Ürün kodu verilmedi (6-15 haneli Teknosa ürün kodları, virgülle ayrılmış).'); return; }
    if (!pk.entries.length) { console.log('Hiç anahtar tanımlı değil.'); return; }
    console.log(`Ürün detayı kontrolü: ${ids.length} ürün, en çok ${ids.length * 2} kredi.`);
    const dc = createClient({ keys: pk.entries.map((e) => e.k), slots: pk.entries.map((e) => e.slot), maxCredits: ids.length * 2 + 1 });
    await detailCheck({ client: dc, ids });
    console.log(`Bitti · ${dc.spent} kredi harcandı. Veri yazılmadı.`);
    return;
  }
  if (!pk.only && Array.isArray(cfg.keySlots) && cfg.keySlots.length) console.log(`Kullanılan anahtar yuvaları (config.json > keySlots): ${cfg.keySlots.join(', ')} · diğerleri devre dışı.`);
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
