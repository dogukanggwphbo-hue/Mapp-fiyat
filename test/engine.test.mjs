import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gtinOk, parseVariant, classify, cleanLabel } from '../lib/normalize.mjs';
import { validateItem, validateFeed } from '../lib/validate.mjs';
import { mergeItems, flagOutliers, istDay } from '../lib/store.mjs';
import { createClient, ReefError } from '../lib/reef.mjs';
import * as mmc from '../collectors/mediamarkt.mjs';
import * as tkc from '../collectors/teknosa.mjs';
import { run } from '../collect.mjs';
import { MM, TK, fakeClient } from './fixtures.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fiyat-'));
const T1 = new Date('2026-11-05T03:00:00Z'); // 06:00 TR
const T2 = new Date('2026-11-05T15:00:00Z'); // 18:00 TR
const T3 = new Date('2026-11-05T19:00:00Z'); // 22:00 TR (aynı gün)
const D2 = new Date('2026-11-06T03:00:00Z'); // ertesi gün

function handlerFor({ mm = Object.values(MM), tk = Object.values(TK), fail = {} } = {}) {
  return (engine, params) => {
    if (fail[engine]) throw new ReefError(`${engine}: HTTP 503 test hatası`, { status: 503 });
    if (engine === 'mediamarkt') return { results: mm, max_page: 1, page_count: 1 };
    if (engine === 'teknosa') return { results: tk, total_pages: 1 };
    throw new Error('beklenmeyen motor: ' + engine);
  };
}
const mk = (h, max) => () => fakeClient(h, { max });

test('GTIN doğrulama', () => {
  assert.equal(gtinOk('8806099044916'), true);
  assert.equal(gtinOk('1234567890123'), false);
  assert.equal(gtinOk(''), false);
  assert.equal(gtinOk(null), false);
});

test('varyant ayrıştırma: RAM/depolama/renk/W', () => {
  assert.deepEqual(parseVariant('SAMSUNG Galaxy A57 8/256GB Akıllı Telefon Gri'), { ram: 8, storage: '256GB', color: 'gri', watt: null });
  assert.deepEqual(parseVariant('Samsung Galaxy A27 5G 8GB RAM 256GB Pembe Akıllı Telefon'), { ram: 8, storage: '256GB', color: 'pembe', watt: null });
  assert.equal(parseVariant('SAMSUNG Galaxy S26 Ultra 5G 12/512 GB Akıllı Telefon Kobalt Mor').color, 'kobalt mor');
  assert.equal(parseVariant('SAMSUNG Galaxy S26 Ultra 5G 12/512 GB Akıllı Telefon Kobalt Mor').storage, '512GB');
  assert.equal(parseVariant('Samsung 45W Hızlı Şarj Adaptörü').watt, 45);
});

test('kategori sınıflama', () => {
  assert.equal(classify('Samsung Galaxy S26+ 5G 12/256GB Mor Akıllı Telefon'), 'phone');
  assert.equal(classify('SAMSUNG Galaxy Tab A11 4/64GB Tam Dokunmatik Tablet Gri'), 'tablet');
  assert.equal(classify('Samsung 45W Hızlı Şarj Adaptörü'), 'adapter');
  assert.equal(classify('Samsung Galaxy S26 Ultra Kılıf Siyah'), 'accessory');
  assert.equal(classify('Samsung Galaxy S26 Ultra Ekran Kırılma Sigortası', 'Kurulum, Destek ve Servis Paketleri'), 'service');
  assert.equal(classify('Samsung Galaxy Watch8 44mm Gümüş'), 'wearable');
  assert.equal(cleanLabel('SAMSUNG Galaxy A57 8/256GB Akıllı Telefon Gri', 'SAMSUNG'), 'Galaxy A57 8/256GB Gri');
});

test('MediaMarkt kabul kuralı: yalnızca seller.type=retailer', () => {
  assert.equal(mmc.accept(MM.a57), null);
  assert.equal(mmc.accept(MM.market), 'pazaryeri-satici');
  assert.equal(mmc.accept(MM.wrongName), 'satici-adi-uyusmuyor');
  assert.equal(mmc.accept(MM.refurb), 'yenilenmis');
  assert.equal(mmc.accept(MM.otherBrand), 'marka-samsung-degil');
  assert.equal(mmc.accept({ ...MM.a57, seller: null }), 'satici-bilgisi-yok');
});

test('Teknosa kabul kuralı: yalnızca is_teknosa=true', () => {
  assert.equal(tkc.accept(TK.a57), null);
  assert.equal(tkc.accept(TK.market), 'pazaryeri-satici');
  assert.equal(tkc.accept(TK.marketNamedTeknosa), 'pazaryeri-satici'); // adı TEKNOSA olsa da is_teknosa=false ise alınmaz
  assert.equal(tkc.accept(TK.preo), 'marka-samsung-degil');
  assert.equal(tkc.accept({ ...TK.a57, seller: undefined }), 'satici-bilgisi-yok');
});

