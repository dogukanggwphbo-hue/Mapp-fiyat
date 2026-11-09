// Tamamlama turu (kanallar arası doğrudan arama): hedef seçimi, arama metni, kabul kuralı, doğrulama, olumsuz önbellek, bütçe.
// Kural: başka bir kanalda bu turda görülüp bir kanalda genel aramada görünmeyen ürün, o kanalda doğrudan aranır (MediaMarkt / Teknosa / Vatan).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mmc from '../collectors/mediamarkt.mjs';
import * as tkc from '../collectors/teknosa.mjs';
import * as vtc from '../collectors/vatan.mjs';
import { pickTargets, toUnits, allocate, searchText, matchTarget, completeGaps } from '../lib/gap.mjs';
import { buildItem } from '../lib/normalize.mjs';
import { linkItems } from '../lib/link.mjs';
import { run } from '../collect.mjs';
import { MM, TK, VT, fakeClient, ReefError } from './fixtures.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gap-'));
const T1 = new Date('2026-11-05T03:00:00Z'); // 06:00 TR
const T2 = new Date('2026-11-05T15:00:00Z'); // 18:00 TR (aynı gün)
const T9 = new Date('2026-11-13T03:00:00Z'); // 8 gün sonra
const nowIso = T1.toISOString();
const day = (n) => new Date(T1.getTime() + n * 86400e3);

const EAN_A37 = '8806099054953'; // MediaMarkt'ta (MM.a37) kendi satışı var
const EAN_A17 = '8806097660859'; // MediaMarkt'ta yalnızca pazaryeri satıcıda
const EAN_A57 = '8806099044916'; // genel aramada zaten görünür
const mpRow = { ...MM.a37, product_id: '7770001', ean: EAN_A17, title: 'SAMSUNG Galaxy A17 5G 8/256GB Akıllı Telefon Gri', seller: { type: 'marketplace', id: '9', name: 'Bir Satıcı', rating: 4, rating_scale: 5 }, url: 'https://www.mediamarkt.com.tr/tr/product/_a17-7770001.html' };
const SC = (m) => CFG.stores[m];
const mkItem = (mod, row, at = nowIso) => buildItem(mod.toFields(row), at);
const it = (ch, key, o = {}) => ({ ch, key, cat: 'phone', inStock: true, checkedAt: nowIso, ...o });
const keys = (p) => p.targets.map((t) => t.key);

// ---- hedef seçimi ----------------------------------------------------------------------------------------------------------------------------

test('hedef seçimi: başka kanalda bu turda görülüp bu kanalda görülmeyen, stokta ürünler; 2+ kanal önce; her kanal için', () => {
  const items = [
    it('teknosa', 'A'), it('vatan', 'A'),                              // MM'de yok, 2 kanalda → hedef (öncelikli)
    it('teknosa', 'B'),                                                // MM'de yok, tek kanal → hedef
    it('teknosa', 'C'), it('mediamarkt', 'C'),                         // MM taze → hedef değil
    it('teknosa', 'D', { inStock: false }),                            // stokta değil → hedef değil
    it('vatan', 'E', { checkedAt: '2026-11-04T00:00:00.000Z' }),       // eski (bu turda görülmedi) → hedef değil
    it('teknosa', 'F'), it('mediamarkt', 'F', { checkedAt: '2026-11-04T00:00:00.000Z' }), // MM kaydı eski önbellekten → yeniden aranır
  ];
  const p = pickTargets({ store: 'mediamarkt', items, nowIso, now: T1 });
  assert.deepEqual(keys(p), ['A', 'B', 'F']);
  assert.deepEqual([p.missing, p.cached, p.unsearchable], [3, 0, 0]);
  // "MediaMarkt ve Vatan'da var, Teknosa'da yok" → Teknosa hedefi
  const x = [it('mediamarkt', 'X'), it('vatan', 'X'), it('mediamarkt', 'Y'), it('teknosa', 'Y')];
  const tk = pickTargets({ store: 'teknosa', items: x, nowIso, now: T1 });
  assert.deepEqual(keys(tk), ['X']); assert.equal(tk.targets[0].nch, 2);
  assert.deepEqual(keys(pickTargets({ store: 'vatan', items: x, nowIso, now: T1 })), ['Y']);
  assert.deepEqual(keys(pickTargets({ store: 'mediamarkt', items: x, nowIso, now: T1 })), []);
});

test('hedef seçimi: aranacak metin çıkarılamayan hedef atlanır; en az kanal sayısı ayarlanabilir', () => {
  const items = [it('teknosa', 'A'), it('teknosa', 'B'), it('vatan', 'B')];
  const p = pickTargets({ store: 'mediamarkt', items, nowIso, now: T1, canQuery: (t) => t.key !== 'A' });
  assert.deepEqual(keys(p), ['B']); assert.equal(p.unsearchable, 1);
  assert.deepEqual(keys(pickTargets({ store: 'mediamarkt', items, nowIso, now: T1, gap: { minChannels: 2 } })), ['B']);
});

test('olumsuz önbellek: bulunamayan 3 gün, pazaryeri-only 7 gün yeniden aranmaz; kanıtlanmış (bulundu) hedef önbelleğe takılmaz ve öne geçer', () => {
  const base = [it('teknosa', 'A'), it('teknosa', 'B'), it('teknosa', 'C'), it('teknosa', 'D'), it('vatan', 'D')];
  const cache = {
    A: { at: T1.toISOString(), why: 'yok' },
    B: { at: T1.toISOString(), why: 'pazaryeri' },
    C: { at: T1.toISOString(), why: 'bulundu' },
  };
  const gap = SC('mediamarkt').gap;
  const at = (n) => { const iso = day(n).toISOString(); return { items: base.map((x) => ({ ...x, checkedAt: iso })), nowIso: iso, now: day(n), cache, gap, store: 'mediamarkt' }; };
  let p = pickTargets(at(2));
  assert.deepEqual(keys(p), ['C', 'D'], 'kanıtlanmış önce, sonra çok kanallı'); assert.equal(p.cached, 2);
  p = pickTargets(at(4));
  assert.deepEqual(keys(p).sort(), ['A', 'C', 'D'], 'yok: 3 gün sonra yeniden'); assert.equal(p.cached, 1, 'pazaryeri: 7 güne kadar önbellekte');
  assert.equal(pickTargets(at(8)).targets.length, 4);
});

