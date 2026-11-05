// Kanallar arası eşleştirme (imza tabanlı) testleri. Başlıklar canlı veriden alınmıştır.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkItems, features } from '../lib/link.mjs';

let n = 0;
// barkodlu (EAN) kayıt: kendi anahtarı barkod
const E = (ch, cat, name, o = {}) => {
  const ean = o.ean || String(8806099000000 + ++n);
  return { ch, cat, name, label: name, ean, key: ean, ownKey: null, match: 'ean', ram: null, storage: null, ...o };
};
// barkodsuz kayıt: kendi anahtarı kod
const L = (ch, cat, name, code, o = {}) => ({
  ch, cat, name, label: name, ean: null, key: 'v:' + code.toLowerCase(), ownKey: 'v:' + code.toLowerCase(), match: 'baslik', ram: null, storage: null, ...o,
});
const same = (...xs) => xs.every((x) => x.key === xs[0].key);

test('saat: Watch9 / Watch 9 yazım farkı, mm ve renk aynıysa bağlanır (Vatan kodsuz, MM ve Teknosa barkodlu)', () => {
  const m = E('mediamarkt', 'wearable', 'SAMSUNG Galaxy Watch 9 44 mm Akıllı Saat Koyu Gri');
  const v = L('vatan', 'wearable', 'Samsung Galaxy Watch9 44mm Koyu Gri', 'SM-L350NZKATUR');
  const t = E('teknosa', 'wearable', 'Samsung Galaxy Watch9 44mm Koyu Gri');
  assert.equal(linkItems([m, v, t]), 2);
  assert.ok(same(m, v, t));
  assert.equal(v.match, 'model');
  assert.equal(v.ownKey, 'v:sm-l350nzkatur', 'kalıcı kimlik korunur');
});

test('saat: farklı mm, farklı renk veya LTE/Bluetooth farkı bağlanmaz', () => {
  const a = E('mediamarkt', 'wearable', 'SAMSUNG Galaxy Watch 8 44mm Akıllı Saat Gümüş');
  const mm40 = L('vatan', 'wearable', 'Samsung Galaxy Watch8 40mm Gümüş', 'SM-L320NZSATUR');
  const renk = L('teknosa', 'wearable', 'Samsung Galaxy Watch8 44mm Koyu Gri', 'x1');
  assert.equal(linkItems([a, mm40, renk]), 0);
  const bt = E('mediamarkt', 'wearable', 'SAMSUNG Galaxy Watch 8 Classic 46mm Beyaz');
  const lte = L('vatan', 'wearable', 'Samsung Galaxy Watch8 Classic 46mm LTE Beyaz', 'SM-L510NZWATUR');
  assert.equal(linkItems([bt, lte]), 0);
});

test('saat: boyutu (mm) olmayan saat bağlanmaz; Ultra tek boyutlu olduğundan renk yeterlidir', () => {
  const m = E('mediamarkt', 'wearable', 'SAMSUNG Galaxy Watch 9 44 mm Akıllı Saat Gümüş');
  const t = E('teknosa', 'wearable', 'Samsung Galaxy Watch9 Gümüş');
  assert.equal(linkItems([m, t]), 0, 'boyutsuz Watch9 hangi mm olduğu belli olmadığından bağlanmaz');
  const um = E('mediamarkt', 'wearable', 'SAMSUNG Galaxy Watch Ultra 2 Bluetooth Akıllı Saat Titanyum');
  const uv = L('vatan', 'wearable', 'Samsung Galaxy Watch Ultra2 BT Titanyum', 'SM-L705NZTATUR');
  assert.equal(linkItems([um, uv]), 1);
  assert.ok(same(um, uv));
  const u25 = E('teknosa', 'wearable', 'Samsung Galaxy Watch Ultra 2025 Titanyum');
  assert.equal(linkItems([um, uv, u25]), 1, 'Ultra 2 ile Ultra 2025 ayrı modeldir');
});

