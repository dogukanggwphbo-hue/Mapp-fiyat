// Test verileri: ReefAPI canlı testinde (2026-11-05) gelen gerçek satırların alanlarına göre kurgulanmıştır.
// 'SENTETİK' işaretliler pazaryeri/aykırı durumları denemek için eklenmiştir.
import { BudgetError, ReefError } from '../lib/reef.mjs';

const mmAv = (buyable = true) => ({ online_status: 'available', buyable_online: buyable, delivery_available: true, pickup_available: true });
const mmSeller = { type: 'retailer', id: null, name: 'MediaMarkt', rating: null, rating_scale: null };
const mmBase = (o) => ({
  brand: 'SAMSUNG', currency: 'TRY', was_price: null, was_price_type: null, discount_amount: null, discount_percent: null,
  app_price: null, member_price: null, installment: null, vat_rate: 0.2, seller: mmSeller, refurbished: false, sponsored: false,
  availability: mmAv(), category: 'Samsung Telefon',
  breadcrumb: ['Telefon', 'Cep Telefonları', 'Android Telefonlar', 'Samsung Telefon'], ...o,
});
const mmUrl = (slug, id) => `https://www.mediamarkt.com.tr/tr/product/_${slug}-${id}.html`;

export const MM = {
  a57: mmBase({ product_id: '1253247', title: 'SAMSUNG Galaxy A57 8/256GB Akıllı Telefon Gri', ean: '8806099044916', price: 31999, url: mmUrl('samsung-galaxy-a57-8256gb-akilli-telefon-gri', '1253247') }),
  s26u: mmBase({ product_id: '1252474', title: 'SAMSUNG Galaxy S26 Ultra 5G 12/512 GB Akıllı Telefon Kobalt Mor', ean: '8806097867159', price: 89989, was_price: 89999, was_price_type: 'LOP', url: mmUrl('samsung-galaxy-s26-ultra', '1252474') }),
  a08: mmBase({ product_id: '1257274', title: 'SAMSUNG Galaxy A08 LTE 4/128GB Akıllı Telefon Gümüş', ean: '8806099447298', price: 11789, was_price: 11799, was_price_type: 'LOP', url: mmUrl('samsung-galaxy-a08', '1257274') }),
  a37: mmBase({ product_id: '1253264', title: 'SAMSUNG Galaxy A37 8/256GB Akıllı Telefon Antrasit', ean: '8806099054953', price: 26999, url: mmUrl('samsung-galaxy-a37', '1253264') }),
  tab: mmBase({ product_id: '1250156', title: 'SAMSUNG Galaxy Tab A11 4/64GB Tam Dokunmatik Tablet Gri', ean: '8806097804215', price: 5489, category: 'Samsung Tablet', breadcrumb: ['Bilgisayar', 'Tabletler', 'Android Tabletler', 'Samsung Tablet'], url: mmUrl('samsung-galaxy-tab-a11', '1250156') }),
  // SENTETİK
  market: mmBase({ product_id: '9990001', title: 'SAMSUNG Galaxy A57 8/256GB Akıllı Telefon Lila', ean: '8806099044787', price: 20999, seller: { type: 'marketplace', id: '77', name: 'Bilişim Firması', rating: 4.1, rating_scale: 5 }, url: mmUrl('samsung-galaxy-a57-lila', '9990001') }),
  wrongName: mmBase({ product_id: '9990002', title: 'SAMSUNG Galaxy A17 5G 8/256GB Akıllı Telefon Siyah', ean: '8806097660842', price: 18199, seller: { type: 'retailer', id: null, name: 'Başka Mağaza', rating: null, rating_scale: null }, url: mmUrl('samsung-galaxy-a17', '9990002') }),
  refurb: mmBase({ product_id: '9990003', title: 'SAMSUNG Galaxy S26 5G 12/256GB Akıllı Telefon Siyah', ean: '8806097869689', price: 40000, refurbished: true, url: mmUrl('samsung-galaxy-s26', '9990003') }),
  otherBrand: mmBase({ product_id: '9990004', title: 'APPLE iPhone 17 256GB Akıllı Telefon Siyah', brand: 'APPLE', ean: '0194253000000', price: 70000, url: mmUrl('iphone-17', '9990004') }),
  kinds: mmBase({ product_id: '9990005', title: 'SAMSUNG Galaxy A17 5G 8/256GB Akıllı Telefon Gri', ean: '8806097660859', price: 18199, was_price: 19199, was_price_type: 'LOP', app_price: 17500, member_price: 17000, url: mmUrl('samsung-galaxy-a17-gri', '9990005') }),
  oos: mmBase({ product_id: '9990006', title: 'SAMSUNG Galaxy A27 5G 8/256GB Akıllı Telefon Siyah', ean: '8806099359300', price: 21499, availability: mmAv(false), url: mmUrl('samsung-galaxy-a27', '9990006') }),
};