test('toplayıcı: yalnız doğrulanmış telefonlar, fiyat türleri ayrı', async () => {
  const c = fakeClient(handlerFor());
  const r = await mmc.collect({ client: c, cfg: CFG.stores.mediamarkt, scope: ['phone'], now: T1 });
  const keys = r.items.map((i) => i.key).sort();
  assert.ok(!r.items.some((i) => i.sellerName !== 'MediaMarkt'));
  assert.ok(keys.includes('8806099044916')); // A57 Gri
  assert.ok(!keys.includes('8806097804215')); // tablet kapsam dışı
  assert.ok(!keys.includes('8806099044787')); // pazaryeri satırı
  assert.equal(r.stats.rejected['pazaryeri-satici'], 1);
  const kinds = r.items.find((i) => i.productId === '9990005');
  assert.equal(kinds.price, 18199);      // karşılaştırılan: herkese açık fiyat
  assert.equal(kinds.listPrice, 19199);  // üstü çizili ayrı
  assert.equal(kinds.appPrice, 17500);   // uygulama fiyatı ayrı
  assert.equal(kinds.memberPrice, 17000); // üyelik fiyatı ayrı
  assert.equal(kinds.priceKind, 'standard');
  const oos = r.items.find((i) => i.productId === '9990006');
  assert.equal(oos.inStock, false);
  const a08 = r.items.find((i) => i.productId === '1257274');
  assert.equal(a08.listPrice, 11799);
  assert.equal(a08.ram, 4); assert.equal(a08.storage, '128GB'); assert.equal(a08.color, 'gümüş');
  assert.ok(r.items.every((i) => validateItem(i) === null));
});

test('Teknosa toplayıcı: marka kodu + seller=teknosa istenir, üye fiyatı ayrı', async () => {
  const c = fakeClient(handlerFor());
  const r = await tkc.collect({ client: c, cfg: CFG.stores.teknosa, scope: ['phone'], now: T1 });
  assert.equal(c.calls[0].params.seller, 'teknosa');
  assert.equal(c.calls[0].params.brand, '2489');
  assert.ok(!r.items.some((i) => i.productId === '5550001' || i.productId === '5550002' || i.productId === '5550003' || i.productId === '5550004'));
  const m = r.items.find((i) => i.productId === '5550005');
  assert.equal(m.price, 77999); assert.equal(m.memberPrice, 74999);
  const a57 = r.items.find((i) => i.productId === '100000062357');
  assert.equal(a57.price, 31999); assert.equal(a57.listPrice, 35499);
});

test('uçtan uca: EAN ile kanallar eşleşir, Vatan hiç sorgulanmaz ve doğrulanamadı görünür', async () => {
  const dir = tmp();
  const h = handlerFor();
  const client = fakeClient(h);
  const out = await run({ makeClient: () => client, cfg: CFG, dir, now: T1, log: () => {} });
  assert.equal(out.wrote, true, JSON.stringify(out.problems));
  assert.ok(!client.calls.some((c) => c.engine === 'vatan'));
  const feed = JSON.parse(fs.readFileSync(path.join(dir, 'data/prices.json'), 'utf8'));
  assert.equal(feed.sites.vatan.status, 'unverified');
  assert.equal(feed.items.filter((i) => i.ch === 'vatan').length, 0);
  const a57 = feed.items.filter((i) => i.key === '8806099044916');
  assert.deepEqual(a57.map((i) => i.ch).sort(), ['mediamarkt', 'teknosa']);
  assert.equal(a57[0].price, 31999);
  assert.deepEqual(feed.cats, ['phone']);
  assert.equal(validateFeed(feed).length, 0);
  assert.equal(feed.items.every((i) => i.verified === true), true);
});