// ---- arama metni -----------------------------------------------------------------------------------------------------------------------------

test('arama metni: model düzeyinde (renk, depolama, 5G, ekran/işlemci gürültüsü atılır); şarj/kulaklıkta ürün kodu; resmî yazıma yaklaştırılır', () => {
  const q = (o) => searchText({ cat: 'phone', ...o });
  assert.equal(q({ label: 'Galaxy Tab S10 FE+ 12/256 GB Navy', cat: 'tablet' }), 'Galaxy Tab S10 FE+');
  assert.equal(q({ label: 'Galaxy S26 Ultra 5G 16GB/1TB Gök Mavisi' }), 'Galaxy S26 Ultra');
  assert.equal(q({ label: 'Galaxy S26 Ultra 5G 16/1 TB Kobalt Mor' }), 'Galaxy S26 Ultra');
  assert.equal(q({ label: "Galaxy Tab S11 12Gb 128Gb 11''Android Tablet Gri", cat: 'tablet' }), 'Galaxy Tab S11');
  assert.equal(q({ label: 'Galaxy Tab S10 Lite 2Ghz 128Gb 6Gb 10.9\'\'Android Tablet Gri', cat: 'tablet' }), 'Galaxy Tab S10 Lite');
  assert.equal(q({ label: 'Galaxy Watch 8 40mm Akıllı Saat Koyu Gri', cat: 'wearable' }), 'Galaxy Watch8 40mm');
  assert.equal(q({ label: 'Galaxy Z Fold 7 5G 12/256GB Akıllı Telefon Gümüş' }), 'Galaxy Fold7');
  assert.equal(q({ label: 'Fold7 5G 512GB Gümüş Akıllı Telefon' }), 'Galaxy Fold7', 'Galaxy eksikse eklenir');
  assert.equal(q({ label: 'Galaxy Buds4 Bluetooth Kulak İçi Kulaklık Siyah', cat: 'wearable' }), 'Galaxy Buds4');
  assert.equal(q({ label: 'Galaxy A57 8/256GB Akıllı Telefon Gri' }), 'Galaxy A57');
  assert.equal(q({ cat: 'adapter', name: 'SAMSUNG EP-T2510N Type C Hızlı Şarj Adaptörü 25W- Beyaz', label: 'EP-T2510N Type-C 25 W Hızlı Şarj Adaptörü Beyaz' }), 'EP-T2510N');
  assert.equal(q({ cat: 'adapter', name: 'Samsung EO-IA500B 3.5 MM Kablolu Kulak İçi Kulaklık Siyah', label: 'EO-IA500B 3.5 MM Kablolu Kulak İçi Kulaklık Siyah' }), 'EO-IA500B');
  assert.equal(q({ label: 'Gri' }), null, 'metin yetersiz');
});

test('kanal istekleri: MediaMarkt barkodla (barkodsuzsa ad), Teknosa ve Vatan model adıyla; aynı model tek sorguda birleşir', () => {
  const a37 = { key: EAN_A37, items: [mkItem(tkc, TK.a37)], nch: 1 };
  assert.deepEqual(mmc.gapRequest(a37, SC('mediamarkt')), { query: EAN_A37, country: 'tr', brand: 'SAMSUNG' });
  assert.deepEqual(tkc.gapRequest(a37, SC('teknosa')), { seller: 'teknosa', query: 'Galaxy A37', page: 1, brand: '2489' });
  assert.deepEqual(vtc.gapRequest(a37, SC('vatan')), { query: 'Galaxy A37', brand: 'samsung', page: 1, in_stock_only: true });
  const vOnly = { key: 'v:sm-a276bzkctur', items: [mkItem(vtc, VT.a27)], nch: 1 };
  assert.deepEqual(mmc.gapRequest(vOnly, SC('mediamarkt')), { query: 'Galaxy A27', country: 'tr', brand: 'SAMSUNG' });
  const units = toUnits([vOnly, { key: 'v:sm-a276blictur', items: [mkItem(vtc, VT.a27pembe)], nch: 1 }, a37], tkc, SC('teknosa'));
  assert.equal(units.length, 2, 'Galaxy A27 Siyah + Açık Pembe tek aramada');
  assert.deepEqual(units.map((u) => u.targets.length), [2, 1]);
});

test('bütçe dağıtımı: kanallar arasında sırayla, kanal tavanı ve sorgu maliyetiyle; bütçe yetmezse durur', () => {
  const u = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const plans = [{ store: 'teknosa', units: u(9, 't'), cost: 1, cap: 12 }, { store: 'mediamarkt', units: u(9, 'm'), cost: 2, cap: 8 }, { store: 'vatan', units: u(3, 'v'), cost: 1, cap: 12 }];
  const a = allocate(plans, 27);
  assert.deepEqual([...a].map(([s, x]) => [s, x.length]), [['teknosa', 8], ['mediamarkt', 8], ['vatan', 3]]);
  assert.deepEqual(a.get('teknosa').slice(0, 2), ['t0', 't1'], 'öncelik sırası korunur');
  const b = allocate(plans, 4);
  assert.deepEqual([...b].map(([s, x]) => x.length), [1, 1, 1]);
  assert.deepEqual([...allocate(plans, 3)].map(([s, x]) => x.length), [1, 1, 0], 'MediaMarkt 2 kredi: Vatan\'a kalan 0');
  assert.deepEqual([...allocate(plans, 0)].map(([, x]) => x.length), [0, 0, 0]);
  assert.deepEqual([...allocate([{ store: 'teknosa', units: u(5, 't'), cost: 1, cap: 2 }], 99)].map(([, x]) => x.length), [2], 'kanal tavanı');
});

