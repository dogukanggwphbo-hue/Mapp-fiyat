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

test('günlük tur hakkı: elle başlatılan (force) deneme turu 10:00 / 14:30 turlarının hakkından düşmez', async () => {
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

test('MediaMarkt sayfalama: gerçek son sayfa page_count\'tur (max_page sitenin 30 sınırıdır); fazladan sayfa istenmez', async () => {
  const { fakeClient } = await import('./fixtures.mjs');
  const mm = await import('../collectors/mediamarkt.mjs');
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const row = { product_id: '1', title: 'SAMSUNG Galaxy A57 5G 8/256GB Akıllı Telefon Siyah', brand: 'SAMSUNG', url: 'https://www.mediamarkt.com.tr/tr/product/_a57-1.html', ean: '8806099044916', price: 30999, seller: { type: 'retailer', name: 'MediaMarkt' }, category: 'Samsung Telefon', breadcrumb: ['Telefon', 'Cep Telefonları'], availability: { online_status: 'available', buyable_online: true }, refurbished: false };
  const c = fakeClient((engine, params) => ({ results: [row], max_page: 30, page_count: 2, page: params.page }));
  await mm.collect({ client: c, cfg: cfg.stores.mediamarkt, scope: ['phone'], now: new Date('2026-11-05T03:00:00Z') });
  assert.equal(c.calls.length, 2, 'page_count=2 iken yalnızca 2 sayfa istenmeli');
});

test('config: MediaMarkt telefon taraması tüm sayfaları (21+) kapsar; en kötü tur ve gün kredisi sınırlar içinde', async () => {
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const ph = cfg.stores.mediamarkt.queries.find((q) => q.scope === 'phone');
  assert.ok(ph.maxPages >= 22);
  let worst = 0;
  for (const st of Object.values(cfg.stores)) if (st.enabled) for (const q of st.queries) if (cfg.scope.includes(q.scope)) worst += q.maxPages * st.creditsPerCall;
  assert.ok(worst <= cfg.limits.maxCreditsPerRun && worst * cfg.limits.maxRunsPerDay <= cfg.limits.maxCreditsPerDay);
});

test('saat/kulaklık: "SiyahKablolu" gibi yapışık yazımda renk ayrıştırılır (Teknosa EO-IC100B)', () => {
  const t = E('teknosa', 'wearable', 'Samsung EO-IC100B Type-C SiyahKablolu Kulak İçi Kulaklık');
  const m = E('mediamarkt', 'wearable', 'SAMSUNG EO-IC100B Kulak İçi Kablolu Kulak Siyah');
  const b = E('teknosa', 'wearable', 'Samsung EO-IC100B Type-C Kablolu Beyaz Kukak İçi Kulaklık');
  assert.equal(features(t).color, 'siyah');
  assert.equal(linkItems([t, m, b]), 1);
  assert.ok(same(t, m)); assert.notEqual(b.key, t.key);
});

test('yedek zamanlar: son 2 saatte başarılı tur varsa yedek tur atlanır; ikinci asıl tur (4,5 saat sonra) atlanmaz; elle (force) ya da başarısız tur sayılmaz', async () => {
  const { recentRun } = await import('../lib/store.mjs');
  const st = (runs) => ({ runs });
  const G = 2; // config.json > limits.minGapHours
  const sabah = { at: '2026-11-07T06:57:00Z', credits: 70, ok: true, force: false }; // 09:57 TR (10:00 turu)
  assert.equal(recentRun(st([sabah]), new Date('2026-11-07T07:25:00Z'), G), true);   // 10:25 yedek, asıl tur çalışmış → atla
  assert.equal(recentRun(st([sabah]), new Date('2026-11-07T11:25:00Z'), G), false);  // 14:25 öğlen turu (4,5 saat sonra) → çalışır
  assert.equal(recentRun(st([sabah]), new Date('2026-11-07T11:55:00Z'), G), false);  // 14:55 yedek, öğlen turu henüz yok → çalışır
  assert.equal(recentRun(st([]), new Date('2026-11-07T07:25:00Z'), G), false);       // asıl tur hiç çalışmadı → yedek çalışır
  assert.equal(recentRun(st([{ ...sabah, ok: false }]), new Date('2026-11-07T07:25:00Z'), G), false); // asıl tur başarısızdı → yedek dener
  assert.equal(recentRun(st([{ ...sabah, force: true }]), new Date('2026-11-07T07:25:00Z'), G), false); // elle tur hakkı yemez
  const ogle = { at: '2026-11-07T11:27:00Z', credits: 70, ok: true, force: false };
  assert.equal(recentRun(st([sabah, ogle]), new Date('2026-11-07T11:55:00Z'), G), true);  // öğlen yedeği atlanır
  // sabah turu GitHub'da 1,5 saat gecikse bile (11:30 TR'de bitse) öğlen turu atlanmaz
  const gec = { at: '2026-11-07T08:30:00Z', credits: 70, ok: true, force: false };
  assert.equal(recentRun(st([gec]), new Date('2026-11-07T11:25:00Z'), G), false);
});

test('zamanlama: iş akışı 09:55 / 10:25 / 14:25 / 14:55 (Türkiye) saatlerinde çalışır; yedekler asıl turdan 30 dk sonradır', async () => {
  const fs = await import('node:fs');
  const yml = fs.readFileSync(new URL('../.github/workflows/fiyat.yml', import.meta.url), 'utf8');
  const crons = [...yml.matchAll(/^\s*-\s*cron:\s*'(\d+)\s+(\d+)\s+\*\s+\*\s+\*'/gm)].map((m) => ({ min: Number(m[1]), hr: Number(m[2]) }));
  const tr = crons.map((c) => `${String((c.hr + 3) % 24).padStart(2, '0')}:${String(c.min).padStart(2, '0')}`);
  assert.deepEqual(tr, ['09:55', '10:25', '14:25', '14:55']);
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(cfg.limits.minGapHours, 2);
  // iki asıl tur arası (4,5 saat) minGapHours'tan büyük, yedek (30 dk) küçük olmalı
  assert.ok(cfg.limits.minGapHours * 60 > 30 && cfg.limits.minGapHours * 60 < 270);
});

test("fiyat geçmişi: kampanya (Web'e Özel) fiyatı bitince prevWeb=true saklanır; fiyat değişmezse korunur; normal fiyat değişimi prevWeb=false", async () => {
  const { mergeItems } = await import('../lib/store.mjs');
  const t0 = '2026-11-05T20:00:00.000Z', t1 = '2026-11-06T08:00:00.000Z', t2 = '2026-11-06T16:00:00.000Z';
  const base = (price, extra) => ({ ch: 'vatan', key: 'k1', name: 'Galaxy S26 Ultra', label: 'Galaxy S26 Ultra', price, checkedAt: t0, ...extra });
  // 1) web özel fiyat (98.999) -> normal fiyat (119.999)
  let out = mergeItems([base(98999, { webExclusive: true, tags: ["Web'e Özel"] })], [base(119999, { checkedAt: t1 })], t1, 3);
  assert.equal(out[0].prev, 98999); assert.equal(out[0].prevWeb, true); assert.equal(out[0].since, t1);
  // 2) fiyat değişmedi: prevWeb korunur
  out = mergeItems(out, [base(119999, { checkedAt: t2 })], t2, 3);
  assert.equal(out[0].prevWeb, true); assert.equal(out[0].since, t1);
  // 3) normal fiyat değişimi: prevWeb false
  out = mergeItems([base(100000)], [base(110000, { checkedAt: t1 })], t1, 3);
  assert.equal(out[0].prevWeb, false);
  // 4) yalnızca etiketle işaretli (webExclusive alanı yok)
  out = mergeItems([base(5000, { tags: ["Web'e Özel"] })], [base(6000, { checkedAt: t1 })], t1, 3);
  assert.equal(out[0].prevWeb, true);
  // 5) ilk gözlem: prevWeb yok
  out = mergeItems([], [base(5000)], t1, 3);
  assert.equal(out[0].prevWeb, undefined);
});

test('tablet: Teknosa "Navy" = Vatan/MediaMarkt "Mavi", Vatan "Red" = "Mercan" (aynı ürün, renk eşanlamlısı)', () => {
  const t = E('teknosa', 'tablet', 'Samsung Galaxy Tab S10 FE+ 12/256 GB Navy Tablet - SM-X620', { storage: 256, ram: 12 });
  const v = L('vatan', 'tablet', "Samsung Galaxy Tab S10 Fe+ 256Gb 12GB-13.1''Android Tablet SM-X620NLBPTUR Mavi", 'SM-X620NLBPTUR', { storage: 256, ram: 12 });
  assert.ok(linkItems([t, v]) >= 1);
  assert.ok(same(t, v));
  assert.equal(v.ownKey, 'v:sm-x620nlbptur', 'kalıcı kimlik korunur');
  const m = E('mediamarkt', 'tablet', 'SAMSUNG Galaxy Tab S10 Lite 6/128 GB Tablet Mercan', { storage: 128, ram: 6 });
  const k = L('vatan', 'tablet', "Samsung Galaxy Tab S10 Lite 2Ghz 128Gb 6Gb 10.9''Android Tablet Red", 'SM-X400NZRRTUR', { storage: 128, ram: 6 });
  linkItems([m, k]);
  assert.ok(same(m, k));
});

test('telefon: lacivert ile mavi AYRI renktir (yalnız tablette eşanlamlı); Navy/Icy Blue karışmaz', () => {
  const n = E('teknosa', 'phone', 'Samsung Galaxy S25 FE 5G 8/256GB Navy Akıllı Telefon', { storage: 256, ram: 8 });
  const b = E('mediamarkt', 'phone', 'SAMSUNG Galaxy S25 FE 5G 8/256GB Akıllı Telefon Mavi', { storage: 256, ram: 8 });
  assert.equal(linkItems([n, b]), 0);
  assert.notEqual(n.key, b.key);
});

test('renk ailesi: barkodsuz Vatan "Açık Pembe / Çam Yeşili / Gök Mavisi" kaydı, ailede tek aday olan "Pembe / Yeşil / Mavi" ile bağlanır', () => {
  const t = E('teknosa', 'phone', 'Samsung Galaxy A27 5G 8GB RAM 256GB Pembe Akıllı Telefon', { storage: 256, ram: 8 });
  const v = L('vatan', 'phone', 'Samsung Galaxy A27 5G 8/256 GB Akıllı Telefon Açık Pembe', 'SM-A276BLICTUR', { storage: 256, ram: 8 });
  assert.equal(linkItems([t, v]), 1);
  assert.ok(same(t, v));
  assert.equal(v.match, 'model');
  assert.equal(v.ownKey, 'v:sm-a276blictur', 'kalıcı kimlik korunur');
  const t2 = E('teknosa', 'phone', 'Samsung Galaxy S26 Ultra 5G 12/512GB Mavi Akıllı Telefon', { storage: 512, ram: 12 });
  const v2 = L('vatan', 'phone', 'Samsung Galaxy S26 Ultra 5G 12/512 Gb Akıllı Telefon Gök Mavisi', 'SM-S948BLBGTUR', { storage: 512, ram: 12 });
  linkItems([t2, v2]);
  assert.ok(same(t2, v2));
  // renk sözcüğü ters yönde de çalışır: barkodlu kayıtta "Kobalt Siyah", barkodsuzda "Siyah"
  const m3 = E('mediamarkt', 'phone', 'SAMSUNG Galaxy S26 Ultra 5G 16GB/1TB Akıllı Telefon Kobalt Siyah', { storage: 1024, ram: 16 });
  const v3 = L('vatan', 'phone', 'Samsung Galaxy S26 Ultra 5G 16/1 TB Akıllı Telefon Siyah', 'SM-S948BZKHTUR', { storage: 1024, ram: 16 });
  linkItems([m3, v3]);
  assert.ok(same(m3, v3));
});

test('renk ailesi: belirsizlikte (ailede birden fazla aday) ya da kapsamayan renklerde (açık mavi / koyu mavi) bağlanmaz', () => {
  // Vatan "Mavi" için iki ayrı mavi tonu var: hangisi olduğu belli değil -> bağlama
  const a = E('teknosa', 'phone', 'Samsung Galaxy A37 5G 8/256GB Açık Mavi Akıllı Telefon', { storage: 256, ram: 8 });
  const b = E('mediamarkt', 'phone', 'SAMSUNG Galaxy A37 5G 8/256GB Akıllı Telefon Koyu Mavi', { storage: 256, ram: 8 });
  const v = L('vatan', 'phone', 'Samsung Galaxy A37 5G 8/256 GB Akıllı Telefon Mavi', 'SM-A376BMVGTUR', { storage: 256, ram: 8 });
  assert.equal(linkItems([a, b, v]), 0);
  assert.ok(new Set([a.key, b.key, v.key]).size === 3);
  // açık mavi ile koyu mavi birbirini kapsamaz
  const c = E('teknosa', 'phone', 'Samsung Galaxy A37 5G 8/256GB Açık Mavi Akıllı Telefon', { storage: 256, ram: 8 });
  const d = L('vatan', 'phone', 'Samsung Galaxy A37 5G 8/256 GB Akıllı Telefon Koyu Mavi', 'SM-A376BDBGTUR', { storage: 256, ram: 8 });
  assert.equal(linkItems([c, d]), 0);
});

test('renk ailesi: iki ayrı barkodlu ürün birleştirilmez; RAM / depolama / model çelişkisinde bağlanmaz', () => {
  const x = E('teknosa', 'phone', 'Samsung Galaxy A37 5G 8/256GB Pembe Akıllı Telefon', { storage: 256, ram: 8 });
  const y = E('mediamarkt', 'phone', 'SAMSUNG Galaxy A37 8/256GB Akıllı Telefon Açık Pembe', { storage: 256, ram: 8 });
  assert.equal(linkItems([x, y]), 0, 'iki barkodlu kayıt: farklı ürün olabilir');
  const t = E('teknosa', 'phone', 'Samsung Galaxy A27 5G 8GB RAM 256GB Pembe Akıllı Telefon', { storage: 256, ram: 8 });
  const v = L('vatan', 'phone', 'Samsung Galaxy A27 5G 6/256 GB Akıllı Telefon Açık Pembe', 'SM-A276BLIETUR', { storage: 256, ram: 6 });
  assert.equal(linkItems([t, v]), 0, 'RAM çelişkisi');
  const t5 = E('teknosa', 'phone', 'Samsung Galaxy A27 5G 8GB RAM 256GB Pembe Akıllı Telefon', { storage: 256, ram: 8 });
  const v5 = L('vatan', 'phone', 'Samsung Galaxy A27 5G 8/128 GB Akıllı Telefon Açık Pembe', 'SM-A276BLIDTUR', { storage: 128, ram: 8 });
  assert.equal(linkItems([t5, v5]), 0, 'depolama çelişkisi');
  const o = E('teknosa', 'phone', 'Samsung Galaxy A37 5G 8/256GB Pembe Akıllı Telefon', { storage: 256, ram: 8 });
  const w = L('vatan', 'phone', 'Samsung Galaxy A27 5G 8/256 GB Akıllı Telefon Açık Pembe', 'SM-A276BLICTUR', { storage: 256, ram: 8 });
  assert.equal(linkItems([o, w]), 0, 'farklı model');
});

test('renk ailesi: aynı kanalda iki aday varsa bağlanmaz; tekrar çalıştırmak sonucu değiştirmez (idempotent)', () => {
  const t = E('teknosa', 'phone', 'Samsung Galaxy A27 5G 8GB RAM 256GB Pembe Akıllı Telefon', { storage: 256, ram: 8 });
  const v = L('vatan', 'phone', 'Samsung Galaxy A27 5G 8/256 GB Akıllı Telefon Açık Pembe', 'SM-A276BLICTUR', { storage: 256, ram: 8 });
  const t2 = E('teknosa', 'phone', 'Samsung Galaxy A27 5G 8GB RAM 256GB Pembe Akıllı Telefon', { storage: 256, ram: 8 });
  assert.equal(linkItems([t, t2, v]), 0, 'Teknosa tarafında aynı renkte iki farklı ürün: belirsiz');
  const t3 = E('teknosa', 'phone', 'Samsung Galaxy A27 5G 8GB RAM 256GB Pembe Akıllı Telefon', { storage: 256, ram: 8 });
  const v3 = L('vatan', 'phone', 'Samsung Galaxy A27 5G 8/256 GB Akıllı Telefon Açık Pembe', 'SM-A276BLICTUR', { storage: 256, ram: 8 });
  const items = [t3, v3];
  linkItems(items);
  const k1 = items.map((i) => i.key).join();
  linkItems(items);
  assert.equal(items.map((i) => i.key).join(), k1);
  assert.equal(v3.ownKey, 'v:sm-a276blictur');
});
