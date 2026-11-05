// Fiyat toplama orkestratörü. GitHub Actions günde 2 kez çalıştırır; uygulama açıldığında HİÇBİR sorgu yapılmaz.
// Çıktı: data/prices.json (uygulamanın okuduğu doğrulanmış dosya) ve data/state.json (günlük sınır kaydı).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from './lib/reef.mjs';
import { readJson, writeJson, istDay, runsToday, mergeItems, flagOutliers } from './lib/store.mjs';
import { validateFeed, CATS } from './lib/validate.mjs';
import * as teknosa from './collectors/teknosa.mjs';
import * as mediamarkt from './collectors/mediamarkt.mjs';
import * as vatan from './collectors/vatan.mjs';

const COLLECTORS = [teknosa, mediamarkt, vatan]; // ucuzdan pahalıya; biri çökse diğerleri etkilenmez
const ORDER = { mediamarkt: 0, teknosa: 1, vatan: 2 };

export const emptyFeed = () => ({ schema: 2, updated: null, cats: [], sites: {}, items: [], run: null });

export async function run({ makeClient, cfg, dir, now = new Date(), force = false, log = console.log }) {
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
  const dayLeft = force ? L.maxCreditsPerRun : L.maxCreditsPerDay - spentToday;
  if (dayLeft <= 0) { log('Günlük kredi sınırı doldu. Sorgu yapılmadı.'); return { skipped: 'kredi-siniri' }; }
  const client = makeClient(Math.min(L.maxCreditsPerRun, dayLeft));

  // 2) Mağaza başına bağımsız toplama
  const scope = cfg.scope.filter((c) => CATS.includes(c));
  const sites = { ...prev.sites };
  let items = prev.items.slice();
  const runInfo = { at: nowIso, stores: {} };
  let anyFresh = false;

  for (const c of COLLECTORS) {
    const sc = cfg.stores[c.STORE] || { enabled: false };
    let res;
    if (c.STORE !== 'vatan' && !sc.enabled) {
      res = { store: c.STORE, status: 'off', items: [], stats: { pages: 0, rows: 0, accepted: 0, rejected: {}, credits: 0 }, error: null, note: 'Kapalı.' };
    } else {
      try { res = await c.collect({ client, cfg: sc, scope, now }); }
      catch (e) {
        res = { store: c.STORE, status: 'error', items: [], stats: { pages: 0, rows: 0, accepted: 0, rejected: {}, credits: 0 }, error: String(e && e.message || e) };
      }
    }
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

  // 3) Aykırı fark işareti, sıralama, doğrulama
  const nOut = flagOutliers(items, L.maxPriceGap);
  if (nOut) log(`${nOut} üründe kanallar arası fark ${L.maxPriceGap}x'ten büyük: 'kontrol gerekli' işaretlendi.`);
  items.sort((a, b) => a.cat.localeCompare(b.cat) || a.label.localeCompare(b.label, 'tr') || ORDER[a.ch] - ORDER[b.ch]);
  const feed = {
    schema: 2,
    updated: anyFresh ? nowIso : prev.updated,
    cats: scope,
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
  if (client.spent > 0 || anyFresh) {
    const keep = Date.parse(nowIso) - 30 * 86400000;
    state.runs = (state.runs || []).filter((r) => Date.parse(r.at) >= keep).concat([{ at: nowIso, credits: client.spent, ok: anyFresh, force: !!force }]);
    writeJson(statePath, state, 1);
  }
  log(`Bitti · bu tur ${client.spent} kredi · bugün toplam ${spentToday + client.spent} · ${feed.items.length} kayıt · ${istDay(now, cfg.tz)}`);
  return { feed, wrote, problems, credits: client.spent };
}

async function main() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cfg = readJson(path.join(dir, 'config.json'), null);
  if (!cfg) throw new Error('config.json okunamadı');
  const force = process.argv.includes('--force');
  const key = process.env.REEFAPI_KEY;
  const out = await run({ makeClient: (max) => createClient({ key, maxCredits: max }), cfg, dir, force });
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