// ---- doğrulama -------------------------------------------------------------------------------------------------------------------------------

test('doğrulama: barkod eşitliği ya da ürün özellikleri (model + depolama + renk) eşleşirse bağlanır; farklı renk/depolama bağlanmaz', () => {
  const mm5g = mkItem(mmc, { ...MM.a37, title: 'SAMSUNG Galaxy A37 5G 8/256GB Akıllı Telefon Antrasit' });
  const grp = { key: EAN_A37, items: [mm5g, mkItem(vtc, VT.a37)] }; // MediaMarkt (barkodlu) + Vatan (barkodsuz)
  assert.equal(matchTarget([mkItem(tkc, TK.a37)], grp).length, 1, 'Teknosa: barkod eşit');
  assert.equal(matchTarget([mkItem(vtc, VT.a37)], { key: EAN_A37, items: [mkItem(mmc, MM.a37)] }).length, 0, '5G bilgisi farklı (MediaMarkt başlığında yok) → temkinli: bağlanmaz');
  const otherColor = { ...VT.a37, product_code: 'SM-A376BZKGTUR', title: 'Samsung Galaxy A37 5G 8/256 GB Akıllı Telefon Siyah' };
  const sibling = { key: EAN_A37, items: [mm5g] };
  assert.equal(matchTarget([mkItem(vtc, otherColor)], sibling).length, 0, 'Vatan: renk farklı → eşleşmez');
  assert.equal(matchTarget([mkItem(vtc, VT.a37)], sibling).length, 1, 'Vatan: aynı model/depolama/renk → özellik eşleşmesi');
  const otherStorage = { ...VT.a37, product_code: 'SM-A376BZAKTUR', title: 'Samsung Galaxy A37 5G 8/128 GB Akıllı Telefon Antrasit' };
  assert.equal(matchTarget([mkItem(vtc, otherStorage)], sibling).length, 0, 'Vatan: depolama farklı → eşleşmez');
  assert.deepEqual(matchTarget([], sibling), []);
});

// ---- aramalar --------------------------------------------------------------------------------------------------------------------------------

test('MediaMarkt: sorgu barkodun kendisi (marka + ülke); kendi satışı alınır, pazaryeri alınmaz, boş sonuç hata değil', async () => {
  const h = (engine, params) => {
    if (params.query === EAN_A37) return { results: [MM.a37] };
    if (params.query === EAN_A17) return { results: [mpRow] };
    throw new ReefError('mediamarkt: HTTP 404 no results found', { status: 404 });
  };
  const client = fakeClient(h);
  const tg = (k, row) => ({ key: k, items: [mkItem(tkc, row)], nch: 1 });
  const targets = [tg(EAN_A37, TK.a37), tg(EAN_A17, TK.a17), { key: '8806000000009', items: [{ ...mkItem(tkc, TK.a57), key: '8806000000009' }], nch: 1 }];
  const r = await completeGaps({ client, mod: mmc, cfg: SC('mediamarkt'), scope: CFG.scope, now: T1, units: toUnits(targets, mmc, SC('mediamarkt')) });
  assert.deepEqual(client.calls.map((c) => c.params), [EAN_A37, EAN_A17, '8806000000009'].map((q) => ({ query: q, country: 'tr', brand: 'SAMSUNG' })));
  assert.deepEqual(r.verdicts, { [EAN_A37]: 'bulundu', [EAN_A17]: 'pazaryeri', 8806000000009: 'yok' });
  assert.deepEqual(r.items.map((x) => x.key), [EAN_A37]);
  assert.equal(r.items[0].price, 26999); assert.equal(r.items[0].verified, true); assert.equal(r.items[0].ch, 'mediamarkt');
  assert.deepEqual([r.stats.queries, r.stats.checked, r.stats.found, r.stats.marketplace, r.stats.none, r.stats.credits], [3, 3, 1, 1, 1, 4]); // sonuçsuz arama kredi harcamaz (başarısız çağrı ücretsiz)
});

test('Teknosa: model adıyla aranır; sonuçtaki barkod hedefle eşleşirse bulunur; pazaryeri satıcı alınmaz; ürün listesi yoksa "yok"', async () => {
  const a37 = { key: EAN_A37, items: [mkItem(mmc, MM.a37), mkItem(vtc, VT.a37)], nch: 2 };
  const a27 = { key: '8806099359300', items: [mkItem(mmc, MM.oos)], nch: 1 };
  const h = (engine, params) => {
    if (params.query === 'Galaxy A37') return { results: [TK.market, TK.a57, TK.a37, TK.preo], total_pages: 1 };
    throw new ReefError('teknosa: teknosa.com answered a page without a product grid', { status: 502 });
  };
  const client = fakeClient(h);
  const r = await completeGaps({ client, mod: tkc, cfg: SC('teknosa'), scope: CFG.scope, now: T1, units: toUnits([a37, a27], tkc, SC('teknosa')) });
  assert.deepEqual(client.calls.map((c) => [c.engine, c.params]), [['teknosa', { seller: 'teknosa', query: 'Galaxy A37', page: 1, brand: '2489' }], ['teknosa', { seller: 'teknosa', query: 'Galaxy A27', page: 1, brand: '2489' }]]);
  assert.deepEqual(r.verdicts, { [EAN_A37]: 'bulundu', 8806099359300: 'yok' });
  // aramada gelen başka geçerli Teknosa ürünü (A57) de feed'e alınır; pazaryeri / Preo (Samsung markası değil) alınmaz
  assert.deepEqual(r.items.map((x) => x.key).sort(), [EAN_A37, EAN_A57].sort());
  assert.ok(r.items.every((x) => x.ch === 'teknosa' && x.verified && x.sellerCheck === 'seller.is_teknosa=true'));
  assert.equal(r.stats.credits, 1, 'yalnızca ilk arama ücretli (ürün listesi olmayan çağrı ücretsiz)');
});

