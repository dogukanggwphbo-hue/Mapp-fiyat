# MAPP Samsung Desk - Fiyat Motoru

Günde 2 kez (06:00 ve 18:00, Türkiye saati) MediaMarkt ve Teknosa'daki Samsung telefon fiyatlarını toplar ve `data/prices.json` dosyasını günceller.
Uygulama bu dosyayı okur; uygulama açıldığında hiçbir mağazaya sorgu atılmaz.

- Yalnızca mağazanın kendi satışı alınır: MediaMarkt `seller.type = retailer`, Teknosa `is_teknosa = true`. Pazaryeri satıcıları alınmaz.
- Vatan kapalı: API yanıtında satıcı bilgisi olmadığı için doğrulanamıyor.
- Normal fiyat, üstü çizili, uygulama ve üyelik fiyatları ayrı alanlardadır; karşılaştırmaya yalnızca herkese açık güncel fiyat girer.
- API anahtarı yalnızca GitHub gizli kasasında (`REEFAPI_KEY`) durur, hiçbir dosyada yoktur.
- Yedek anahtar: `REEFAPI_KEY_2` ve `REEFAPI_KEY_3` gizli kasaya eklenirse, ilk anahtarın kredisi bitince (ya da anahtar geçersiz olunca) motor aynı turda sıradaki anahtarla kesintisiz devam eder.
  Kredisi biten anahtar 24 saat boyunca sona alınır (`data/state.json` içinde yalnızca kısa parmak iziyle tutulur; anahtarın kendisi hiçbir yerde yazılmaz). Yeni üyelik anahtarını eklemek için kod değişikliği gerekmez.
  GitHub > Settings > Secrets and variables > Actions > New repository secret > Name: `REEFAPI_KEY_2`, Secret: yeni anahtar.
- Günlük sınır: en fazla 2 tur; tur başına 40, gün başına 80 kredi (`config.json`).

Veri kaynağı ReefAPI'dir; mağazaların resmi API'si değildir.