// Tablet / rozet / sepet fiyatı örnekleri: ReefAPI canlı yanıtlarına (2026-11-05) göre; 'SENTETİK' işaretliler eklenmiştir.
const tabBase = (o) => mmBase({ category: 'Samsung Tablet', breadcrumb: ['Bilgisayar', 'Tabletler', 'Android Tabletler', 'Samsung Tablet'], ...o });
export const MMX = {
  webTab: tabBase({ product_id: '1250156', title: 'SAMSUNG Galaxy Tab A11 4/64GB Tam Dokunmatik Tablet Gri', ean: '8806097804215', price: 5489, was_price: 5499, was_price_type: 'LOP', badges: ["Web'e Özel"], installment: { months: 6, monthly_amount: 914.83, total_amount: 5489 }, url: mmUrl('samsung-galaxy-tab-a11-464gb', '1250156') }),
  // Gerçek: fiyat sepet indirimli (38.999 × 0,95), taksit toplamı raf fiyatı
  cartTab: tabBase({ product_id: '1246250', title: 'SAMSUNG Galaxy TAB S10FE+ 13.1 12/256GB Tam Dokunmatik Tablet Gümüş SM-X620NZSPTU', ean: '8806097196990', price: 37049.05, badges: ['2000 TL üzeri alışverişte sepette indirim'], installment: { months: 6, monthly_amount: 6499.83, total_amount: 38999 }, url: mmUrl('samsung-galaxy-tab-s10fe-131', '1246250') }),
  // SENTETİK: sepet rozeti var ama raf fiyatı kanıtlanamıyor (taksit bilgisi yok)
  cartUnknown: tabBase({ product_id: '9990101', title: 'SAMSUNG Galaxy Tab S9 FE 6/128GB Tablet Gri', ean: '8806095106903', price: 15000, badges: ['Sepette %5 indirim'], installment: null, url: mmUrl('samsung-galaxy-tab-s9-fe', '9990101') }),
  // SENTETİK: sepet rozeti var ama fiyat zaten raf fiyatı (taksit toplamı = fiyat)
  cartSame: tabBase({ product_id: '9990102', title: 'SAMSUNG Galaxy Tab A11+ 8/256 GB Tablet Gri', ean: '8806097860266', price: 13999, badges: ['2000 TL üzeri alışverişte sepette indirim'], installment: { months: 6, monthly_amount: 2333.17, total_amount: 13999 }, url: mmUrl('samsung-galaxy-tab-a11-plus', '9990102') }),
};

const tkBase = (o) => ({
  brand: 'Samsung', currency: 'TRY', sponsored: false, was_price: null, discount_percent: null, discount_amount: null, member_price: null,
  member_price_label: null, installment: null, seller: { name: 'TEKNOSA', shop_id: '1001', is_teknosa: true }, in_stock: true,
  category: 'Cep Telefonu', category_path: ['Telefon', 'Cep Telefonu', 'Android Telefon'], mpn: null, badges: [], ...o,
});
const tkUrl = (slug, id) => `https://www.teknosa.com/${slug}-p-${id}?shopId=teknosa`;