test('Vatan: model adıyla aranır; aynı aramadaki birden çok hedef birlikte kapanır; farklı renk bulunmuş sayılmaz; kimlik v:+ürün kodu', async () => {
  // hedefler: MediaMarkt'ta görülen A17 Gri ve A57 Gri (Vatan'da yok)
  const mmA17 = mkItem(mmc, { ...MM.kinds, ean: EAN_A17, title: 'SAMSUNG Galaxy A17 5G 8/256GB Akıllı Telefon Siyah' });
  const mmA57 = mkItem(tkc, TK.a57);
  const vtA57 = { ...VT.a17, product_code: 'SM-A576BZAGTUR', slug: 'a57.html', title: 'Samsung Galaxy A57 5G 8/256 Gb Akıllı Telefon Gri', url: 'https://www.vatanbilgisayar.com/a57.html', price: 31999 };
  const h = (engine, params) => (params.query === 'Galaxy A57' ? { results: [vtA57], total_pages: 1 } : { results: [VT.a17], total_pages: 1 }); // A17 sorgusu yalnızca SİYAH getirir
  const client = fakeClient(h);
  const tg = [{ key: EAN_A57, items: [mmA57], nch: 1 }, { key: EAN_A17, items: [mmA17], nch: 1 }];
  const r = await completeGaps({ client, mod: vtc, cfg: SC('vatan'), scope: CFG.scope, now: T1, units: toUnits(tg, vtc, SC('vatan')) });
  assert.deepEqual(client.calls.map((c) => c.params.query), ['Galaxy A57', 'Galaxy A17']);
  assert.ok(client.calls.every((c) => c.params.in_stock_only === true && c.params.brand === 'samsung'));
  assert.equal(r.verdicts[EAN_A57], 'bulundu');
  assert.equal(r.verdicts[EAN_A17], 'bulundu', 'A17 Siyah (MM) ↔ Vatan A17 Siyah');
  assert.deepEqual(r.items.map((x) => x.ownKey).sort(), ['v:sm-a176bzkdtur', 'v:sm-a576bzagtur']);
  assert.equal(r.items.every((x) => x.ch === 'vatan' && x.ean === null && x.inStock === true), true);
  // farklı renk: Gri aranıyor, Vatan yalnızca Siyah getiriyor → bulunmuş sayılmaz
  const mmA17gri = mkItem(mmc, { ...MM.kinds });
  const r2 = await completeGaps({ client: fakeClient(h), mod: vtc, cfg: SC('vatan'), scope: CFG.scope, now: T1, units: toUnits([{ key: EAN_A17, items: [mmA17gri], nch: 1 }], vtc, SC('vatan')) });
  assert.equal(r2.verdicts[EAN_A17], 'yok');
});

test('zaten taze ama bağlanmamış kayıt "bulundu" sayılmaz (kanıtlanmış hedef olarak her tur boşuna aranmasın)', async () => {
  const g = { key: EAN_A57, items: [mkItem(mmc, MM.a57)], nch: 1 };
  const existing = mkItem(tkc, TK.a57);
  const r = await completeGaps({ client: fakeClient(() => ({ results: [TK.a57] })), mod: tkc, cfg: SC('teknosa'), scope: CFG.scope, now: T1, units: toUnits([g], tkc, SC('teknosa')), have: new Set([existing.key]) });
  assert.equal(r.verdicts[EAN_A57], 'yok'); assert.equal(r.items.length, 0);
});

test('bütçe dolunca durur (hata değil), geçici hata önbelleğe yazılmaz, yetki/kredi hatası durdurur', async () => {
  const ok = () => ({ results: [MM.a37] });
  const tg = (k, row) => ({ key: k, items: [mkItem(tkc, row)], nch: 1 });
  const units = () => toUnits([tg(EAN_A37, TK.a37), tg(EAN_A17, TK.a17)], mmc, SC('mediamarkt'));
  const base = { mod: mmc, cfg: SC('mediamarkt'), scope: CFG.scope, now: T1 };
  let r = await completeGaps({ ...base, client: fakeClient(ok, { max: 2 }), units: units() });
  assert.equal(r.stats.budgetStop, true); assert.equal(r.stats.credits, 2); assert.deepEqual(Object.keys(r.verdicts), [EAN_A37]);
  const flaky = (e, p) => { if (p.query === EAN_A17) throw new ReefError('mediamarkt: HTTP 503 x', { status: 503 }); return { results: [MM.a37] }; };
  r = await completeGaps({ ...base, client: fakeClient(flaky), units: toUnits([tg(EAN_A17, TK.a17), tg(EAN_A37, TK.a37)], mmc, SC('mediamarkt')) });
  assert.equal(r.verdicts[EAN_A17], undefined, 'geçici hata: karar yok, önbelleğe yazılmaz');
  assert.equal(r.verdicts[EAN_A37], 'bulundu'); assert.match(r.stats.error, /503/);
  const fatal = () => { throw new ReefError('mediamarkt: HTTP 402 credits', { status: 402, keyProblem: 'kredi' }); };
  r = await completeGaps({ ...base, client: fakeClient(fatal), units: units() });
  assert.equal(Object.keys(r.verdicts).length, 0); assert.match(r.stats.error, /402/);
});

// ---- uçtan uca -------------------------------------------------------------------------------------------------------------------------------

