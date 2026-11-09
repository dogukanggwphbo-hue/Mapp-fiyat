// MediaMarkt tamamlama turu (barkodla doğrudan arama): hedef seçimi, kabul kuralı, olumsuz önbellek, bütçe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mmc from '../collectors/mediamarkt.mjs';
import { run } from '../collect.mjs';
import { MM, TK, fakeClient, ReefError } from './fixtures.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gap-'));
const T1 = new Date('2026-11-05T03:00:00Z'); // 06:00 TR
const T2 = new Date('2026-11-05T15:00:00Z'); // 18:00 TR (aynı gün)
const T9 = new Date('2026-11-13T03:00:00Z'); // 8 gün sonra
const nowIso = T1.toISOString();

const EAN_A37 = '8806099054953'; // MediaMarkt'ta (MM.a37) kendi satışı var
const EAN_A17 = '8806097660859'; // MediaMarkt'ta yalnızca pazaryeri satıcıda
const EAN_A57 = '8806099044916'; // genel aramada zaten görünür
const mpRow = { ...MM.a37, product_id: '7770001', ean: EAN_A17, title: 'SAMSUNG Galaxy A17 5G 8/256GB Akıllı Telefon Gri', seller: { type: 'marketplace', id: '9', name: 'Bir Satıcı', rating: 4, rating_scale: 5 }, url: 'https://www.mediamarkt.com.tr/tr/product/_a17-7770001.html' };

const it = (ch, key, o = {}) => ({ ch, key, cat: 'phone', inStock: true, checkedAt: nowIso, ...o });

test('hedef seçimi: yalnızca bu turda başka kanalda görülüp MediaMarkt\'ta görülmeyen barkodlu, stokta ürünler; 2+ kanal önce', () => {
  const items = [
    it('teknosa', '8806000000001'), it('vatan', '8806000000001'),   // iki kanalda, MM yok → hedef (öncelikli)
    it('teknosa', '8806000000000'),                                  // tek kanal, MM yok → hedef
    it('teknosa', '8806000000002'), it('mediamarkt', '8806000000002'), // MM taze → hedef değil
    it('teknosa', '8806000000003', { inStock: false }),              // stokta değil → hedef değil
    it('vatan', 'm:barkodsuz-urun'),                                 // barkodsuz → aranamaz
    it('vatan', '8806000000004', { checkedAt: '2026-11-04T00:00:00.000Z' }), // eski (bu turda görülmedi) → hedef değil
    it('teknosa', '8806000000005'), it('mediamarkt', '8806000000005', { checkedAt: '2026-11-04T00:00:00.000Z' }), // MM kaydı eski önbellekten → yeniden aranır
  ];
  const p = mmc.pickGapTargets({ items, nowIso, now: T1 });
  assert.deepEqual(p.targets, ['8806000000001', '8806000000000', '8806000000005']);
  assert.equal(p.missing, 3);
  assert.equal(p.cached, 0);
});

test('olumsuz önbellek: bulunamayan 3 gün, pazaryeri-only 7 gün yeniden aranmaz; süre dolunca aranır', () => {
  const items = [it('teknosa', '8806000000001'), it('teknosa', '8806000000002'), it('teknosa', '8806000000003')];
  const day = (n) => new Date(T1.getTime() + n * 86400e3);
  const cache = {
    8806000000001: { at: T1.toISOString(), why: 'yok' },
    8806000000002: { at: T1.toISOString(), why: 'pazaryeri' },
  };
  const gap = CFG.stores.mediamarkt.gap;
  let p = mmc.pickGapTargets({ items: items.map((x) => ({ ...x, checkedAt: day(2).toISOString() })), nowIso: day(2).toISOString(), now: day(2), cache, gap });
  assert.deepEqual(p.targets, ['8806000000003']); assert.equal(p.cached, 2);
  p = mmc.pickGapTargets({ items: items.map((x) => ({ ...x, checkedAt: day(4).toISOString() })), nowIso: day(4).toISOString(), now: day(4), cache, gap });
  assert.deepEqual(p.targets, ['8806000000001', '8806000000003'], 'yok: 3 gün sonra yeniden');
  assert.equal(p.cached, 1, 'pazaryeri: 7 güne kadar önbellekte');
  p = mmc.pickGapTargets({ items: items.map((x) => ({ ...x, checkedAt: day(8).toISOString() })), nowIso: day(8).toISOString(), now: day(8), cache, gap });
  assert.equal(p.targets.length, 3);
});