test('fiyat değişimi: prev/since doğru izlenir', async () => {
  const dir = tmp();
  const run1 = handlerFor({ mm: [MM.a57], tk: [TK.a57] });
  await run({ makeClient: mk(run1), cfg: CFG, dir, now: T1, log: () => {} });
  const cheaper = { ...MM.a57, price: 30999 };
  await run({ makeClient: mk(handlerFor({ mm: [cheaper], tk: [TK.a57] })), cfg: CFG, dir, now: T2, log: () => {} });
  let feed = JSON.parse(fs.readFileSync(path.join(dir, 'data/prices.json'), 'utf8'));
  let mmI = feed.items.find((i) => i.ch === 'mediamarkt');
  assert.equal(mmI.price, 30999); assert.equal(mmI.prev, 31999);
  assert.equal(mmI.since, T2.toISOString()); assert.equal(mmI.prevAt, T1.toISOString());
  const tkI = feed.items.find((i) => i.ch === 'teknosa');
  assert.equal(tkI.since, T1.toISOString()); assert.equal(tkI.prev, null); // değişmedi
  await run({ makeClient: mk(handlerFor({ mm: [cheaper], tk: [TK.a57] })), cfg: CFG, dir, now: D2, force: true, log: () => {} });
  feed = JSON.parse(fs.readFileSync(path.join(dir, 'data/prices.json'), 'utf8'));
  mmI = feed.items.find((i) => i.ch === 'mediamarkt');
  assert.equal(mmI.since, T2.toISOString()); // aynı fiyatta değişim tarihi korunur
  assert.equal(mmI.checkedAt, D2.toISOString());
});

test('hata: son başarılı fiyat korunur, durum feed\'de görünür, yanlış veri üretilmez', async () => {
  const dir = tmp();
  await run({ makeClient: mk(handlerFor({ mm: [MM.a57], tk: [TK.a57] })), cfg: CFG, dir, now: T1, log: () => {} });
  const out = await run({ makeClient: mk(handlerFor({ fail: { teknosa: true } })), cfg: CFG, dir, now: T2, log: () => {} });
  const feed = out.feed;
  assert.equal(feed.sites.teknosa.status, 'error');
  assert.equal(feed.sites.teknosa.at, T1.toISOString()); // son başarılı zaman değişmez
  const tkI = feed.items.find((i) => i.ch === 'teknosa');
  assert.equal(tkI.price, 31999);
  assert.equal(tkI.checkedAt, T1.toISOString()); // eski damga: uygulama 'eski veri' diyebilir
  assert.equal(feed.sites.mediamarkt.status, 'ok'); // diğer mağaza etkilenmez
});

test('saklama süresi: 3 günden eski görülmemiş kayıt düşer', async () => {
  const dir = tmp();
  await run({ makeClient: mk(handlerFor({ mm: [MM.a57, MM.a37], tk: [TK.a57] })), cfg: CFG, dir, now: T1, log: () => {} });
  const later = new Date('2026-11-10T03:00:00Z');
  const out = await run({ makeClient: mk(handlerFor({ mm: [MM.a57], tk: [TK.a57] })), cfg: CFG, dir, now: later, log: () => {} });
  assert.ok(!out.feed.items.some((i) => i.key === '8806099054953'));
  assert.ok(out.feed.items.some((i) => i.key === '8806099044916'));
});

test('günlük sınır: günde en fazla 2 tur, ertesi gün yeniden', async () => {
  const dir = tmp();
  const h = handlerFor({ mm: [MM.a57], tk: [TK.a57] });
  const c1 = fakeClient(h), c2 = fakeClient(h), c3 = fakeClient(h), c4 = fakeClient(h);
  await run({ makeClient: () => c1, cfg: CFG, dir, now: T1, log: () => {} });
  await run({ makeClient: () => c2, cfg: CFG, dir, now: T2, log: () => {} });
  const third = await run({ makeClient: () => c3, cfg: CFG, dir, now: T3, log: () => {} });
  assert.equal(third.skipped, 'tur-siniri');
  assert.equal(c3.calls.length, 0); // üçüncü turda API'ye hiç gidilmedi
  assert.ok(c1.calls.length > 0 && c2.calls.length > 0);
  await run({ makeClient: () => c4, cfg: CFG, dir, now: D2, log: () => {} });
  assert.ok(c4.calls.length > 0);
  assert.equal(istDay(new Date('2026-11-05T22:00:00Z'), 'Europe/Istanbul'), '2026-11-06'); // gece yarısı TR saatine göre
});

test('kredi sınırı: tur bütçesini aşmaz (kısmi ve boş sonuç durumları)', async () => {
  // 3 kredi: Teknosa(1) + MediaMarkt 1. sayfa(2) sığar, 2. sayfa sığmaz → kısmi veri
  const two = (engine) => (engine === 'mediamarkt' ? { results: [MM.a57], max_page: 2, page_count: 2 } : { results: [TK.a57], total_pages: 1 });
  const dir = tmp();
  const cfg3 = { ...CFG, limits: { ...CFG.limits, maxCreditsPerRun: 3 } };
  const c3 = fakeClient(two, { max: 3 });
  const o3 = await run({ makeClient: () => c3, cfg: cfg3, dir, now: T1, log: () => {} });
  assert.ok(c3.spent <= 3, 'harcanan ' + c3.spent);
  assert.equal(o3.feed.sites.teknosa.status, 'ok');
  assert.equal(o3.feed.sites.mediamarkt.status, 'partial');
  assert.ok(o3.feed.items.some((i) => i.ch === 'mediamarkt'));
  // 2 kredi: Teknosa(1) sonrası 2 kredilik MediaMarkt çağrısı sığmaz → veri yok, hata görünür, harcama aşılmaz
  const dir2 = tmp();
  const cfg2 = { ...CFG, limits: { ...CFG.limits, maxCreditsPerRun: 2 } };
  const c2 = fakeClient(two, { max: 2 });
  const o2 = await run({ makeClient: () => c2, cfg: cfg2, dir: dir2, now: T1, log: () => {} });
  assert.ok(c2.spent <= 2);
  assert.equal(o2.feed.sites.mediamarkt.status, 'error');
  assert.match(o2.feed.sites.mediamarkt.error, /Kredi sınırı/);
});