const isGeneral = {
  teknosa: (p) => !!p.category,
  mediamarkt: (p) => CFG.stores.mediamarkt.queries.some((q) => q.q === p.query),
  vatan: (p) => CFG.stores.vatan.queries.some((q) => q.q === p.query),
};
const NOT_FOUND = (e) => new ReefError(`${e}: no results found`, { status: 404 });
/**
 * Sahte dünya. Genel taramalar sabit liste döndürür (general.*); doğrudan aramalar byQuery.* sözlüğünden yanıtlanır, yoksa sonuç yok.
 * MediaMarkt barkodla (byQuery.mediamarkt[barkod]); Teknosa ve Vatan model adıyla (byQuery.teknosa['Galaxy A37']).
 */
function world({ mm = [MM.a57], tk = [TK.a57, TK.a37, TK.a17], vt = [], by = {}, mmFail = false } = {}) {
  const by2 = { mediamarkt: {}, teknosa: {}, vatan: {}, ...by };
  return (engine, params) => {
    if (engine === 'teknosa') {
      if (isGeneral.teknosa(params)) return { results: tk, total_pages: 1 };
      if (by2.teknosa[params.query]) return { results: by2.teknosa[params.query], total_pages: 1 };
      throw new ReefError('teknosa: teknosa.com answered a page without a product grid', { status: 502 });
    }
    if (engine === 'vatan') {
      if (isGeneral.vatan(params)) return { results: vt, total_pages: 1 };
      if (by2.vatan[params.query]) return { results: by2.vatan[params.query], total_pages: 1 };
      return { results: [], total_pages: 0 };
    }
    if (isGeneral.mediamarkt(params)) { if (mmFail) throw new ReefError('mediamarkt: HTTP 503', { status: 503 }); return { results: mm, max_page: 1, page_count: 1 }; }
    if (by2.mediamarkt[params.query]) return { results: by2.mediamarkt[params.query] };
    throw NOT_FOUND('mediamarkt');
  };
}
const direct = (c, engine) => c.calls.filter((x) => x.engine === engine && !isGeneral[engine](x.params)).map((x) => x.params.query);
const readJ = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, 'data', f), 'utf8'));
const byCh = (feed, ch) => feed.items.filter((i) => i.ch === ch);

test('uçtan uca (MediaMarkt): genel aramada görünmeyen ürün barkodla bulunup feed\'e girer; pazaryeri-only önbelleğe yazılır; bulunan "kanıtlanmış" kalır', async () => {
  const dir = tmp();
  const by = { mediamarkt: { [EAN_A37]: [MM.a37], [EAN_A17]: [mpRow] } };
  const c1 = fakeClient(world({ by }));
  const o1 = await run({ makeClient: () => c1, cfg: CFG, dir, now: T1, log: () => {} });
  assert.equal(o1.wrote, true, JSON.stringify(o1.problems));
  assert.deepEqual(direct(c1, 'mediamarkt').sort(), [EAN_A17, EAN_A37].sort());
  const feed = readJ(dir, 'prices.json');
  assert.deepEqual(byCh(feed, 'mediamarkt').map((i) => i.key).sort(), [EAN_A37, EAN_A57].sort());
  assert.equal(byCh(feed, 'mediamarkt').every((i) => i.verified && i.sellerCheck === 'seller.type=retailer'), true);
  assert.equal(byCh(feed, 'mediamarkt').some((i) => i.key === EAN_A17), false, 'pazaryeri satıcı asla alınmaz');
  const g = feed.run.stores.mediamarkt.gap;
  assert.deepEqual([g.targets, g.queried, g.found, g.marketplace, g.none, g.credits, g.deferred], [2, 2, 1, 1, 0, 4, 0]);
  assert.match(feed.sites.mediamarkt.note, /Tamamlama: 2 aramayla 1 ürün bulundu, 1 ürün yalnızca pazaryeri satıcıda/);
  assert.equal(feed.sites.mediamarkt.count, 2);
  const st = readJ(dir, 'state.json');
  assert.deepEqual(Object.keys(st.gaps.mediamarkt).sort(), [EAN_A17, EAN_A37].sort());
  assert.equal(st.gaps.mediamarkt[EAN_A17].why, 'pazaryeri'); assert.equal(st.gaps.mediamarkt[EAN_A37].why, 'bulundu');
  assert.equal(JSON.stringify(st).includes('REEFAPI'), false);

  // 2. tur (aynı gün): pazaryeri-only tekrar aranmaz; A37 genel aramada yine görünmediği için yeniden aranır (fiyat tazelenir)
  const c2 = fakeClient(world({ by }));
  await run({ makeClient: () => c2, cfg: CFG, dir, now: T2, log: () => {} });
  assert.deepEqual(direct(c2, 'mediamarkt'), [EAN_A37]);
  const feed2 = readJ(dir, 'prices.json');
  assert.equal(feed2.run.stores.mediamarkt.gap.cached, 1);
  const a37 = byCh(feed2, 'mediamarkt').find((i) => i.key === EAN_A37);
  assert.equal(a37.checkedAt, T2.toISOString(), 'eski önbellek değil, taze kayıt');
  assert.equal(a37.since, T1.toISOString(), 'fiyat değişmedi: since korunur');

  // 8 gün sonra pazaryeri-only için süre dolmuştur: yeniden aranır
  const c3 = fakeClient(world({ by }));
  await run({ makeClient: () => c3, cfg: CFG, dir, now: T9, log: () => {} });
  assert.deepEqual(direct(c3, 'mediamarkt').sort(), [EAN_A17, EAN_A37].sort());
});

