import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gtinOk, parseVariant, classify, cleanLabel, isWebExclusive } from '../lib/normalize.mjs';
import { validateItem, validateFeed } from '../lib/validate.mjs';
import { mergeItems, flagOutliers, istDay } from '../lib/store.mjs';
import { createClient, ReefError, keyFp, keyProblem, isFatal } from '../lib/reef.mjs';
import * as mmc from '../collectors/mediamarkt.mjs';
import * as tkc from '../collectors/teknosa.mjs';
import { run, orderKeys, pickKeys, rotateKeys } from '../collect.mjs';
import { MM, MMX, TK, VT, fakeClient } from './fixtures.mjs';
import * as vtc from '../collectors/vatan.mjs';
import { linkItems, modelParts } from '../lib/link.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fiyat-'));
const T1 = new Date('2026-11-05T03:00:00Z'); // 06:00 TR
const T2 = new Date('2026-11-05T15:00:00Z'); // 18:00 TR
const T3 = new Date('2026-11-05T19:00:00Z'); // 22:00 TR (aynı gün)
const D2 = new Date('2026-11-06T03:00:00Z'); // ertesi gün

function handlerFor({ mm = Object.values(MM), tk = Object.values(TK), vt = [VT.a37, VT.a27, VT.a27pembe, VT.a17, VT.s25fe, VT.outlet, VT.used, VT.otherBrand, VT.badHost], fail = {} } = {}) {
  return (engine, params) => {
    if (fail[engine]) throw new ReefError(`${engine}: HTTP 503 test hatası`, { status: 503 });
    if (engine === 'mediamarkt') return { results: mm, max_page: 1, page_count: 1 };
    if (engine === 'teknosa') return { results: tk, total_pages: 1 };
    if (engine === 'vatan') return { results: vt, total_pages: 1 };
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

test('uçtan uca: EAN ile kanallar eşleşir; Vatan toplanır, sepette fiyatı ayrı kalır, outlet/ikinci el/başka marka alınmaz', async () => {
  const dir = tmp();
  const client = fakeClient(handlerFor());
  const out = await run({ makeClient: () => client, cfg: CFG, dir, now: T1, log: () => {} });
  assert.equal(out.wrote, true, JSON.stringify(out.problems));
  const feed = JSON.parse(fs.readFileSync(path.join(dir, 'data/prices.json'), 'utf8'));
  assert.equal(feed.sites.vatan.status, 'ok');
  const vt = feed.items.filter((i) => i.ch === 'vatan');
  assert.deepEqual(vt.map((i) => i.mpn).sort(), ['SM-A176BZKDTUR', 'SM-A276BLICTUR', 'SM-A276BZKCTUR', 'SM-A376BZAGTUR', 'SM-S731BDBGTUR']);
  const a27 = vt.find((i) => i.mpn === 'SM-A276BZKCTUR');
  assert.equal(a27.price, 21499, 'sepette fiyatı (19779) price olamaz');
  assert.equal(a27.cartPrice, 19779); assert.equal(a27.cartLabel, "Gece'ye özel sepette");
  const a27p = vt.find((i) => i.mpn === 'SM-A276BLICTUR');
  assert.equal(a27p.price, 18999); assert.equal(a27p.listPrice, 21499); assert.equal(a27p.webExclusive, true);
  assert.deepEqual(a27p.tags, ["Web'e Özel"]);
  assert.deepEqual(feed.channels.map((c) => c.id), ['vatan', 'mediamarkt', 'teknosa']);
  assert.equal(feed.catLabels.adapter, 'Adaptör');
  const a57 = feed.items.filter((i) => i.key === '8806099044916');
  assert.deepEqual(a57.map((i) => i.ch).sort(), ['mediamarkt', 'teknosa']);
  assert.equal(a57[0].price, 31999);
  assert.deepEqual(feed.cats, CFG.scope);
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
  const cfg3 = { ...CFG, scope: ['phone'], limits: { ...CFG.limits, maxCreditsPerRun: 3 } };
  const c3 = fakeClient(two, { max: 3 });
  const o3 = await run({ makeClient: () => c3, cfg: cfg3, dir, now: T1, log: () => {} });
  assert.ok(c3.spent <= 3, 'harcanan ' + c3.spent);
  assert.equal(o3.feed.sites.teknosa.status, 'ok');
  assert.equal(o3.feed.sites.mediamarkt.status, 'partial');
  assert.ok(o3.feed.items.some((i) => i.ch === 'mediamarkt'));
  // 2 kredi: Teknosa(1) sonrası 2 kredilik MediaMarkt çağrısı sığmaz → veri yok, hata görünür, harcama aşılmaz
  const dir2 = tmp();
  const cfg2 = { ...CFG, scope: ['phone'], limits: { ...CFG.limits, maxCreditsPerRun: 2 } };
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

test('doğrulama kapısı: doğrulanmamış/pazaryeri/yanlış adresli kayıtlar reddedilir', async () => {
  const c = fakeClient(handlerFor());
  const r = await mmc.collect({ client: c, cfg: CFG.stores.mediamarkt, scope: ['phone'], now: T1 });
  const good = r.items[0];
  assert.equal(validateItem(good), null);
  assert.equal(validateItem({ ...good, verified: false }), 'satici-dogrulanmamis');
  assert.equal(validateItem({ ...good, sellerCheck: 'seller.is_teknosa=true' }), 'satici-dogrulanmamis');
  assert.equal(validateItem({ ...good, ch: 'bilinmeyen' }), 'kanal-gecersiz');
  assert.equal(validateItem({ ...good, ch: 'vatan', sellerCheck: 'site-tek-satici', url: 'https://www.mediamarkt.com.tr/x' }), 'url-gecersiz');
  assert.equal(validateItem({ ...good, ch: 'vatan' }), 'satici-dogrulanmamis', 'MediaMarkt doğrulaması Vatan kaydına uygulanamaz');
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

const KA = 'anahtar-' + 'A-111', KB = 'anahtar-' + 'B-222', KC = 'anahtar-' + 'C-333';
const okRes = () => new Response(JSON.stringify({ ok: true, data: { results: [] }, meta: { charged_credits: 2 } }), { status: 200 });
const errRes = (status, message) => new Response(JSON.stringify({ ok: false, error: { message } }), { status });

test('çoklu anahtar: ilk anahtarın kredisi bitince (402) aynı istek sıradaki anahtarla kesintisiz tekrarlanır', async () => {
  const used = [];
  const fetchImpl = async (url, opt) => {
    const k = opt.headers['x-api-key']; used.push(k);
    return k === KA ? errRes(402, 'Payment required ' + KA) : okRes();
  };
  const cl = createClient({ keys: [KA, KB], fetchImpl, sleep: async () => {} });
  const r = await cl.call('teknosa', 'search', { q: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(used, [KA, KB]);               // aynı istek bir kez A ile denendi, B ile geçti
  assert.equal(cl.keyIndex, 1); assert.equal(cl.spent, 2);
  assert.deepEqual(cl.badKeys.map((b) => [b.fp, b.why, b.persist]), [[keyFp(KA), 'kredi', true]]);
  await cl.call('teknosa', 'search', { q: 2 });   // sonraki istekler doğrudan B ile
  assert.deepEqual(used.slice(2), [KB]);
});

test('çoklu anahtar: kredi mesajlı 429 / geçersiz anahtar (401) de devreder; mesajsız 429 hız sınırıdır, anahtar değişmez', async () => {
  let n = 0;
  const f1 = async (u, o) => (o.headers['x-api-key'] === KA ? errRes(429, 'Monthly quota exceeded') : okRes());
  const c1 = createClient({ keys: [KA, KB], fetchImpl: f1, sleep: async () => {} });
  await c1.call('x', 'y', {}); assert.equal(c1.keyIndex, 1);
  const f2 = async (u, o) => (o.headers['x-api-key'] === KA ? errRes(401, 'Invalid API key') : okRes());
  const c2 = createClient({ keys: [KA, KB], fetchImpl: f2, sleep: async () => {} });
  await c2.call('x', 'y', {}); assert.equal(c2.keyIndex, 1); assert.equal(c2.badKeys[0].why, 'gecersiz');
  const f3 = async () => { n++; return n < 3 ? errRes(429, 'slow down') : okRes(); };
  const c3 = createClient({ keys: [KA, KB], fetchImpl: f3, sleep: async () => {} });
  await c3.call('x', 'y', {}); assert.equal(c3.keyIndex, 0); assert.equal(c3.badKeys.length, 0); assert.equal(n, 3);
});

test('çoklu anahtar: 403 (kalıcı olmayan) sıradaki anahtarı dener ama kalıcı işaretlenmez', async () => {
  const f = async (u, o) => (o.headers['x-api-key'] === KA ? errRes(403, 'forbidden') : okRes());
  const cl = createClient({ keys: [KA, KB], fetchImpl: f, sleep: async () => {} });
  await cl.call('x', 'y', {});
  assert.equal(cl.keyIndex, 1); assert.equal(cl.badKeys[0].persist, false);
});

test('çoklu anahtar: hepsi bitmişse tur durur (ölümcül hata), anahtarlar hata metnine sızmaz, kredi harcanmaz', async () => {
  const calls = [];
  const f = async (u, o) => { calls.push(o.headers['x-api-key']); return errRes(402, 'no credits ' + KA + ' ' + KB); };
  const cl = createClient({ keys: [KA, KB, KC], fetchImpl: f, sleep: async () => {} });
  await assert.rejects(() => cl.call('x', 'y', {}), (e) => e instanceof ReefError && e.status === 402 && e.keyProblem === 'kredi' && isFatal(e) && !e.message.includes(KA) && !e.message.includes(KB));
  assert.deepEqual(calls, [KA, KB, KC]);
  assert.equal(cl.spent, 0); assert.equal(cl.badKeys.length, 3);
});

test('tek anahtar eskisi gibi çalışır; keyProblem sınıflandırması', async () => {
  const cl = createClient({ key: KA, fetchImpl: async () => okRes(), sleep: async () => {} });
  assert.equal((await cl.call('x', 'y', {})).ok, true);
  assert.equal(cl.keyCount, 1);
  assert.equal(keyProblem(402, '').why, 'kredi'); assert.equal(keyProblem(401, 'bad').why, 'gecersiz');
  assert.equal(keyProblem(403, 'x').persist, false); assert.equal(keyProblem(429, 'slow'), null); assert.equal(keyProblem(429, 'Rate limit exceeded'), null); assert.equal(keyProblem(500, 'quota'), null);
  assert.equal(isFatal(new ReefError('x', { status: 402 })), true); assert.equal(isFatal(new ReefError('x', { status: 429 })), false);
});

test('anahtar sırası: son 24 saatte kredisi biten anahtar sona alınır, 24 saat sonra eski önceliğine döner; hepsi işaretliyse hepsi denenir', () => {
  const now = new Date('2026-11-07T10:00:00Z');
  const st = { badKeys: { [keyFp(KA)]: { at: '2026-11-07T06:00:00Z', why: 'kredi' } } };
  assert.deepEqual(orderKeys([KA, KB], st, now), [KB, KA]);
  assert.deepEqual(orderKeys([KA, KB], { badKeys: { [keyFp(KA)]: { at: '2026-11-06T06:00:00Z', why: 'kredi' } } }, now), [KA, KB]);
  assert.deepEqual(orderKeys([KA, KB], { badKeys: { [keyFp(KA)]: { at: '2026-11-07T06:00:00Z' }, [keyFp(KB)]: { at: '2026-11-07T07:00:00Z' } } }, now), [KA, KB]);
  assert.deepEqual(orderKeys([KA], {}, now), [KA]); assert.deepEqual(orderKeys([], null, now), []);
});

test('anahtar seçimi: normal sırada 1,2,3; REEFAPI_ONLY=2 yalnızca 2. anahtarı kullanır (yedeğe geçmez); yuva boşsa eksik bildirilir', () => {
  const env = { REEFAPI_KEY: KA, REEFAPI_KEY_2: KB, REEFAPI_KEY_3: '' };
  assert.deepEqual(pickKeys(env).entries, [{ k: KA, slot: 1 }, { k: KB, slot: 2 }]);
  assert.deepEqual(pickKeys({ ...env, REEFAPI_ONLY: '2' }), { entries: [{ k: KB, slot: 2 }], only: 2, missing: false });
  assert.deepEqual(pickKeys({ ...env, REEFAPI_ONLY: '3' }), { entries: [], only: 3, missing: true });
  assert.equal(pickKeys({ ...env, REEFAPI_ONLY: '' }).only, 0); assert.equal(pickKeys({ ...env, REEFAPI_ONLY: 'auto' }).only, 0);
  assert.deepEqual(pickKeys({ REEFAPI_KEY: KA, REEFAPI_KEY_2: KA }).entries, [{ k: KA, slot: 1 }], 'aynı anahtar iki kez eklenirse tek sayılır');
  const cl = createClient({ keys: [KB, KA], slots: [2, 1], fetchImpl: async () => okRes(), sleep: async () => {} });
  assert.equal(cl.activeSlot, 2);
});

test('sıralı dönüş: her turda sıradaki anahtar öncelikli (1→2→3→1); deneme (force) turları sırayı bozmaz; kredisi biten anahtar atlanır, kalanlar kendi aralarında döner', () => {
  const E3 = [{ k: KA, slot: 1 }, { k: KB, slot: 2 }, { k: KC, slot: 3 }];
  const slots = (es) => es.map((e) => e.slot);
  const R = (at, slot, force = false) => ({ at, credits: 80, ok: true, force, slot });
  const FROM = '2026-11-08T00:00:00+03:00';
  // başlangıç: dönüş tarihinden önceki turlar sayılmaz → 1. anahtarla başlar
  assert.deepEqual(slots(rotateKeys(E3, { runs: [R('2026-11-07T11:03:00Z', 1)] }, FROM)), [1, 2, 3]);
  assert.deepEqual(slots(rotateKeys(E3, { runs: [] }, FROM)), [1, 2, 3]);
  assert.deepEqual(slots(rotateKeys(E3, null, FROM)), [1, 2, 3]);
  // 8 Kasım 10:30 → 1; 16:30 → 2; 9 Kasım 10:30 → 3; 16:30 → 1 …
  let runs = [];
  const seq = [];
  for (const at of ['2026-11-08T07:30:00Z', '2026-11-08T13:30:00Z', '2026-11-09T07:30:00Z', '2026-11-09T13:30:00Z', '2026-11-10T07:30:00Z']) {
    const order = rotateKeys(E3, { runs }, FROM); seq.push(order[0].slot);
    runs = runs.concat([R(at, order[0].slot)]);
  }
  assert.deepEqual(seq, [1, 2, 3, 1, 2]);
  // yedek: önce öncelikli, sonra sıradakiler (3. önde ise 3,1,2)
  assert.deepEqual(slots(rotateKeys(E3, { runs: [R('2026-11-08T13:30:00Z', 2)] }, FROM)), [3, 1, 2]);
  // elle deneme turu (force) ve yuvasız eski kayıtlar sırayı değiştirmez
  assert.deepEqual(slots(rotateKeys(E3, { runs: [R('2026-11-08T07:30:00Z', 1), R('2026-11-08T09:00:00Z', 3, true), { at: '2026-11-08T10:00:00Z', ok: true, force: false }] }, FROM)), [2, 3, 1]);
  // yedeğe düşen tur: tur 2. anahtarla bittiyse sıradaki 3. olur
  assert.deepEqual(slots(rotateKeys(E3, { runs: [R('2026-11-08T07:30:00Z', 2)] }, FROM)), [3, 1, 2]);
  // seyrek yuvalar (1 ve 3) ve tek anahtar
  const E13 = [{ k: KA, slot: 1 }, { k: KC, slot: 3 }];
  assert.deepEqual(slots(rotateKeys(E13, { runs: [R('2026-11-08T07:30:00Z', 1)] }, FROM)), [3, 1]);
  assert.deepEqual(slots(rotateKeys(E13, { runs: [R('2026-11-08T07:30:00Z', 3)] }, FROM)), [1, 3]);
  assert.deepEqual(slots(rotateKeys([{ k: KB, slot: 2 }], { runs: [R('2026-11-08T07:30:00Z', 2)] }, FROM)), [2]);
  // 2. anahtarın kredisi bitti (işaretli): sıra 2'ye gelse bile 3 ve 1 kendi aralarında döner, 2 en sona kalır
  const bad = { badKeys: { [keyFp(KB)]: { at: '2026-11-08T07:31:00Z', why: 'kredi' } } };
  const now = new Date('2026-11-08T13:30:00Z');
  const pick = (runs) => { const o = rotateKeys(E3, { runs }, FROM); return orderKeys(o.map((e) => e.k), bad, now).map((k) => o.find((e) => e.k === k).slot); };
  assert.deepEqual(pick([R('2026-11-08T07:30:00Z', 1)]), [3, 1, 2]);   // sıra 2'de ama 2 bitik → 3 öncelikli
  assert.deepEqual(pick([R('2026-11-08T13:30:00Z', 3)]), [1, 3, 2]);
  assert.deepEqual(pick([R('2026-11-08T13:30:00Z', 1)]), [3, 1, 2]);
  // iki anahtar bitik → kalan tek anahtar kullanılır, bitikler yedekte sona alınır
  const bad2 = { badKeys: { [keyFp(KA)]: { at: '2026-11-08T07:31:00Z' }, [keyFp(KB)]: { at: '2026-11-08T07:31:00Z' } } };
  const o3 = rotateKeys(E3, { runs: [R('2026-11-08T07:30:00Z', 3)] }, FROM);
  assert.equal(orderKeys(o3.map((e) => e.k), bad2, now)[0], KC);
});

test('kuru tur (--dry): sınırlara uyar, kredi harcamaz, hiçbir sorgu yapmaz, dosya yazmaz; günlük sınır dolmuşsa normal gibi atlar', async () => {
  const dir = tmp();
  const fc = fakeClient(handlerFor());
  const logs = [];
  const out = await run({ makeClient: () => fc, cfg: CFG, dir, now: T1, dry: true, log: (m) => logs.push(m) });
  assert.equal(out.dry, true); assert.equal(fc.calls.length, 0);
  assert.ok(logs.some((m) => /KURU TUR/.test(m)));
  assert.ok(!fs.existsSync(path.join(dir, 'data/prices.json')) && !fs.existsSync(path.join(dir, 'data/state.json')), 'kuru tur kayıt bırakmaz');
  // günlük sınır dolu: kuru tur da atlar
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/state.json'), JSON.stringify({ runs: [{ at: '2026-11-05T03:30:00Z', credits: 80, ok: true, force: false }, { at: '2026-11-05T11:30:00Z', credits: 80, ok: true, force: false }] }));
  const out2 = await run({ makeClient: () => fc, cfg: CFG, dir, now: new Date('2026-11-05T12:00:00Z'), dry: true, log: () => {} });
  assert.equal(out2.skipped, 'tur-siniri'); assert.equal(fc.calls.length, 0);
});

test('uçtan uca: anahtar bitince tur yedek anahtarla sürer; işaret durum dosyasına parmak iziyle yazılır; anahtarın kendisi hiçbir dosyaya yazılmaz', async () => {
  const dir = tmp();
  const inner = fakeClient(handlerFor());
  let seenState = null;
  const client = Object.assign(Object.create(inner), {
    get badKeys() { return [{ fp: keyFp(KA), why: 'kredi', persist: true, status: 402 }]; },
    get keyIndex() { return 1; },
    get activeFp() { return keyFp(KB); },
  });
  const logs = [];
  const out = await run({ makeClient: (max, state) => { seenState = state; return client; }, cfg: CFG, dir, now: T1, log: (m) => logs.push(m) });
  assert.equal(out.wrote, true, JSON.stringify(out.problems));
  assert.ok(seenState && Array.isArray(seenState.runs), 'makeClient durumu alır');
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'data/state.json'), 'utf8'));
  assert.equal(st.badKeys[keyFp(KA)].why, 'kredi');
  assert.ok(logs.some((m) => /kredisi bitti/.test(m) && /2\. anahtarla sürdürüldü/.test(m)));
  for (const f of ['data/state.json', 'data/prices.json']) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(KA));
  // sonraki turda çalışan anahtarın işareti kalkar (A yeniden yenilenmiş ve A ile çalışıldıysa)
  const client2 = Object.assign(Object.create(fakeClient(handlerFor())), { get badKeys() { return []; }, get keyIndex() { return 0; }, get activeFp() { return keyFp(KA); } });
  await run({ makeClient: () => client2, cfg: CFG, dir, now: new Date(T1.getTime() + 8 * 3600e3), force: true, log: () => {} });
  const st2 = JSON.parse(fs.readFileSync(path.join(dir, 'data/state.json'), 'utf8'));
  assert.ok(!st2.badKeys, 'çalışan anahtarın kredi işareti temizlendi');
});

test('kredi bakiyesi: state.balance aynı anahtarla harcanan turda düşer, başka anahtarla düşmez; kuru turda dokunulmaz; günlüğe tahmini kalan yazılır', async () => {
  const dir = tmp();
  const sp = path.join(dir, 'data/state.json');
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({ runs: [], balance: { credits: 1000, at: T1.toISOString(), fp: keyFp(KA) } }));
  const mk = (fp) => Object.assign(Object.create(fakeClient(handlerFor())), { get badKeys() { return []; }, get keyIndex() { return 0; }, get activeFp() { return fp; } });
  const logs = [];
  await run({ makeClient: () => mk(keyFp(KB)), cfg: CFG, dir, now: T1, force: true, log: (m) => logs.push(m) });
  assert.equal(JSON.parse(fs.readFileSync(sp, 'utf8')).balance.credits, 1000, 'başka anahtarla harcandı: düşülmez');
  const c = mk(keyFp(KA));
  await run({ makeClient: () => c, cfg: CFG, dir, now: new Date(T1.getTime() + 8 * 3600e3), force: true, log: (m) => logs.push(m) });
  assert.ok(c.spent > 0);
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(st.balance.credits, 1000 - c.spent);
  assert.equal(st.balance.fp, keyFp(KA));
  assert.ok(logs.some((m) => new RegExp(`tahmini kalan ${1000 - c.spent} kredi`).test(m)));
  const before = fs.readFileSync(sp, 'utf8');
  await run({ makeClient: () => mk(keyFp(KA)), cfg: CFG, dir, now: new Date(T1.getTime() + 20 * 3600e3), force: true, dry: true, log: () => {} });
  assert.equal(fs.readFileSync(sp, 'utf8'), before, 'kuru tur durum dosyasını değiştirmez');
});

test('sayfalama: yalnızca pazaryeri satırlarından oluşan sayfa taramayı bitirmez', async () => {
  const mp = (n) => ({ ...MM.market, product_id: 'mp' + n, ean: '', title: `SAMSUNG Galaxy A57 8/256GB Akıllı Telefon Mor ${n}`, url: `https://www.mediamarkt.com.tr/tr/product/_mp-${n}.html` });
  const pages = { 1: [mp(1), mp(2), mp(3)], 2: [MM.a57, MM.a37] };
  const c = fakeClient((engine, params) => ({ results: pages[params.page] || [], max_page: 2, page_count: 2 }));
  const r = await mmc.collect({ client: c, cfg: CFG.stores.mediamarkt, scope: ['phone'], now: T1 });
  assert.equal(c.calls.length, 2);                 // 1. sayfa tamamen pazaryeri olsa da 2. sayfaya geçildi
  assert.equal(r.items.length, 2);
  assert.equal(r.stats.rejected['pazaryeri-satici'], 3);
});

test('sayfa sınırı: aşılırsa uyarı notu düşer, veri yine de doğrulanmış kalır', async () => {
  const c = fakeClient(() => ({ results: [MM.a57], max_page: 5, page_count: 5 }));
  const cfg = { ...CFG.stores.mediamarkt, queries: [{ q: 'x', scope: 'phone', maxPages: 1 }] };
  const r = await mmc.collect({ client: c, cfg, scope: ['phone'], now: T1 });
  assert.equal(r.status, 'ok');
  assert.match(r.note, /Sayfa sınırı/);
  assert.equal(c.calls.length, 1);
});

test('Teknosa telefonları kategori sayfasından, seller=teknosa ve marka koduyla çekilir', async () => {
  const c = fakeClient(handlerFor());
  await tkc.collect({ client: c, cfg: CFG.stores.teknosa, scope: ['phone'], now: T1 });
  assert.equal(c.calls[0].params.category, 'cep-telefonu-c-100001');
  assert.equal(c.calls[0].params.query, undefined);
  assert.equal(c.calls[0].params.seller, 'teknosa');
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

test("Web'e Özel rozeti algılanır; sepet/çok satan rozetleri Web'e Özel sayılmaz", () => {
  assert.equal(isWebExclusive(["Web'e Özel"]), true);
  assert.equal(isWebExclusive(['Çok Satanlar', 'İnternete Özel']), true);
  assert.equal(isWebExclusive(["Online'a özel"]), true);
  assert.equal(isWebExclusive(['Çok Satanlar']), false);
  assert.equal(isWebExclusive(['2000 TL üzeri alışverişte sepette indirim']), false);
  assert.equal(isWebExclusive(null), false);
  assert.equal(isWebExclusive([]), false);
});

test("MediaMarkt: Web'e Özel işaretlenir, sepet fiyatı normal fiyattan ayrılır, belirsiz sepet fiyatı alınmaz", async () => {
  const c = fakeClient(handlerFor({ mm: [MMX.webTab, MMX.cartTab, MMX.cartUnknown, MMX.cartSame] }));
  const r = await mmc.collect({ client: c, cfg: CFG.stores.mediamarkt, scope: ['tablet'], now: T1 });
  const by = (id) => r.items.find((i) => i.productId === id);
  assert.equal(by('1250156').webExclusive, true);
  assert.equal(by('1250156').price, 5489);
  assert.equal(by('1250156').listPrice, 5499);
  const cart = by('1246250');
  assert.equal(cart.price, 38999, 'raf fiyatı taksit toplamından alınır');
  assert.equal(cart.cartPrice, 37049.05, 'sepet fiyatı ayrı alanda');
  assert.equal(cart.webExclusive, false);
  assert.equal(by('9990101'), undefined, 'raf fiyatı belirlenemeyen ürün alınmaz');
  assert.equal(r.stats.rejected['sepet-fiyati-belirsiz'], 1);
  const same = by('9990102');
  assert.equal(same.price, 13999); assert.equal(same.cartPrice, null);
  assert.equal(r.items.every((i) => i.priceKind === 'standard' && i.verified), true);
});

test("Teknosa: Web'e Özel rozeti işaretlenir", async () => {
  const web = { ...TK.a37, product_id: '100000099001', badges: ["Web'e Özel"], url: TK.a37.url.replace('100000062355', '100000099001') };
  const c = fakeClient(handlerFor({ tk: [web, TK.a57] }));
  const r = await tkc.collect({ client: c, cfg: CFG.stores.teknosa, scope: ['phone'], now: T1 });
  assert.equal(r.items.find((i) => i.productId === '100000099001').webExclusive, true);
  assert.equal(r.items.find((i) => i.productId === '100000062357').webExclusive, false);
});

test('kapsam: telefon + tablet + giyilebilir + adaptör; en kötü durum kredi harcaması sınırları aşmaz', () => {
  assert.deepEqual(CFG.scope, ['phone', 'tablet', 'wearable', 'adapter']);
  let worst = 0;
  for (const st of Object.values(CFG.stores)) {
    if (!st.enabled) continue;
    for (const q of st.queries) if (CFG.scope.includes(q.scope)) worst += q.maxPages * st.creditsPerCall;
  }
  assert.ok(worst <= CFG.limits.maxCreditsPerRun, `en kötü tur ${worst} > ${CFG.limits.maxCreditsPerRun}`);
  assert.ok(worst * CFG.limits.maxRunsPerDay <= CFG.limits.maxCreditsPerDay, `en kötü gün ${worst * CFG.limits.maxRunsPerDay}`);
});

test('uçtan uca: tablet kaydı Web\'e Özel alanıyla yayına girer ve doğrulamadan geçer', async () => {
  const dir = tmp();
  const out = await run({ makeClient: mk(handlerFor({ mm: [MMX.webTab, MMX.cartTab, MM.a57], tk: [TK.a57] })), cfg: CFG, dir, now: T1, log: () => {} });
  assert.equal(out.wrote, true, JSON.stringify(out.problems));
  const feed = JSON.parse(fs.readFileSync(path.join(dir, 'data/prices.json'), 'utf8'));
  const t = feed.items.find((i) => i.ch === 'mediamarkt' && i.productId === '1250156');
  assert.equal(t.cat, 'tablet'); assert.equal(t.webExclusive, true);
  assert.equal(validateFeed(feed).length, 0);
});

test('boş arama sonucu mağazayı durdurmaz: sonraki aramalar çalışır, not düşer, durum ok (MediaMarkt)', async () => {
  const empty = 'samsung kulaklık';
  const base = handlerFor({ mm: [MM.a57, MMX.webTab] });
  const h = (engine, params) => {
    if (engine === 'mediamarkt' && params.query === empty) throw new ReefError("mediamarkt/search: HTTP 200 www.mediamarkt.com.tr answered 'samsung galaxy buds' with a page that carries no product listing (https://x)", { status: 200 });
    return base(engine, params);
  };
  const c = fakeClient(h);
  const r = await mmc.collect({ client: c, cfg: CFG.stores.mediamarkt, scope: CFG.scope, now: T1 });
  assert.equal(r.status, 'ok');
  assert.ok(r.items.length >= 2);
  assert.ok(c.calls.some((x) => x.params.query === 'samsung şarj adaptörü'), 'kulaklık araması boş dönse de adaptör araması yapılmalı');
  assert.match(r.note, /samsung kulaklık/);
});

test('boş arama sonucu mağazayı durdurmaz (Teknosa)', async () => {
  const base = handlerFor({ tk: [TK.a57, TK.a37] });
  const h = (engine, params) => {
    if (params.category === '100004001') throw new ReefError('teknosa/search: HTTP 200 teknosa.com answered a page without a product grid', { status: 200 });
    return base(engine, params);
  };
  const c = fakeClient(h);
  const r = await tkc.collect({ client: c, cfg: CFG.stores.teknosa, scope: CFG.scope, now: T1 });
  assert.equal(r.status, 'ok');
  assert.equal(r.items.length, 2);
  assert.ok(c.calls.some((x) => x.params.category === '100002003'), 'saat kategorisi boş dönse de şarj aleti kategorisi taranmalı');
  assert.match(r.note, /100004001/);
});

test('Teknosa saat / kulaklık / şarj aletleri KATEGORİ kodundan çekilir (anahtar kelime telefonları öne çıkarır)', async () => {
  const c = fakeClient(handlerFor({ tk: [TK.a57] }));
  await tkc.collect({ client: c, cfg: CFG.stores.teknosa, scope: CFG.scope, now: T1 });
  for (const code of ['100004001', '10000601', '100002003']) {
    const call = c.calls.find((x) => x.params.category === code);
    assert.ok(call, 'kategori sorgulanmalı: ' + code);
    assert.equal(call.params.seller, 'teknosa'); assert.equal(call.params.brand, '2489');
  }
});

test('Teknosa tabletleri tablet KATEGORİSİNDEN çekilir; anahtar kelime aramalarında "samsung" geçmez (telefonlar öne geçer)', async () => {
  const c = fakeClient(handlerFor({ tk: [TK.a57] }));
  await tkc.collect({ client: c, cfg: CFG.stores.teknosa, scope: CFG.scope, now: T1 });
  const tab = c.calls.find((x) => x.params.category === '116012');
  assert.ok(tab, 'tablet kategorisi sorgulanmalı');
  assert.equal(tab.params.seller, 'teknosa'); assert.equal(tab.params.brand, '2489');
  for (const x of c.calls) if (x.params.query) assert.ok(!/samsung/i.test(x.params.query), 'Teknosa anahtar kelimesinde samsung olmamalı: ' + x.params.query);
});

test('geçici hata tek aramayı düşürür, diğerleri sürer (partial); yetki hatası ise her şeyi durdurur', async () => {
  const base = handlerFor({ mm: [MM.a57] });
  const soft = (engine, params) => {
    if (params.query === 'samsung galaxy tab tablet') throw new ReefError('mediamarkt/search: HTTP 503 test', { status: 503 });
    return base(engine, params);
  };
  const c1 = fakeClient(soft);
  const r1 = await mmc.collect({ client: c1, cfg: CFG.stores.mediamarkt, scope: CFG.scope, now: T1 });
  assert.equal(r1.status, 'partial');
  assert.ok(r1.items.some((i) => i.productId === '1253247'));
  assert.ok(c1.calls.some((x) => x.params.query === 'samsung şarj adaptörü'));
  const c2 = fakeClient(() => { throw new ReefError('mediamarkt/search: HTTP 401 geçersiz anahtar', { status: 401 }); });
  const r2 = await mmc.collect({ client: c2, cfg: CFG.stores.mediamarkt, scope: CFG.scope, now: T1 });
  assert.equal(r2.status, 'error');
  assert.equal(c2.calls.length, 1, 'yetki hatasında ikinci arama yapılmamalı');
});

test('sayfalama yalnızca aramanın kendi kategorisine bakar: telefon araması tablet sayfalarında durur (kredi israfı yok)', async () => {
  const h = (engine, params) => (params.page === 1 ? { results: [MM.a57], max_page: 9 } : { results: [MMX.webTab], max_page: 9 });
  const c = fakeClient(h);
  const cfg = { ...CFG.stores.mediamarkt, queries: [{ q: 'telefon', scope: 'phone', maxPages: 16 }] };
  await mmc.collect({ client: c, cfg, scope: ['phone', 'tablet'], now: T1 });
  assert.equal(c.calls.length, 2);
});

// ---------- Vatan ----------
test('Vatan kabul kuralı: Samsung + stokta + vatanbilgisayar.com; outlet/yenilenmiş/başka marka/yanlış adres reddedilir', () => {
  assert.equal(vtc.accept(VT.a37), null);
  assert.equal(vtc.accept(VT.outlet), 'outlet-ikinci-el');
  assert.equal(vtc.accept(VT.used), 'outlet-ikinci-el');
  assert.equal(vtc.accept(VT.otherBrand), 'marka-samsung-degil');
  assert.equal(vtc.accept(VT.badHost), 'url-gecersiz');
  assert.equal(vtc.accept({ ...VT.a37, price: 0 }), 'fiyat-yok');
});

test('Vatan toplayıcı: fiyat = çevrimiçi fiyat; sepette fiyatı ayrı; Web\'e Özel etiketli; yalnızca stoktakiler istenir', async () => {
  const c = fakeClient(handlerFor());
  const r = await vtc.collect({ client: c, cfg: CFG.stores.vatan, scope: ['phone'], now: T1 });
  assert.equal(r.status, 'ok');
  assert.ok(c.calls.every((x) => x.engine === 'vatan' && x.params.brand === 'samsung' && x.params.in_stock_only === true));
  const by = Object.fromEntries(r.items.map((i) => [i.mpn, i]));
  assert.equal(by['SM-A376BZAGTUR'].price, 26999);
  assert.equal(by['SM-A376BZAGTUR'].cartPrice, 24839);
  assert.equal(by['SM-A376BZAGTUR'].webExclusive, false);
  assert.equal(by['SM-A276BLICTUR'].webExclusive, true);
  assert.equal(by['SM-A276BLICTUR'].listPrice, 21499);
  assert.equal(by['SM-A276BLICTUR'].price, 18999);
  assert.equal(by['SM-A176BZKDTUR'].cartPrice, null);
  assert.ok(!by['SM-OUT000001'] && !by['SM-USED00001'] && !by['MYE23TU/A'] && !by['SM-HOST00001']);
  assert.ok(r.items.every((i) => i.ean === null && i.ownKey && i.sellerCheck === 'site-tek-satici' && i.verified === true));
});

test('Vatan: boş arama sonucu aramayı atlar, yetki hatası mağazayı durdurur', async () => {
  const base = handlerFor();
  const c1 = fakeClient((e, p) => {
    if (p.query === 'tablet') throw new ReefError('vatan/search: HTTP 200 vatanbilgisayar.com answered a page without a product grid', { status: 200 });
    return base(e, p);
  });
  const r1 = await vtc.collect({ client: c1, cfg: CFG.stores.vatan, scope: CFG.scope, now: T1 });
  assert.equal(r1.status, 'ok');
  assert.match(r1.note, /tablet/);
  assert.ok(c1.calls.some((x) => x.params.query === 'şarj adaptörü'));
  const c2 = fakeClient(() => { throw new ReefError('vatan/search: HTTP 403 yetki', { status: 403 }); });
  const r2 = await vtc.collect({ client: c2, cfg: CFG.stores.vatan, scope: CFG.scope, now: T1 });
  assert.equal(r2.status, 'error');
  assert.equal(c2.calls.length, 1);
});

// ---------- kanallar arası eşleştirme ----------
const ean = (o) => ({ ch: 'mediamarkt', key: o.ean, ownKey: null, match: 'ean', ram: null, storage: null, color: null, mpn: null, name: o.label, ...o });
const loose = (o) => ({ ch: 'vatan', ean: null, key: 'v:' + o.mpn.toLowerCase(), ownKey: 'v:' + o.mpn.toLowerCase(), match: 'baslik', name: o.label, ram: 8, storage: '256GB', ...o });

test('eşleştirme: model adı özetinden renk/depolama/RAM/kod atılır', () => {
  // 5G bağlantı bilgisi modelden ayrı bir bayraktır (features().g5); model adı yalın kalır
  assert.deepEqual(modelParts('Galaxy A27 5G 8/256 GB Akıllı Telefon Açık Pembe'), { model: 'a27', color: 'acik pembe' });
  assert.deepEqual(modelParts('Samsung Galaxy S25 FE 5G 8/256 Gb Lacivert SM-S731BDBGTUR'), { model: 's25fe', color: 'lacivert' });
});

test('eşleştirme: uzun model kodu tek EAN grubunda geçiyorsa bağlanır', () => {
  const a = ean({ ean: '8806099111111', cat: 'tablet', label: 'Galaxy Tab S10 FE+ Tablet', name: 'Samsung Galaxy Tab S10 FE+ (SM-X620NZSPTU) 12/256 GB', ram: 12, storage: '256GB' });
  const v = loose({ cat: 'tablet', label: 'Galaxy Tab S10 FE+ Tablet', mpn: 'SM-X620NZSPTU', ram: null, storage: null });
  assert.equal(linkItems([a, v]), 1);
  assert.equal(v.key, a.key); assert.equal(v.match, 'model'); assert.equal(v.ownKey, 'v:sm-x620nzsptu');
});

test('eşleştirme: birebir model+depolama+renk eşitliği bağlar; farklı renk/depolama/RAM bağlamaz', () => {
  const a = ean({ ean: '8806099222222', cat: 'phone', label: 'Galaxy A27 5G 8/256 GB Siyah', ram: 8, storage: '256GB' });
  const same = loose({ cat: 'phone', label: 'Galaxy A27 5G 8/256 GB Akıllı Telefon Siyah', mpn: 'SM-A276BZKCTUR' });
  const color = loose({ cat: 'phone', label: 'Galaxy A27 5G 8/256 GB Akıllı Telefon Açık Pembe', mpn: 'SM-A276BLICTUR' });
  const stor = loose({ cat: 'phone', label: 'Galaxy A27 5G 8/128 GB Akıllı Telefon Siyah', mpn: 'SM-A276BZKBTUR', storage: '128GB' });
  const ram = loose({ cat: 'phone', label: 'Galaxy A27 5G 12/256 GB Akıllı Telefon Siyah', mpn: 'SM-A276BZKDTUR', ram: 12 });
  assert.equal(linkItems([a, same, color, stor, ram]), 1);
  assert.equal(same.key, a.key);
  for (const x of [color, stor, ram]) { assert.equal(x.key, x.ownKey); assert.equal(x.match, 'baslik'); }
});

test('eşleştirme: belirsizlikte bağlanmaz (aynı kanalda iki aday; kanal zaten o ürünü taşıyor); farklı kanaldaki aynı özellikli kayıtlar bağlanır', () => {
  // farklı barkodlu ama marka/model/hafıza/renk aynı ve kanallar ayrık -> tek satır
  const a1 = ean({ ean: '8806099333331', cat: 'phone', label: 'Galaxy A27 5G 8/256 GB Siyah', ram: 8, storage: '256GB' });
  const a2 = ean({ ean: '8806099333332', cat: 'phone', label: 'Galaxy A27 5G 8/256 GB Siyah', ram: 8, storage: '256GB', ch: 'teknosa' });
  const v1 = loose({ cat: 'phone', label: 'Galaxy A27 5G 8/256 GB Siyah', mpn: 'SM-A276BZKCTUR' });
  assert.equal(linkItems([a1, a2, v1]), 2);
  assert.ok(a1.key === a2.key && a2.key === v1.key);
  const b = ean({ ean: '8806099444441', cat: 'phone', label: 'Galaxy A37 5G 8/256 GB Antrasit', ram: 8, storage: '256GB' });
  const w1 = loose({ cat: 'phone', label: 'Galaxy A37 5G 8/256 GB Antrasit', mpn: 'SM-A376BZAGTUR' });
  const w2 = loose({ cat: 'phone', label: 'Galaxy A37 5G 8/256 GB Antrasit Akıllı Telefon', mpn: 'SM-A376BZAHTUR' });
  assert.equal(linkItems([b, w1, w2]), 0, 'aynı kanalda iki aday: ikisi de bağlanmaz');
  const c = ean({ ean: '8806099555551', cat: 'phone', label: 'Galaxy S25 FE 5G 8/256 GB Lacivert', ram: 8, storage: '256GB' });
  const own = ean({ ean: '8806099555551', ch: 'vatan', cat: 'phone', label: 'Galaxy S25 FE 5G 8/256 GB Lacivert', ram: 8, storage: '256GB' });
  const x = loose({ cat: 'phone', label: 'Galaxy S25 FE 5G 8/256 GB Lacivert', mpn: 'SM-S731BDBGTUR' });
  assert.equal(linkItems([c, own, x]), 0, 'Vatan zaten bu ürünü EAN ile taşıyor');
});

test('eşleştirme: tekrar çalıştırmak idempotent; bağ koparsa kayıt kendi kimliğine döner', () => {
  const a = ean({ ean: '8806099666661', cat: 'phone', label: 'Galaxy A27 5G 8/256 GB Siyah', ram: 8, storage: '256GB' });
  const v = loose({ cat: 'phone', label: 'Galaxy A27 5G 8/256 GB Siyah', mpn: 'SM-A276BZKCTUR' });
  assert.equal(linkItems([a, v]), 1);
  assert.equal(linkItems([a, v]), 1);
  assert.equal(v.key, a.key);
  assert.equal(linkItems([v]), 0);
  assert.equal(v.key, v.ownKey); assert.equal(v.match, 'baslik');
});

test('uçtan uca: Vatan kaydı MediaMarkt/Teknosa ile aynı gruba bağlanırsa tek satırda karşılaştırılır', async () => {
  const dir = tmp();
  // MM A37 Antrasit 8/256 ile aynı ürünün Vatan kaydı
  const out = await run({ makeClient: mk(handlerFor()), cfg: CFG, dir, now: T1, log: () => {} });
  assert.equal(out.wrote, true, JSON.stringify(out.problems));
  const feed = JSON.parse(fs.readFileSync(path.join(dir, 'data/prices.json'), 'utf8'));
  const groups = new Map();
  for (const i of feed.items) { if (!groups.has(i.key)) groups.set(i.key, new Set()); groups.get(i.key).add(i.ch); }
  for (const [k, set] of groups) assert.ok([...set].length === set.size && [...set].every((c) => ['vatan', 'mediamarkt', 'teknosa'].includes(c)), k);
  // hiçbir grupta bir kanal iki kez yer almaz
  const seen = new Set();
  for (const i of feed.items) { const id = i.ch + '|' + i.key; assert.ok(!seen.has(id), 'yinelenen: ' + id); seen.add(id); }
  assert.ok(feed.sites.vatan.count > 0);
});

test('kredi tavanı (Vatan dâhil): en kötü tur ve gün sınırları aşmaz; gerçek tur tavanı aşmaz', async () => {
  let worst = 0;
  for (const st of Object.values(CFG.stores)) {
    if (!st.enabled) continue;
    for (const q of st.queries) if (CFG.scope.includes(q.scope)) worst += q.maxPages * st.creditsPerCall;
  }
  assert.ok(worst <= CFG.limits.maxCreditsPerRun, `en kötü tur ${worst}`);
  assert.ok(worst * CFG.limits.maxRunsPerDay <= CFG.limits.maxCreditsPerDay, `en kötü gün ${worst * CFG.limits.maxRunsPerDay}`);
  const client = fakeClient(handlerFor());
  const dir = tmp();
  await run({ makeClient: () => client, cfg: CFG, dir, now: T1, log: () => {} });
  assert.ok(client.spent <= CFG.limits.maxCreditsPerRun, `gerçek tur ${client.spent}`);
  assert.deepEqual(CFG.channelOrder, ['vatan', 'mediamarkt', 'teknosa']);
});

test('varyant ayrıştırma: 12+256GB, 16GB/1TB, 16/1 TB biçimleri; "A11+ 256Gb" model artısı RAM sayılmaz', () => {
  const v = (t) => { const x = parseVariant(t); return [x.ram, x.storage]; };
  assert.deepEqual(v('Galaxy Z Flip8 5G 12+256GB Grafit Gri'), [12, '256GB']);
  assert.deepEqual(v('Galaxy Z Fold8 5G 16+1TB Krem'), [16, '1TB']);
  assert.deepEqual(v('Galaxy S26 Ultra 5G 16/1 TB Beyaz'), [16, '1TB']);
  assert.deepEqual(v('Galaxy S26 Ultra 5G 16GB/1TB Beyaz'), [16, '1TB']);
  assert.deepEqual(v('Galaxy A06 4GB/128GB Siyah'), [4, '128GB']);
  assert.deepEqual(v('Galaxy Tab A11+ 256Gb 8GB-11\'\' Android Tablet'), [null, '256GB']);
  assert.deepEqual(v('Galaxy S25 FE 5G 8/256 Gb Lacivert'), [8, '256GB']);
});

test('eşleştirme: Vatan "12+256GB" yazımı MediaMarkt "12/256GB" ile bağlanır', () => {
  assert.deepEqual(modelParts('Galaxy Z Flip8 5G 12+256GB Grafit Gri'), modelParts('SAMSUNG Galaxy Z Flip8 5G 12/256GB Akıllı Telefon Grafit Gri'));
  assert.deepEqual(modelParts('Galaxy S26 Ultra 5G 16/1 TB Beyaz'), modelParts('Galaxy S26 Ultra 5G 16GB/1TB Beyaz'));
});

test('Teknosa sayfa tekrarı: 2. sayfa yerine 1. sayfa gelirse sayfa yeniden istenir, ürünler kaybolmaz', async () => {
  const pages = { 1: [TK.a57], 2: [TK.a37], 3: [TK.a17] };
  let n2 = 0;
  const h = (engine, params) => {
    const rows = params.page === 2 && ++n2 === 1 ? pages[1] : pages[params.page]; // ilk 2. sayfa isteği: 1. sayfanın aynısı
    return { results: rows, total_pages: 3, total_results: 3 };
  };
  const c = fakeClient(h);
  const r = await tkc.collect({ client: c, cfg: CFG.stores.teknosa, scope: ['phone'], now: T1 });
  assert.deepEqual(c.calls.map((x) => x.params.page), [1, 2, 2, 3], '2. sayfa bir kez yeniden istenir');
  assert.equal(r.stats.retries, 1);
  assert.equal(r.stats.repeated, undefined);
  assert.equal(r.stats.incomplete, undefined);
  assert.deepEqual(r.items.map((i) => i.productId).sort(), ['100000058142', '100000062355', '100000062357']);
  assert.equal(r.stats.credits, 4, 'yalnız 1 ek kredi');
});

test('Teknosa sayfa tekrarı: tekrar kalıcıysa en çok 2 kez denenir, eksik kayıt altına alınır (kredi sınırsız harcanmaz)', async () => {
  const pages = { 1: [TK.a57], 3: [TK.a17] };
  const h = (engine, params) => ({ results: pages[params.page] || pages[1], total_pages: 3, total_results: 3 }); // 2. sayfa hep 1. sayfa
  const c = fakeClient(h);
  const r = await tkc.collect({ client: c, cfg: CFG.stores.teknosa, scope: ['phone'], now: T1 });
  assert.deepEqual(c.calls.map((x) => x.params.page), [1, 2, 2, 2, 3]);
  assert.equal(r.stats.retries, 2);
  assert.equal(r.stats.repeated, 1);
  assert.deepEqual(r.stats.incomplete, ['cep-telefonu-c-100001: 2/3']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.items.map((i) => i.productId).sort(), ['100000058142', '100000062357']);
});

test('Teknosa normal tur: sayfa tekrarı yoksa ek istek ve ek kredi yok', async () => {
  const pages = { 1: [TK.a57], 2: [TK.a37], 3: [TK.a17] };
  const c = fakeClient((engine, params) => ({ results: pages[params.page], total_pages: 3, total_results: 3 }));
  const r = await tkc.collect({ client: c, cfg: CFG.stores.teknosa, scope: ['phone'], now: T1 });
  assert.deepEqual(c.calls.map((x) => x.params.page), [1, 2, 3]);
  assert.equal(r.stats.retries, undefined);
  assert.equal(r.stats.incomplete, undefined);
  assert.equal(r.stats.credits, 3);
});

test('altı anahtar: REEFAPI_KEY … REEFAPI_KEY_6 okunur; key_slot 2-6 desteklenir; dönüş 1→…→6→1; son tur 3. anahtarla yapıldıysa sıradaki 4. olur', () => {
  const ks = ['K1' + 'a'.repeat(30), 'K2' + 'b'.repeat(30), 'K3' + 'c'.repeat(30), 'K4' + 'd'.repeat(30), 'K5' + 'e'.repeat(30), 'K6' + 'f'.repeat(30)];
  const env = { REEFAPI_KEY: ks[0], REEFAPI_KEY_2: ks[1], REEFAPI_KEY_3: ks[2], REEFAPI_KEY_4: ks[3], REEFAPI_KEY_5: ks[4], REEFAPI_KEY_6: ks[5] };
  const pk = pickKeys(env);
  assert.deepEqual(pk.entries.map((e) => e.slot), [1, 2, 3, 4, 5, 6]);
  for (const n of [2, 3, 4, 5, 6]) assert.deepEqual(pickKeys({ ...env, REEFAPI_ONLY: String(n) }), { entries: [{ k: ks[n - 1], slot: n }], only: n, missing: false });
  assert.deepEqual(pickKeys({ ...env, REEFAPI_ONLY: '7' }).only, 0, '7 geçersiz: normal sıra');
  assert.deepEqual(pickKeys({ ...env, REEFAPI_ONLY: '1' }).only, 0, '1 seçilemez: normal sıra');
  assert.deepEqual(pickKeys({ ...env, REEFAPI_KEY_5: '' }).entries.map((e) => e.slot), [1, 2, 3, 4, 6], 'boş yuva atlanır');
  const FROM = '2026-11-08T00:00:00+03:00';
  const R = (at, slot) => ({ at, credits: 83, ok: true, force: false, slot });
  assert.deepEqual(rotateKeys(pk.entries, { runs: [R('2026-11-09T07:31:00Z', 3)] }, FROM).map((e) => e.slot), [4, 5, 6, 1, 2, 3]);
  assert.deepEqual(rotateKeys(pk.entries, { runs: [R('2026-11-09T13:30:00Z', 6)] }, FROM).map((e) => e.slot), [1, 2, 3, 4, 5, 6]);
  const sparse = pickKeys({ ...env, REEFAPI_KEY_4: '', REEFAPI_KEY_5: '' }).entries; // 1,2,3,6
  assert.deepEqual(rotateKeys(sparse, { runs: [R('2026-11-09T07:31:00Z', 3)] }, FROM).map((e) => e.slot), [6, 1, 2, 3]);
});

test('keySlots: yalnızca 1. ve 2. anahtar sırayla kullanılır; 3-6 devre dışı; elle key_slot bundan bağımsız; boş liste hepsini açar', () => {
  const ks = ['K1' + 'a'.repeat(30), 'K2' + 'b'.repeat(30), 'K3' + 'c'.repeat(30), 'K4' + 'd'.repeat(30), 'K5' + 'e'.repeat(30), 'K6' + 'f'.repeat(30)];
  const env = { REEFAPI_KEY: ks[0], REEFAPI_KEY_2: ks[1], REEFAPI_KEY_3: ks[2], REEFAPI_KEY_4: ks[3], REEFAPI_KEY_5: ks[4], REEFAPI_KEY_6: ks[5] };
  const pk = pickKeys(env, [1, 2]);
  assert.deepEqual(pk.entries, [{ k: ks[0], slot: 1 }, { k: ks[1], slot: 2 }]);
  assert.deepEqual(pickKeys(env, ['1', '2']).entries.map((e) => e.slot), [1, 2], 'sayı metin olarak yazılsa da çalışır');
  assert.deepEqual(pickKeys(env, [2]).entries.map((e) => e.slot), [2]);
  assert.deepEqual(pickKeys(env, []).entries.map((e) => e.slot), [1, 2, 3, 4, 5, 6], 'boş liste: hepsi');
  assert.deepEqual(pickKeys(env).entries.map((e) => e.slot), [1, 2, 3, 4, 5, 6], 'tanımsız: hepsi');
  assert.deepEqual(pickKeys({ ...env, REEFAPI_KEY: '' }, [1, 2]).entries.map((e) => e.slot), [2], 'yuvadaki anahtar yoksa atlanır');
  assert.deepEqual(pickKeys({ ...env, REEFAPI_ONLY: '4' }, [1, 2]), { entries: [{ k: ks[3], slot: 4 }], only: 4, missing: false }, 'elle deneme listeyi aşar');
  const FROM = '2026-11-08T00:00:00+03:00';
  const R = (at, slot, force = false) => ({ at, credits: 90, ok: true, force, slot });
  const order = (runs) => rotateKeys(pk.entries, { runs }, FROM).map((e) => e.slot);
  assert.deepEqual(order([]), [1, 2]);
  assert.deepEqual(order([R('2026-11-11T07:29:00Z', 2)]), [1, 2], '2. ile bitti → sıradaki 1.');
  assert.deepEqual(order([R('2026-11-11T07:29:00Z', 1)]), [2, 1], '1. ile bitti → sıradaki 2.');
  assert.deepEqual(order([R('2026-11-11T07:29:00Z', 1), R('2026-11-11T07:46:00Z', 2, true)]), [2, 1], 'deneme (force) turu sırayı bozmaz');
  assert.deepEqual(order([R('2026-11-11T07:29:00Z', 3)]), [1, 2], 'devre dışı yuva eski kayıtta kalsa da sıra bozulmaz');
});

test('anahtar sınaması (--probe): her anahtar ayrı sınanır, 1 kredi harcar; çalışan/geçersiz/kredisi biten/boş sonuç ayrımı; anahtar metne sızmaz', async () => {
  const { probeKeys } = await import('../collect.mjs');
  const K = ['P1' + 'a'.repeat(30), 'P2' + 'b'.repeat(30), 'P3' + 'c'.repeat(30), 'P4' + 'd'.repeat(30), 'P5' + 'e'.repeat(30)];
  const seen = [];
  const f = async (u, o) => {
    const k = o.headers['x-api-key']; seen.push(k);
    if (k === K[0]) return new Response(JSON.stringify({ ok: true, data: {}, meta: { charged_credits: 1 } }), { status: 200 });
    if (k === K[1]) return errRes(401, 'Invalid API key ' + k);
    if (k === K[2]) return errRes(402, 'insufficient credits');
    if (k === K[3]) return errRes(403, 'forbidden');
    return new Response(JSON.stringify({ ok: false, error: { message: 'search returned without a product grid' } }), { status: 200 });
  };
  const logs = [];
  const r = await probeKeys({ entries: K.map((k, i) => ({ k, slot: i + 1 })), cfg: { stores: { vatan: { brand: 'samsung' } } }, fetchImpl: f, log: (s) => logs.push(s) });
  assert.deepEqual(r.map((x) => x.state), ['calisiyor', 'gecersiz', 'kredi', 'yetki', 'calisiyor']);
  assert.deepEqual(r.map((x) => x.credits), [1, 0, 0, 0, 0]);
  assert.deepEqual(seen, K, 'her anahtar yalnızca kendisiyle ve tek kez denenir (yedeğe geçilmez)');
  assert.equal(logs.length, 5);
  assert.ok(!logs.join('\n').includes(K[1]), 'anahtar günlüğe sızmaz');
  assert.match(logs[1], /Yuva 2 .*GEÇERSİZ.*HTTP 401/);
});

test('iş akışı: 4-6. anahtar gizli kasadan ortama aktarılır ve key_slot seçeneklerinde vardır', () => {
  // depoda .github/workflows/fiyat.yml; müşteriye verilen pakette aynı dosya ADIM-3-fiyat.yml.txt adıyla durur
  const f = ['../.github/workflows/fiyat.yml', '../ADIM-3-fiyat.yml.txt'].map((x) => new URL(x, import.meta.url)).find((u) => fs.existsSync(u));
  if (!f) return;
  const y = fs.readFileSync(f, 'utf8');
  for (const n of ['', '_2', '_3', '_4', '_5', '_6']) assert.match(y, new RegExp(`REEFAPI_KEY${n}: \\$\\{\\{ secrets\\.REEFAPI_KEY${n} \\}\\}`));
  assert.match(y, /options: \[auto, '2', '3', '4', '5', '6'\]/);
});