test('completeGaps: sorgu barkodun kendisi (marka + ülke); kendi satışı alınır, pazaryeri alınmaz, boş sonuç hata değil', async () => {
  const h = (engine, params) => {
    if (params.query === EAN_A37) return { results: [MM.a37] };
    if (params.query === EAN_A17) return { results: [mpRow] };
    throw new ReefError('mediamarkt: HTTP 404 no results found', { status: 404 });
  };
  const client = fakeClient(h);
  const r = await mmc.completeGaps({ client, cfg: CFG.stores.mediamarkt, scope: CFG.scope, now: T1, targets: [EAN_A37, EAN_A17, '8806000000009'] });
  assert.deepEqual(client.calls.map((c) => c.params), [
    { query: EAN_A37, country: 'tr', brand: 'SAMSUNG' }, { query: EAN_A17, country: 'tr', brand: 'SAMSUNG' }, { query: '8806000000009', country: 'tr', brand: 'SAMSUNG' }]);
  assert.deepEqual(r.verdicts, { [EAN_A37]: 'bulundu', [EAN_A17]: 'pazaryeri', 8806000000009: 'yok' });
  assert.deepEqual(r.items.map((x) => x.key), [EAN_A37]);
  assert.equal(r.items[0].price, 26999); assert.equal(r.items[0].verified, true); assert.equal(r.items[0].ch, 'mediamarkt');
  assert.deepEqual([r.stats.checked, r.stats.found, r.stats.marketplace, r.stats.none, r.stats.credits], [3, 1, 1, 1, 4]); // sonuçsuz arama kredi harcamaz (başarısız çağrı ücretsiz)
});

test('completeGaps: bütçe dolunca durur (hata değil), geçici hata önbelleğe yazılmaz, yetki/kredi hatası durdurur', async () => {
  const ok = () => ({ results: [MM.a37] });
  let r = await mmc.completeGaps({ client: fakeClient(ok, { max: 2 }), cfg: CFG.stores.mediamarkt, scope: CFG.scope, now: T1, targets: [EAN_A37, EAN_A17] });
  assert.equal(r.stats.budgetStop, true); assert.equal(r.stats.credits, 2); assert.deepEqual(Object.keys(r.verdicts), [EAN_A37]);
  const flaky = (e, p) => { if (p.query === EAN_A17) throw new ReefError('mediamarkt: HTTP 503 x', { status: 503 }); return { results: [MM.a37] }; };
  r = await mmc.completeGaps({ client: fakeClient(flaky), cfg: CFG.stores.mediamarkt, scope: CFG.scope, now: T1, targets: [EAN_A17, EAN_A37] });
  assert.equal(r.verdicts[EAN_A17], undefined, 'geçici hata: karar yok, önbelleğe yazılmaz');
  assert.equal(r.verdicts[EAN_A37], 'bulundu'); assert.match(r.stats.error, /503/);
  const fatal = () => { throw new ReefError('mediamarkt: HTTP 402 credits', { status: 402, keyProblem: 'kredi' }); };
  r = await mmc.completeGaps({ client: fakeClient(fatal), cfg: CFG.stores.mediamarkt, scope: CFG.scope, now: T1, targets: [EAN_A37, EAN_A17] });
  assert.equal(Object.keys(r.verdicts).length, 0); assert.match(r.stats.error, /402/);
});