test('aykırı fark: kanallar arası >1.5x ise kontrol gerekli', () => {
  const base = { cat: 'phone', inStock: null };
  const items = [
    { ...base, ch: 'mediamarkt', key: 'X', price: 89989 },
    { ...base, ch: 'teknosa', key: 'X', price: 140000 },
    { ...base, ch: 'mediamarkt', key: 'Y', price: 31999 },
    { ...base, ch: 'teknosa', key: 'Y', price: 31999 },
  ];
  assert.equal(flagOutliers(items, 1.5), 1);
  assert.equal(items[0].flag, 'sapma'); assert.equal(items[2].flag, null);
});

test('doğrulama kapısı: doğrulanmamış/pazaryeri/Vatan kayıtları reddedilir', async () => {
  const c = fakeClient(handlerFor());
  const r = await mmc.collect({ client: c, cfg: CFG.stores.mediamarkt, scope: ['phone'], now: T1 });
  const good = r.items[0];
  assert.equal(validateItem(good), null);
  assert.equal(validateItem({ ...good, verified: false }), 'satici-dogrulanmamis');
  assert.equal(validateItem({ ...good, sellerCheck: 'seller.is_teknosa=true' }), 'satici-dogrulanmamis');
  assert.equal(validateItem({ ...good, ch: 'vatan' }), 'kanal-gecersiz');
  assert.equal(validateItem({ ...good, price: 0 }), 'fiyat-gecersiz');
  assert.equal(validateItem({ ...good, url: 'https://baska-site.com/x' }), 'url-gecersiz');
  assert.equal(validateItem({ ...good, priceKind: 'member' }), 'fiyat-turu');
});

test('ReefAPI istemcisi: x-api-key başlığı, gövde biçimi yedeği, anahtar gizleme', async () => {
  const seen = [];
  const key = 'test-' + 'anahtar-123';
  const fetchImpl = async (url, opt) => {
    seen.push({ url, opt });
    const body = JSON.parse(opt.body);
    if (!body.params) return new Response(JSON.stringify({ ok: false, error: { message: 'params gerekli ' + key } }), { status: 422 });
    return new Response(JSON.stringify({ ok: true, data: { results: [] }, meta: { charged_credits: 1 } }), { status: 200 });
  };
  const cl = createClient({ key, fetchImpl, sleep: async () => {} });
  const r = await cl.call('teknosa', 'search', { query: 'x' });
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, 'https://api.reefapi.com/teknosa/v1/search');
  assert.equal(seen[0].opt.headers['x-api-key'], key);
  assert.equal(cl.spent, 1);
  const bad = createClient({ key, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: { message: 'hata ' + key } }), { status: 401 }), sleep: async () => {} });
  await assert.rejects(() => bad.call('teknosa', 'search', {}), (e) => !String(e.message).includes(key) && /401/.test(e.message));
  const nokey = createClient({ key: '', fetchImpl });
  await assert.rejects(() => nokey.call('teknosa', 'search', {}), /REEFAPI_KEY/);
});

test('gizli bilgi: hiçbir proje dosyasında API anahtarı yok', () => {
  const pat = new RegExp('ak_' + 'live_[A-Za-z0-9]{8,}');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (e.name === '.git' ? [] : walk(p)) : [p];
  });
  for (const f of walk(ROOT)) {
    if (/\.(mjs|json|yml|txt|md)$/.test(f)) assert.ok(!pat.test(fs.readFileSync(f, 'utf8')), 'anahtar bulundu: ' + f);
  }
});

test('mergeItems: görülmeyen kayıt retainDays içinde korunur', () => {
  const old = [{ key: 'A', price: 1, since: T1.toISOString(), checkedAt: T1.toISOString() }];
  const out = mergeItems(old, [], T2.toISOString(), 3);
  assert.equal(out.length, 1);
});
