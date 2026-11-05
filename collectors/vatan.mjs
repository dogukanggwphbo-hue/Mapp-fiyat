// Vatan Bilgisayar: KAPALI. Hiçbir API çağrısı yapılmaz, kredi harcanmaz.
// Neden: ReefAPI'nin Vatan arama/ürün yanıtlarında satıcı alanı yok (canlı testle doğrulandı), EAN de yok.
// Kural gereği satıcısı doğrulanamayan fiyat, mağazanın kendi fiyatı sayılmaz ve gösterilmez.
// İleride Vatan'ın kendi satışı olduğu güvenilir bir kaynaktan doğrulanırsa bu modül yazılıp config.json'dan açılır.
export const STORE = 'vatan';

export async function collect({ cfg }) {
  return {
    store: STORE,
    status: 'unverified',
    items: [],
    stats: { pages: 0, rows: 0, accepted: 0, rejected: {}, credits: 0 },
    error: null,
    note: (cfg && cfg.reason) || 'Satıcı bilgisi doğrulanamadığı için toplanmıyor.',
  };
}