test('kulaklık: Buds modeli ve rengi aynıysa bağlanır; Buds4 ile Buds4 Pro karışmaz', () => {
  const m = E('mediamarkt', 'wearable', 'SAMSUNG Galaxy Buds4 Bluetooth Kulak İçi Kulaklık Beyaz');
  const t = E('teknosa', 'wearable', 'Samsung Galaxy Buds4 Beyaz');
  const tp = E('teknosa', 'wearable', 'Samsung Galaxy Buds4 Pro Beyaz');
  assert.equal(linkItems([m, t, tp]), 1);
  assert.ok(same(m, t));
  assert.notEqual(tp.key, m.key);
});

test('tablet: yapışık model kodu, 12Gb 256Gb, Gray/Silver rengi ve Fe/FE yazımı tek ürün sayılır', () => {
  const m = E('mediamarkt', 'tablet', 'SAMSUNG TAB S12 Ultra 12/256GB Gri', { ram: 12, storage: '256GB' });
  const v = L('vatan', 'tablet', 'Samsung Galaxy TabletSM-X940NZARTUR Tab S12 Ultra 12Gb 256Gb Gray', 'SM-X940NZARTUR', { ram: 12, storage: '256GB' });
  assert.equal(linkItems([m, v]), 1);
  assert.ok(same(m, v));
  const a = E('mediamarkt', 'tablet', 'SAMSUNG Galaxy Tab S10 FE 8/256GB Gri', { ram: 8, storage: '256GB' });
  const b = L('teknosa', 'tablet', 'Samsung Galaxy Tab S10 Fe 8GB 256GB Gri', 'tk1', { ram: 8, storage: '256GB' });
  assert.equal(linkItems([a, b]), 1);
  assert.ok(same(a, b));
});

test('tablet: Wi-Fi (yalın) ile 5G / LTE sürümleri ve farklı depolama bağlanmaz', () => {
  const w = E('mediamarkt', 'tablet', 'SAMSUNG Galaxy Tab S10 FE 8/256GB Gri', { ram: 8, storage: '256GB' });
  const g = L('vatan', 'tablet', 'Samsung Galaxy Tab S10 FE 5G 8/256GB Gri', 'SM-X526BZAETUR', { ram: 8, storage: '256GB' });
  const s = L('teknosa', 'tablet', 'Samsung Galaxy Tab S10 FE 8/128GB Gri', 'tk2', { ram: 8, storage: '128GB' });
  assert.equal(linkItems([w, g, s]), 0);
});

test('telefon: depolama, renk ve 5G farkı bağlanmaz; RAM bilinmiyorsa çelişki yoksa bağlanır', () => {
  const a = E('mediamarkt', 'phone', 'SAMSUNG Galaxy A57 5G 8/256GB Akıllı Telefon Siyah', { ram: 8, storage: '256GB' });
  const ok = L('vatan', 'phone', 'Samsung Galaxy A57 5G 256GB Siyah', 'SM-A576BZKDTUR', { ram: null, storage: '256GB' });
  const stor = L('teknosa', 'phone', 'Samsung Galaxy A57 5G 8/128GB Siyah', 'tk3', { ram: 8, storage: '128GB' });
  assert.equal(linkItems([a, ok, stor]), 1);
  assert.ok(same(a, ok));
  assert.notEqual(stor.key, a.key);
  const lte = L('teknosa', 'phone', 'Samsung Galaxy A57 8/256GB Siyah', 'tk4', { ram: 8, storage: '256GB' });
  assert.equal(linkItems([a, ok, stor, lte]), 1, '5G ile 5G olmayan sürüm karışmaz');
});

