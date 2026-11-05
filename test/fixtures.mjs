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