export const TK = {
  a57: tkBase({ product_id: '100000062357', title: 'Samsung Galaxy A57 5G 8/256GB Gri Akıllı Telefon', barcode: '8806099044916', price: 31999, was_price: 35499, discount_percent: 10, discount_amount: 3500, url: tkUrl('samsung-galaxy-a57-5g-8256gb-gri-akilli-telefon', '100000062357') }),
  a37: tkBase({ product_id: '100000062355', title: 'Samsung Galaxy A37 5G 8/256GB Antrasit Akıllı Telefon', barcode: '8806099054953', price: 26999, url: tkUrl('samsung-galaxy-a37-5g-8256gb-antrasit-akilli-telefon', '100000062355') }),
  a17: tkBase({ product_id: '100000058142', title: 'Samsung Galaxy A17 5G 8/256GB Gri Akıllı Telefon', barcode: '8806097660859', price: 18199, url: tkUrl('samsung-galaxy-a17-5g-8256gb-gri-akilli-telefon', '100000058142') }),
  // SENTETİK
  market: tkBase({ product_id: '5550001', title: 'Samsung Galaxy A57 5G 8/256GB Lila Akıllı Telefon', barcode: '8806099044787', price: 20999, seller: { name: 'Le Balvo', shop_id: '8543', is_teknosa: false }, url: tkUrl('samsung-galaxy-a57-lila', '5550001') }),
  marketNamedTeknosa: tkBase({ product_id: '5550002', title: 'Samsung Galaxy S26 5G 12/256GB Mor Akıllı Telefon', barcode: '8806097868484', price: 50000, seller: { name: 'TEKNOSA', shop_id: '8888', is_teknosa: false }, url: tkUrl('samsung-galaxy-s26-mor', '5550002') }),
  preo: tkBase({ product_id: '5550003', title: 'Preo Samsung Galaxy S26 Akıllı Telefon Kılıfı', brand: 'Preo-Teknosa Markasıdır.', barcode: '', price: 399, url: tkUrl('preo-kilif', '5550003') }),
  service: tkBase({ product_id: '5550004', title: 'Samsung Galaxy S26 Ultra Ekran Kırılma Sigortası', brand: 'Samsung', category: 'Kurulum, Destek ve Servis Paketleri', category_path: ['Kurulum, Destek ve Servis Paketleri'], barcode: '', price: 2999, url: tkUrl('ekran-sigortasi', '5550004') }),
  member: tkBase({ product_id: '5550005', title: 'Samsung Galaxy S26+ 5G 12/256GB Mor Akıllı Telefon', barcode: '8806097865865', price: 77999, member_price: 74999, member_price_label: 'TeknoClub', url: tkUrl('samsung-galaxy-s26-plus-mor', '5550005') }),
};

/** Sahte ReefAPI istemcisi: handler(engine, params) → data nesnesi; kredi ve sınır gerçek istemci gibi işler. */