test('telefon: RAM çelişkisi (8 / 12) olan adaylar ayrı kalır; RAM\'i bilinmeyen kayıt belirsiz olduğundan bağlanmaz', () => {
  const a = E('mediamarkt', 'phone', 'SAMSUNG Galaxy S26 5G 8/256GB Siyah', { ram: 8, storage: '256GB' });
  const b = E('teknosa', 'phone', 'Samsung Galaxy S26 5G 12/256GB Siyah', { ram: 12, storage: '256GB' });
  assert.equal(linkItems([a, b]), 0);
  const w = L('vatan', 'phone', 'Samsung Galaxy S26 5G 256GB Siyah', 'SM-S942BZKDTUR', { ram: null, storage: '256GB' });
  assert.equal(linkItems([a, b, w]), 0);
});

test('adaptör: kısa kod (EP-T…) + renk; başlıkta rengi olmayan kayıt kodun tek rengini alır', () => {
  const m = E('mediamarkt', 'adapter', 'SAMSUNG EP-T6530N Type-C & Type-A Üçlü Hızlı Şarj Aleti Siyah');
  const v = L('vatan', 'adapter', 'SAMSUNG EP-T6530N TYPE-C & TYPE-A HIZLI ŞARJ ALETİ ÜÇLÜ', 'EP-T6530NBEGEU');
  assert.equal(linkItems([m, v]), 1);
  assert.ok(same(m, v));
  // farklı kod bağlanmaz
  const o = E('teknosa', 'adapter', 'SAMSUNG EP-T4511N 45W Hızlı Şarj Aleti Siyah');
  assert.equal(linkItems([m, v, o]), 1);
  assert.notEqual(o.key, m.key);
});

test('kategori karışmaz: aynı sözcükleri taşıyan farklı kategorideki kayıtlar bağlanmaz', () => {
  const a = E('mediamarkt', 'phone', 'SAMSUNG Galaxy A57 5G 8/256GB Siyah', { ram: 8, storage: '256GB' });
  const b = L('vatan', 'adapter', 'Samsung Galaxy A57 5G 8/256GB Siyah', 'zz1', { ram: 8, storage: '256GB' });
  assert.equal(linkItems([a, b]), 0);
});

test('idempotent: ikinci çalıştırma aynı sonucu verir; ortada kalan kayıt kendi kimliğine döner', () => {
  const m = E('mediamarkt', 'wearable', 'SAMSUNG Galaxy Watch 9 40 mm Akıllı Saat Krem');
  const v = L('vatan', 'wearable', 'Samsung Galaxy Watch9 40mm Krem', 'SM-L300NZEATUR');
  assert.equal(linkItems([m, v]), 1);
  const k = v.key;
  assert.equal(linkItems([m, v]), 1);
  assert.equal(v.key, k);
  assert.equal(linkItems([v]), 0);
  assert.equal(v.key, v.ownKey);
  assert.equal(v.match, 'baslik');
});

test('barkodlu kaydın yeniden anahtarlanması ownKey ile geçmişi korur (barkod ayrı kalır)', () => {
  const m = E('mediamarkt', 'wearable', 'SAMSUNG Galaxy Watch 9 40 mm Akıllı Saat Krem', { ean: '8806099325428' });
  const t = E('teknosa', 'wearable', 'Samsung Galaxy Watch9 40mm Krem', { ean: '8806099999999' });
  assert.equal(linkItems([m, t]), 1);
  const moved = m.key === t.key && (m.ownKey || t.ownKey);
  assert.ok(moved, 'barkodlu kayıt taşındığında ownKey set edilir');
  assert.equal(linkItems([m, t]), 1);
  const rm = m.ownKey ? m : t;
  assert.equal(rm.match, 'model');
  linkItems([rm]);
  assert.equal(rm.key, rm.ownKey);
  assert.equal(rm.match, 'ean');
});

test('features: renk ve model ayrıştırma', () => {
  const f = features({ name: 'Samsung Galaxy Watch Ultra2 BT Titanyum Gri', label: 'Samsung Galaxy Watch Ultra2 BT Titanyum Gri', cat: 'wearable' });
  assert.equal(f.model, 'watchultra2');
  assert.equal(f.color, 'titanyum gri');
  const g = features({ name: 'Samsung Galaxy Watch8 Classic 46mm LTE Beyaz', cat: 'wearable' });
  assert.equal(g.size, '46');
  assert.equal(g.lte, true);
});