// Genel arama yalnızca A57'yi döndürür (A37 genel aramada "görünmez"); barkodlu aramalar gerçek davranışı taklit eder.
function handler({ general = [MM.a57], tk = [TK.a57, TK.a37, TK.a17], vt = [], mmFail = false } = {}) {
  return (engine, params) => {
    if (engine === 'teknosa') return { results: tk, total_pages: 1 };
    if (engine === 'vatan') return { results: vt, total_pages: 1 };
    if (/^\d{8,14}$/.test(String(params.query))) {
      if (params.query === EAN_A37) return { results: [MM.a37] };
      if (params.query === EAN_A17) return { results: [mpRow] };
      throw new ReefError('mediamarkt: no results', { status: 404 });
    }
    if (mmFail) throw new ReefError('mediamarkt: HTTP 503', { status: 503 });
    return { results: general, max_page: 1, page_count: 1 };
  };
}
const numQ = (c) => c.calls.filter((x) => x.engine === 'mediamarkt' && /^\d+$/.test(String(x.params.query))).map((x) => x.params.query);
const readJ = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, 'data', f), 'utf8'));

test('uçtan uca: genel aramada görünmeyen ürün barkodla bulunup feed\'e girer; pazaryeri-only önbelleğe yazılır; bulunan yazılmaz', async () => {
  const dir = tmp();
  const c1 = fakeClient(handler());
  const o1 = await run({ makeClient: () => c1, cfg: CFG, dir, now: T1, log: () => {} });
  assert.equal(o1.wrote, true, JSON.stringify(o1.problems));
  assert.deepEqual(numQ(c1), [EAN_A17, EAN_A37]);
  const feed = readJ(dir, 'prices.json');
  const mm = feed.items.filter((i) => i.ch === 'mediamarkt').map((i) => i.key).sort();
  assert.deepEqual(mm, [EAN_A37, EAN_A57].sort());
  assert.equal(feed.items.filter((i) => i.ch === 'mediamarkt').every((i) => i.verified && i.sellerCheck === 'seller.type=retailer'), true);
  assert.equal(feed.items.some((i) => i.ch === 'mediamarkt' && i.key === EAN_A17), false, 'pazaryeri satıcı asla alınmaz');
  const g = feed.run.stores.mediamarkt.gap;
  assert.deepEqual([g.targets, g.queried, g.found, g.marketplace, g.none, g.credits], [2, 2, 1, 1, 0, 4]);
  assert.match(feed.sites.mediamarkt.note, /Tamamlama: 2 üründe barkodla arandı, 1 bulundu, 1 yalnızca pazaryeri/);
  assert.equal(feed.sites.mediamarkt.count, 2);
  const st = readJ(dir, 'state.json');
  assert.deepEqual(Object.keys(st.gaps.mediamarkt), [EAN_A17]);
  assert.equal(st.gaps.mediamarkt[EAN_A17].why, 'pazaryeri');
  assert.equal(JSON.stringify(st).includes('REEFAPI'), false);

  // 2. tur (aynı gün): pazaryeri-only tekrar aranmaz; A37 genel aramada yine görünmediği için yeniden aranır (fiyat tazelenir)
  const c2 = fakeClient(handler());
  await run({ makeClient: () => c2, cfg: CFG, dir, now: T2, log: () => {} });
  assert.deepEqual(numQ(c2), [EAN_A37]);
  const feed2 = readJ(dir, 'prices.json');
  assert.equal(feed2.run.stores.mediamarkt.gap.cached, 1);
  const a37 = feed2.items.find((i) => i.ch === 'mediamarkt' && i.key === EAN_A37);
  assert.equal(a37.checkedAt, T2.toISOString(), 'eski önbellek değil, taze kayıt');
  assert.equal(a37.since, T1.toISOString(), 'fiyat değişmedi: since korunur');

  // 8 gün sonra pazaryeri-only için süre dolmuştur: yeniden aranır
  const c3 = fakeClient(handler());
  await run({ makeClient: () => c3, cfg: CFG, dir, now: T9, log: () => {} });
  assert.deepEqual(numQ(c3), [EAN_A17, EAN_A37]);
});