test('uçtan uca (Teknosa): MediaMarkt ve Vatan\'da var, Teknosa\'nın genel aramasında yok → Teknosa model adıyla doğrudan aranır, barkodla doğrulanıp feed\'e girer', async () => {
  const dir = tmp();
  const mmA37 = { ...MM.a37, title: 'SAMSUNG Galaxy A37 5G 8/256GB Akıllı Telefon Antrasit' }; // Vatan ile aynı ürün (5G bilgisi iki başlıkta da var)
  const c = fakeClient(world({ mm: [MM.a57, mmA37], tk: [TK.a57], vt: [VT.a37], by: { teknosa: { 'Galaxy A37': [TK.a37] } } }));
  const o = await run({ makeClient: () => c, cfg: CFG, dir, now: T1, log: () => {} });
  assert.equal(o.wrote, true, JSON.stringify(o.problems));
  assert.deepEqual(direct(c, 'teknosa'), ['Galaxy A37']);
  const tk = byCh(o.feed, 'teknosa');
  assert.deepEqual(tk.map((i) => i.key).sort(), [EAN_A37, EAN_A57].sort());
  const f = tk.find((i) => i.key === EAN_A37);
  assert.equal(f.verified, true); assert.equal(f.sellerCheck, 'seller.is_teknosa=true'); assert.equal(f.price, 26999);
  const g = o.feed.run.stores.teknosa.gap;
  assert.deepEqual([g.targets, g.queried, g.found, g.credits], [1, 1, 1, 1]);
  assert.match(o.feed.sites.teknosa.note, /Tamamlama: 1 aramayla 1 ürün bulundu/);
  assert.equal(o.feed.sites.teknosa.count, 2);
  // aynı ürün üç kanalda tek satır (aynı anahtar)
  assert.deepEqual([...new Set(o.feed.items.filter((i) => i.key === EAN_A37).map((i) => i.ch))].sort(), ['mediamarkt', 'teknosa', 'vatan']);
  assert.equal(readJ(dir, 'state.json').gaps.teknosa[EAN_A37].why, 'bulundu');
});

test('uçtan uca (Vatan): MediaMarkt ve Teknosa\'da var, Vatan\'ın genel aramasında yok → Vatan model adıyla aranır, özellik eşleşmesiyle bağlanır', async () => {
  const vtA57 = { ...VT.a17, product_code: 'SM-A576BZAGTUR', slug: 'a57.html', title: 'Samsung Galaxy A57 5G 8/256 Gb Akıllı Telefon Gri', url: 'https://www.vatanbilgisayar.com/a57.html', price: 31999 };
  const c = fakeClient(world({ mm: [MM.a57], tk: [TK.a57], vt: [VT.a17], by: { vatan: { 'Galaxy A57': [vtA57] } } }));
  const o = await run({ makeClient: () => c, cfg: CFG, dir: tmp(), now: T1, log: () => {} });
  assert.equal(o.wrote, true, JSON.stringify(o.problems));
  assert.ok(direct(c, 'vatan').includes('Galaxy A57'));
  const v = byCh(o.feed, 'vatan').find((i) => i.ownKey === 'v:sm-a576bzagtur');
  assert.ok(v, 'Vatan A57 feed\'e girdi');
  assert.equal(v.key, EAN_A57, 'barkodlu ürüne bağlandı: aynı ürün aynı satırda');
  assert.equal(v.match, 'model'); assert.equal(v.price, 31999); assert.equal(v.verified, true);
  assert.deepEqual(o.feed.items.filter((i) => i.key === EAN_A57).map((i) => i.ch).sort(), ['mediamarkt', 'teknosa', 'vatan']);
});

test('uçtan uca: genel aramalar zaten her şeyi buldıysa tamamlama sorgusu yapılmaz (kredi harcanmaz)', async () => {
  const dir = tmp();
  const c = fakeClient(world({ mm: [MM.a57, MM.a37, MM.a57], tk: [TK.a57, TK.a37], vt: [] }));
  const o = await run({ makeClient: () => c, cfg: CFG, dir, now: T1, log: () => {} });
  assert.deepEqual([direct(c, 'mediamarkt'), direct(c, 'teknosa'), direct(c, 'vatan')], [[], [], []]);
  assert.equal(o.feed.run.stores.mediamarkt.gap.queried, 0);
  assert.equal(o.feed.sites.mediamarkt.note, null);
  assert.equal(readJ(dir, 'state.json').gaps, undefined, 'önbellek boşsa durum dosyasına yazılmaz');
});

test('uçtan uca: bulunamayan ürün (Teknosa\'da gerçekten yok) olumsuz önbelleğe yazılır, 3 gün aranmaz, sonra yeniden aranır', async () => {
  const dir = tmp();
  const w = () => world({ mm: [MM.a57, MM.a37], tk: [TK.a57], vt: [] }); // A37: MM'de var, Teknosa'da yok (aramada da yok)
  const c1 = fakeClient(w());
  await run({ makeClient: () => c1, cfg: CFG, dir, now: T1, log: () => {} });
  assert.deepEqual(direct(c1, 'teknosa'), ['Galaxy A37']);
  assert.equal(readJ(dir, 'state.json').gaps.teknosa[EAN_A37].why, 'yok');
  const c2 = fakeClient(w());
  await run({ makeClient: () => c2, cfg: CFG, dir, now: T2, log: () => {} });
  assert.deepEqual(direct(c2, 'teknosa'), [], 'aynı gün yeniden aranmaz');
  assert.equal(readJ(dir, 'prices.json').run.stores.teknosa.gap.cached, 1);
  const c3 = fakeClient(w());
  await run({ makeClient: () => c3, cfg: CFG, dir, now: day(4), log: () => {} });
  assert.deepEqual(direct(c3, 'teknosa'), ['Galaxy A37'], '3 gün sonra yeniden aranır');
});