test('önbellek: önceki turdan kalan yenilenmiş / outlet kayıt artık tutulmaz, normal kayıt tutulur', async () => {
  const { mergeItems } = await import('../lib/store.mjs');
  const now = '2026-11-06T08:00:00.000Z';
  const old = '2026-11-05T08:00:00.000Z';
  const prev = [
    { ch: 'mediamarkt', key: 'a', name: 'SAMSUNG Yenilenmiş G1 Galaxy Watch 5 Pro 45mm Akıllı Saat', price: 6999, checkedAt: old },
    { ch: 'mediamarkt', key: 'b', name: 'SAMSUNG Galaxy Watch 8 40mm Akıllı Saat Gümüş', price: 13999, checkedAt: old },
  ];
  const out = mergeItems(prev, [], now, 3);
  assert.deepEqual(out.map((i) => i.key), ['b']);
});

test('günlük tur hakkı: elle başlatılan (force) deneme turu 11:00 / 19:00 turlarının hakkından düşmez', async () => {
  const { runsToday } = await import('../lib/store.mjs');
  const now = new Date('2026-11-06T08:00:00Z');
  const state = { runs: [
    { at: '2026-11-05T22:58:00Z', credits: 70, ok: true, force: false }, // 06 Kasım 01:58 TR (zamanlanmış gibi sayılır)
    { at: '2026-11-06T00:10:00Z', credits: 78, ok: true, force: true },  // elle deneme turu
  ] };
  const t = runsToday(state, now, 'Europe/Istanbul');
  assert.equal(t.length, 1);
  assert.equal(t[0].force, false);
});

test('kulaklık: "Kablosuz" / "Kablolu" sözcüğü kablo (aksesuar) sayılmaz; Vatan "Buds4 ANC" başlığı Teknosa/MediaMarkt "Buds4" ile bağlanır', async () => {
  const { classify } = await import('../lib/normalize.mjs');
  assert.equal(classify('SAMSUNG Galaxy Buds4 ANC Kulak İçi Kablosuz Bluetooth Kulaklık - Siyah'), 'wearable');
  assert.equal(classify('SAMSUNG EO-IC100B TYPE-C KABLOLU KULAKLIK - SİYAH'), 'wearable');
  assert.equal(classify('Samsung 1.8m USB-C Şarj Kablosu Siyah'), 'accessory');
  assert.equal(classify('Samsung Kablosuz Şarj Standı Siyah'), 'accessory');
  const t = E('teknosa', 'wearable', 'Samsung Galaxy Buds4 Siyah');
  const v = L('vatan', 'wearable', 'SAMSUNG Galaxy Buds4 ANC Kulak İçi Kablosuz Bluetooth Kulaklık - Siyah', 'SM-R540NZKATUR');
  const tp = E('teknosa', 'wearable', 'Samsung Galaxy Buds4 Pro Beyaz');
  const vp = L('vatan', 'wearable', 'SAMSUNG Galaxy Buds4 Pro ANC Kulak İçi Kablosuz Bluetooth Kulaklık - Beyaz', 'SM-R640NZWATUR');
  assert.equal(linkItems([t, v, tp, vp]), 2);
  assert.ok(same(t, v)); assert.ok(same(tp, vp)); assert.notEqual(t.key, tp.key);
  // kablolu kulaklık: EO-IC100B kodu + renk
  const m = E('mediamarkt', 'wearable', 'SAMSUNG EO-IC100B Kulak İçi Kablolu Kulak Siyah');
  const vw = L('vatan', 'wearable', 'SAMSUNG EO-IC100B TYPE-C KABLOLU KULAKLIK - SİYAH', 'EO-IC100BBEGWW');
  assert.equal(linkItems([m, vw]), 1);
});