test('uçtan uca: genel arama zaten bulduysa tamamlama sorgusu yapılmaz (kredi harcanmaz)', async () => {
  const dir = tmp();
  const c = fakeClient(handler({ general: [MM.a57, MM.a37, MM.a57], tk: [TK.a57, TK.a37] }));
  const o = await run({ makeClient: () => c, cfg: CFG, dir, now: T1, log: () => {} });
  assert.deepEqual(numQ(c), []);
  assert.equal(o.feed.run.stores.mediamarkt.gap.queried, 0);
  assert.equal(o.feed.sites.mediamarkt.note, null);
});

test('uçtan uca: tamamlama kapalıysa, MediaMarkt genel taraması başarısızsa ya da tavan 0 ise sorgu yapılmaz', async () => {
  const off = { ...CFG, stores: { ...CFG.stores, mediamarkt: { ...CFG.stores.mediamarkt, gap: { ...CFG.stores.mediamarkt.gap, enabled: false } } } };
  const c1 = fakeClient(handler());
  await run({ makeClient: () => c1, cfg: off, dir: tmp(), now: T1, log: () => {} });
  assert.deepEqual(numQ(c1), []);
  const c2 = fakeClient(handler({ mmFail: true }));
  const o2 = await run({ makeClient: () => c2, cfg: CFG, dir: tmp(), now: T1, log: () => {} });
  assert.equal(o2.feed.sites.mediamarkt.status, 'error');
  assert.deepEqual(numQ(c2), [], 'genel tarama çökmüşse kredi harcanmaz');
  const zero = { ...CFG, stores: { ...CFG.stores, mediamarkt: { ...CFG.stores.mediamarkt, gap: { ...CFG.stores.mediamarkt.gap, maxQueries: 0 } } } };
  const c3 = fakeClient(handler());
  const o3 = await run({ makeClient: () => c3, cfg: zero, dir: tmp(), now: T1, log: () => {} });
  assert.deepEqual(numQ(c3), []); assert.equal(o3.feed.run.stores.mediamarkt.gap.deferred, 2);
});

test('uçtan uca: tamamlama bütçeyi aşmaz; tavan dolarsa tur bozulmaz, kalanlar sonraki tura kalır', async () => {
  const dir = tmp();
  // Teknosa(1+..) + MediaMarkt genel(2) + 1 tamamlama sorgusu (2) sığar, ikincisi sığmaz
  const probe = fakeClient(handler());
  await run({ makeClient: () => probe, cfg: CFG, dir: tmp(), now: T1, log: () => {} });
  const base = probe.spent - 4; // tamamlamasız harcama
  const cfgB = { ...CFG, limits: { ...CFG.limits, maxCreditsPerRun: base + 2 } };
  const c = fakeClient(handler(), { max: base + 2 });
  const o = await run({ makeClient: () => c, cfg: cfgB, dir, now: T1, log: () => {} });
  assert.ok(c.spent <= base + 2, `harcanan ${c.spent}`);
  assert.equal(o.wrote, true);
  assert.equal(o.feed.sites.mediamarkt.status, 'ok');
  const g = o.feed.run.stores.mediamarkt.gap;
  assert.equal(g.queried, 1); assert.equal(g.budgetStop, true);
  assert.equal(readJ(dir, 'state.json').gaps.mediamarkt[EAN_A17].why, 'pazaryeri', 'aranan karar önbelleğe yazıldı');
});