test('uçtan uca: tamamlama kapalıysa, o kanalın genel taraması başarısızsa ya da tavan 0 ise o kanal için sorgu yapılmaz', async () => {
  const by = { mediamarkt: { [EAN_A37]: [MM.a37], [EAN_A17]: [mpRow] } };
  const off = (ch) => ({ ...CFG, stores: { ...CFG.stores, [ch]: { ...CFG.stores[ch], gap: { ...CFG.stores[ch].gap, enabled: false } } } });
  const c1 = fakeClient(world({ by }));
  await run({ makeClient: () => c1, cfg: off('mediamarkt'), dir: tmp(), now: T1, log: () => {} });
  assert.deepEqual(direct(c1, 'mediamarkt'), []);
  const c2 = fakeClient(world({ by, mmFail: true }));
  const o2 = await run({ makeClient: () => c2, cfg: CFG, dir: tmp(), now: T1, log: () => {} });
  assert.equal(o2.feed.sites.mediamarkt.status, 'error');
  assert.deepEqual(direct(c2, 'mediamarkt'), [], 'genel tarama çökmüşse kredi harcanmaz');
  const zero = { ...CFG, stores: { ...CFG.stores, mediamarkt: { ...CFG.stores.mediamarkt, gap: { ...CFG.stores.mediamarkt.gap, maxQueries: 0 } } } };
  const c3 = fakeClient(world({ by }));
  const o3 = await run({ makeClient: () => c3, cfg: zero, dir: tmp(), now: T1, log: () => {} });
  assert.deepEqual(direct(c3, 'mediamarkt'), []); assert.equal(o3.feed.run.stores.mediamarkt.gap.deferred, 2);
});

test('uçtan uca: tamamlama bütçeyi aşmaz; tavan dolarsa tur bozulmaz, kalanlar sonraki tura kalır', async () => {
  const dir = tmp();
  const by = { mediamarkt: { [EAN_A37]: [MM.a37], [EAN_A17]: [mpRow] } };
  const probe = fakeClient(world({ by }));
  await run({ makeClient: () => probe, cfg: CFG, dir: tmp(), now: T1, log: () => {} });
  const g0 = (await run({ makeClient: () => fakeClient(world({ by })), cfg: CFG, dir: tmp(), now: T1, log: () => {} })).feed.run.stores;
  const gapCost = Object.values(g0).reduce((a, s) => a + ((s.gap && s.gap.credits) || 0), 0);
  const base = probe.spent - gapCost; // tamamlamasız harcama
  assert.ok(gapCost >= 4);
  const cfgB = { ...CFG, limits: { ...CFG.limits, maxCreditsPerRun: base + 2 } };
  const c = fakeClient(world({ by }), { max: base + 2 });
  const o = await run({ makeClient: () => c, cfg: cfgB, dir, now: T1, log: () => {} });
  assert.ok(c.spent <= base + 2, `harcanan ${c.spent}`);
  assert.equal(o.wrote, true);
  assert.equal(o.feed.sites.mediamarkt.status, 'ok');
  const g = o.feed.run.stores.mediamarkt.gap;
  assert.equal(g.queried, 1); assert.ok(g.deferred >= 1);
  assert.equal(Object.keys(readJ(dir, 'state.json').gaps.mediamarkt).length, 1, 'aranan karar önbelleğe yazıldı');
});

test('uçtan uca: bütçe kanallar arasında paylaşılır (hiçbir kanal tek başına tüm bütçeyi tüketmez)', async () => {
  // MM'de çok sayıda eksik, Teknosa ve Vatan\'da birer eksik: bütçe MM'ye gidip diğerlerini aç bırakmamalı
  const vtA57 = { ...VT.a17, product_code: 'SM-A576BZAGTUR', slug: 'a57.html', title: 'Samsung Galaxy A57 5G 8/256 Gb Akıllı Telefon Gri', url: 'https://www.vatanbilgisayar.com/a57.html', price: 31999 };
  const mmRows = [MM.a57];
  const by = { teknosa: { 'Galaxy A37': [TK.a37] }, vatan: { 'Galaxy A57': [vtA57] }, mediamarkt: { [EAN_A37]: [MM.a37], [EAN_A17]: [mpRow] } };
  const probe = fakeClient(world({ mm: mmRows, tk: [TK.a57, TK.a17], vt: [VT.a37], by }));
  await run({ makeClient: () => probe, cfg: { ...CFG, limits: { ...CFG.limits, gapCredits: 0 } }, dir: tmp(), now: T1, log: () => {} });
  const base = probe.spent;
  // kanal başına en az 1 sorgu sığsın: MediaMarkt(2) + Teknosa(1) + Vatan(1) = 4 kredi
  const cfgB = { ...CFG, limits: { ...CFG.limits, gapCredits: 4 } };
  const c = fakeClient(world({ mm: mmRows, tk: [TK.a57, TK.a17], vt: [VT.a37], by }));
  const o = await run({ makeClient: () => c, cfg: cfgB, dir: tmp(), now: T1, log: () => {} });
  assert.ok(c.spent - base <= 4, `tamamlama harcaması ${c.spent - base}`);
  const q = (ch) => o.feed.run.stores[ch].gap.queried;
  assert.ok(q('mediamarkt') >= 1 && q('teknosa') >= 1 && q('vatan') >= 1, `dağılım MM ${q('mediamarkt')} TK ${q('teknosa')} VT ${q('vatan')}`);
});

test('yapılandırma: her kanalda tamamlama ayarları makul; en kötü tur harcaması tur sınırını aşmaz (tamamlama bütçesi tur kalanıyla sınırlı)', () => {
  for (const ch of ['mediamarkt', 'teknosa', 'vatan']) {
    const g = CFG.stores[ch].gap;
    assert.equal(g.enabled, true, ch);
    assert.ok(g.maxQueries >= 1 && g.maxQueries <= 20, ch);
    assert.ok(g.retryNotFoundDays >= 1 && g.retryMarketplaceDays >= g.retryNotFoundDays, ch);
  }
  assert.ok(CFG.limits.gapCredits >= 1 && CFG.limits.gapCredits <= 40);
  assert.ok(CFG.limits.maxCreditsPerRun * 2 <= CFG.limits.maxCreditsPerDay, 'iki tur günlük sınıra sığar');
});