// Vatan: ReefAPI canlı yanıtından (2026-11-05, vatan/search) alınan gerçek satırlar; 'SENTETİK' işaretliler eklenmiştir.
const vtBase = (o) => ({ position: 1, slug: 'x.html', product_code: 'SM-X', title: '', url: 'https://www.vatanbilgisayar.com/x.html', image: '', images: [], price: 1000, currency: 'TRY', regular_price: null, price_label: null, price_note: null, was_price: null, discount_percent: null, discount_amount: null, basket_price: null, basket_price_label: null, rating_rounded: null, lowest_price_note: null, web_exclusive_badge: null, color_options: null, color_options_out_of_stock: null, is_outlet: null, badge_images: [], ...o });
const vtUrl = (s) => `https://www.vatanbilgisayar.com/${s}.html`;
export const VT = {
  a37: vtBase({ product_code: 'SM-A376BZAGTUR', slug: 'samsung-galaxy-a37-5g-8-256-gb-akilli-telefon.html', title: 'Samsung Galaxy A37 5G 8/256 GB Akıllı Telefon Antrasit', url: vtUrl('samsung-galaxy-a37-5g-8-256-gb-akilli-telefon'), price: 26999, basket_price: 24839, basket_price_label: "Gece'ye özel sepette" }),
  a27: vtBase({ product_code: 'SM-A276BZKCTUR', slug: 'samsung-galaxy-a27-5g-8-256-gb-akilli-telefon.html', title: 'Samsung Galaxy A27 5G 8/256 GB Akıllı Telefon Siyah', url: vtUrl('samsung-galaxy-a27-5g-8-256-gb-akilli-telefon'), price: 21499, basket_price: 19779, basket_price_label: "Gece'ye özel sepette" }),
  a27pembe: vtBase({ product_code: 'SM-A276BLICTUR', slug: 'samsung-galaxy-a27-5g-8-256-gb-akilli-telefon-acik-pembe.html', title: 'Samsung Galaxy A27 5G 8/256 GB Akıllı Telefon Açık Pembe', url: vtUrl('samsung-galaxy-a27-5g-8-256-gb-akilli-telefon-acik-pembe'), price: 18999, regular_price: 21499, price_label: "Web'e Özel", price_note: 'Son 28 Ürün' }),
  a17: vtBase({ product_code: 'SM-A176BZKDTUR', slug: 'samsung-galaxy-a17-8-256-gb-akilli-telefon-siyah.html', title: 'Samsung Galaxy A17 5G 8/256 Gb Akıllı Telefon Siyah', url: vtUrl('samsung-galaxy-a17-8-256-gb-akilli-telefon-siyah'), price: 18199 }),
  s25fe: vtBase({ product_code: 'SM-S731BDBGTUR', slug: 'samsung-galaxy-s25-fe-8-256-gb-akilli-telefon-lacivert.html', title: 'Samsung Galaxy S25 FE 5G 8/256 Gb Akıllı Telefon Lacivert', url: vtUrl('samsung-galaxy-s25-fe-8-256-gb-akilli-telefon-lacivert'), price: 38949 }),
  // SENTETİK: MediaMarkt başlığındaki uzun model koduyla (SM-X620NZSPTU) eşleşir
  tabByCode: vtBase({ product_code: 'SM-X620NZSPTU', slug: 'samsung-galaxy-tab-s10-fe-plus.html', title: 'Samsung Galaxy Tab S10 FE+ Tablet', url: vtUrl('samsung-galaxy-tab-s10-fe-plus'), price: 38999 }),
  // SENTETİK: reddedilmesi gerekenler
  outlet: vtBase({ product_code: 'SM-OUT000001', slug: 'o.html', title: 'Samsung Galaxy S24 128 GB Akıllı Telefon Siyah', url: vtUrl('o'), price: 20000, is_outlet: true }),
  used: vtBase({ product_code: 'SM-USED00001', slug: 'u.html', title: 'Samsung Galaxy S23 256 GB Yenilenmiş Akıllı Telefon', url: vtUrl('u'), price: 18000 }),
  otherBrand: vtBase({ product_code: 'MYE23TU/A', slug: 'i.html', title: 'Apple iPhone 17 256 GB Akıllı Telefon Siyah', url: vtUrl('i'), price: 70000 }),
  badHost: vtBase({ product_code: 'SM-HOST00001', slug: 'h.html', title: 'Samsung Galaxy A57 5G 8/256 GB Akıllı Telefon Gri', url: 'https://baska-site.com/h', price: 30000 }),
};

export function fakeClient(handler, { max = Infinity } = {}) {
  const st = { spent: 0, calls: [] };
  return {
    async call(engine, action, params, { cost = 1 } = {}) {
      if (st.spent + cost > max) throw new BudgetError('Kredi sınırı');
      st.calls.push({ engine, action, params });
      const data = handler(engine, params);
      st.spent += cost;
      return { ok: true, data, meta: { charged_credits: cost } };
    },
    get spent() { return st.spent; },
    get calls() { return st.calls; },
  };
}
export { ReefError };