test('yapılandırma: tamamlama ayarları makul (tavan, tekrar süreleri) ve en kötü tur harcaması tur sınırını aşmaz', () => {
  const g = CFG.stores.mediamarkt.gap;
  assert.equal(g.enabled, true);
  assert.ok(g.maxQueries >= 1 && g.maxQueries <= 20);
  assert.ok(g.retryNotFoundDays >= 1 && g.retryMarketplaceDays >= g.retryNotFoundDays);
  // tamamlama genel taramadan sonra çalışır ve aynı tur bütçesiyle (maxCreditsPerRun) sınırlıdır: tur başına en fazla maxQueries × creditsPerCall ek kredi
  assert.ok(g.maxQueries * CFG.stores.mediamarkt.creditsPerCall <= 30);
});

// Gerçek yanıtlardan (ReefAPI mediamarkt/search, 2026-11-09, barkodla arama): genel aramada eksik kalan iki ürün.
const REAL_TAB = { product_id: '1246252', title: 'SAMSUNG Galaxy TAB S10FE+ 13.1 12/256GB Tam Dokunmatik Tablet Mavi SM-X620NLBPTUR', brand: 'SAMSUNG', url: 'https://www.mediamarkt.com.tr/tr/product/_samsung-galaxy-tab-s10fe-131-12256gb-tam-dokunmatik-tablet-mavi-sm-x620nlbptur-1246252.html', ean: '8806097196587', currency: 'TRY', price: 38499, was_price: null, was_price_type: null, app_price: null, member_price: null, installment: { months: 6, monthly_amount: 6416.5, total_amount: 38499 }, vat_rate: 0.2, seller: { type: 'retailer', id: null, name: 'MediaMarkt' }, category: 'Samsung Tablet', breadcrumb: ['Bilgisayar', 'Tabletler', 'Android Tabletler', 'Samsung Tablet'], availability: { online_status: 'available', buyable_online: true, delivery_available: true, pickup_available: true }, badges: ['6 Taksit'], refurbished: false, sponsored: false };
const REAL_BUDS = { product_id: '1252509', title: 'SAMSUNG Galaxy Buds4 Bluetooth Kulak İçi Kulaklık Siyah', brand: 'SAMSUNG', url: 'https://www.mediamarkt.com.tr/tr/product/_samsung-galaxy-buds4-bluetooth-kulak-ici-kulaklik-siyah-1252509.html', ean: '8806097998426', currency: 'TRY', price: 7949, was_price: 8999, was_price_type: 'LOP', app_price: null, member_price: null, installment: { months: 9, monthly_amount: 883.22, total_amount: 7949 }, vat_rate: 0.2, seller: { type: 'retailer', id: null, name: 'MediaMarkt' }, category: 'TWS Kulaklık', breadcrumb: ['Telefon', 'Kulaklıklar', 'TWS Kulaklık'], availability: { online_status: 'available', buyable_online: true, delivery_available: true, pickup_available: true }, badges: ['9 Taksit'], refurbished: false, sponsored: false };

test('gerçek satırlar: Tab S10 FE+ Mavi 12/256 ve Buds4 Siyah barkodla bulunur, doğru kategori/fiyat/Web özel yok', async () => {
  const h = (e, p) => ({ results: [p.query === REAL_TAB.ean ? REAL_TAB : REAL_BUDS] });
  const r = await mmc.completeGaps({ client: fakeClient(h), cfg: CFG.stores.mediamarkt, scope: CFG.scope, now: T1, targets: [REAL_TAB.ean, REAL_BUDS.ean] });
  assert.deepEqual(r.verdicts, { [REAL_TAB.ean]: 'bulundu', [REAL_BUDS.ean]: 'bulundu' });
  const tab = r.items.find((x) => x.key === REAL_TAB.ean), buds = r.items.find((x) => x.key === REAL_BUDS.ean);
  assert.equal(tab.cat, 'tablet'); assert.equal(tab.price, 38499); assert.equal(tab.color, 'mavi'); assert.equal(tab.storage, '256GB'); assert.equal(tab.inStock, true); assert.equal(tab.webExclusive, false);
  assert.equal(buds.cat, 'wearable'); assert.equal(buds.price, 7949); assert.equal(buds.listPrice, 8999); assert.equal(buds.color, 'siyah');
});