// Gerçek yanıtlardan (ReefAPI mediamarkt/search, 2026-11-09, barkodla arama): genel aramada eksik kalan iki ürün.
const REAL_TAB = { product_id: '1246252', title: 'SAMSUNG Galaxy TAB S10FE+ 13.1 12/256GB Tam Dokunmatik Tablet Mavi SM-X620NLBPTUR', brand: 'SAMSUNG', url: 'https://www.mediamarkt.com.tr/tr/product/_samsung-galaxy-tab-s10fe-131-12256gb-tam-dokunmatik-tablet-mavi-sm-x620nlbptur-1246252.html', ean: '8806097196587', currency: 'TRY', price: 38499, was_price: null, was_price_type: null, app_price: null, member_price: null, installment: { months: 6, monthly_amount: 6416.5, total_amount: 38499 }, vat_rate: 0.2, seller: { type: 'retailer', id: null, name: 'MediaMarkt' }, category: 'Samsung Tablet', breadcrumb: ['Bilgisayar', 'Tabletler', 'Android Tabletler', 'Samsung Tablet'], availability: { online_status: 'available', buyable_online: true, delivery_available: true, pickup_available: true }, badges: ['6 Taksit'], refurbished: false, sponsored: false };
const REAL_BUDS = { product_id: '1252509', title: 'SAMSUNG Galaxy Buds4 Bluetooth Kulak İçi Kulaklık Siyah', brand: 'SAMSUNG', url: 'https://www.mediamarkt.com.tr/tr/product/_samsung-galaxy-buds4-bluetooth-kulak-ici-kulaklik-siyah-1252509.html', ean: '8806097998426', currency: 'TRY', price: 7949, was_price: 8999, was_price_type: 'LOP', app_price: null, member_price: null, installment: { months: 9, monthly_amount: 883.22, total_amount: 7949 }, vat_rate: 0.2, seller: { type: 'retailer', id: null, name: 'MediaMarkt' }, category: 'TWS Kulaklık', breadcrumb: ['Telefon', 'Kulaklıklar', 'TWS Kulaklık'], availability: { online_status: 'available', buyable_online: true, delivery_available: true, pickup_available: true }, badges: ['9 Taksit'], refurbished: false, sponsored: false };

test('gerçek satırlar: Tab S10 FE+ Mavi 12/256 ve Buds4 Siyah barkodla bulunur, doğru kategori/fiyat/Web özel yok', async () => {
  const h = (e, p) => ({ results: [p.query === REAL_TAB.ean ? REAL_TAB : REAL_BUDS] });
  const tg = [REAL_TAB.ean, REAL_BUDS.ean].map((k) => ({ key: k, items: [mkItem(tkc, { ...TK.a37, barcode: k })], nch: 1 }));
  const r = await completeGaps({ client: fakeClient(h), mod: mmc, cfg: SC('mediamarkt'), scope: CFG.scope, now: T1, units: toUnits(tg, mmc, SC('mediamarkt')) });
  assert.deepEqual(r.verdicts, { [REAL_TAB.ean]: 'bulundu', [REAL_BUDS.ean]: 'bulundu' });
  const tab = r.items.find((x) => x.key === REAL_TAB.ean), buds = r.items.find((x) => x.key === REAL_BUDS.ean);
  assert.equal(tab.cat, 'tablet'); assert.equal(tab.price, 38499); assert.equal(tab.color, 'mavi'); assert.equal(tab.storage, '256GB'); assert.equal(tab.inStock, true); assert.equal(tab.webExclusive, false);
  assert.equal(buds.cat, 'wearable'); assert.equal(buds.price, 7949); assert.equal(buds.listPrice, 8999); assert.equal(buds.color, 'siyah');
});

// Gerçek yanıtlardan (ReefAPI teknosa/search, 2026-11-09): "Galaxy Tab S10 FE+ ..." araması hedef ürünü barkoduyla getirir.
test('gerçek satır (Teknosa): Tab S10 FE+ Navy Teknosa\'da model adıyla bulunur (barkod 8806097196587), farklı depolama/model hedefi karıştırılmaz', async () => {
  const row = (id, title, barcode, price) => ({ ...TK.a37, product_id: id, title, barcode, price, category: 'Tablet', category_path: ['Bilgisayar & Tablet', 'Tablet'] });
  const rows = [
    row('100000053820', 'Samsung Galaxy Tab S10 FE+ 12/256 GB Navy Tablet - SM-X620', '8806097196587', 38999),
    row('100000053823', 'Samsung Galaxy Tab S10 FE 12/256 GB Navy Tablet - SM-X520', '8806097195115', 31499),
    row('100000053822', 'Samsung Galaxy Tab S10 FE+ 8/128 GB Navy Tablet - SM-X620', '8806097197751', 31999),
  ];
  const mmTab = mkItem(mmc, REAL_TAB); // MediaMarkt'ta Mavi 12/256 (Teknosa'da "Navy")
  const fe = { key: '8806097196587', items: [mmTab], nch: 1 };
  const r = await completeGaps({ client: fakeClient(() => ({ results: rows, total_pages: 2 })), mod: tkc, cfg: SC('teknosa'), scope: CFG.scope, now: T1, units: toUnits([fe], tkc, SC('teknosa')) });
  assert.equal(r.verdicts['8806097196587'], 'bulundu');
  assert.equal(r.items.find((x) => x.key === '8806097196587').price, 38999);
});
