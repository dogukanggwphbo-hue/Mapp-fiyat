# MAPP Samsung Desk - Fiyat Motoru

Günde 2 kez (10:30 ve 16:30, Türkiye saati) MediaMarkt ve Teknosa'daki Samsung telefon fiyatlarını toplar ve `data/prices.json` dosyasını günceller.
Uygulama bu dosyayı okur; uygulama açıldığında hiçbir mağazaya sorgu atılmaz.

- Yalnızca mağazanın kendi satışı alınır: MediaMarkt `seller.type = retailer`, Teknosa `is_teknosa = true`. Pazaryeri satıcıları alınmaz.
- Vatan kapalı: API yanıtında satıcı bilgisi olmadığı için doğrulanamıyor.
- Normal fiyat, üstü çizili, uygulama ve üyelik fiyatları ayrı alanlardadır; karşılaştırmaya yalnızca herkese açık güncel fiyat girer.
- API anahtarı yalnızca GitHub gizli kasasında (`REEFAPI_KEY`) durur, hiçbir dosyada yoktur.
- Üç anahtar sırayla kullanılır: her turda sıradaki anahtar öncelikli olur (1. tur → `REEFAPI_KEY`, 2. tur → `REEFAPI_KEY_2`, 3. tur → `REEFAPI_KEY_3`, sonra başa döner). Böylece krediler eşit tükenir.
  Bir anahtarın kredisi biterse (ya da anahtar geçersiz olursa) aynı turda sıradaki anahtarla kesintisiz devam edilir. Kredisi biten anahtar 24 saat boyunca sona alınır; kalan anahtarlar kendi aralarında sırayla dönmeye devam eder. İkincisi de biterse tek kalan anahtarla sürülür.
  Anahtarlar `data/state.json` içinde yalnızca kısa parmak iziyle tutulur; anahtarın kendisi hiçbir yerde yazılmaz. Yeni anahtar eklemek için kod değişikliği gerekmez.
  GitHub > Settings > Secrets and variables > Actions > New repository secret > Name: `REEFAPI_KEY_2` (ya da `_3`), Secret: yeni anahtar.
- Zamanlama: 10:25 ve 16:25'te başlar (tur birkaç dakika sürer, veri 10:30 / 16:30'da güncel olur); 30 dakika sonrasına yedek tur konur, asıl tur çalıştıysa yedek kendiliğinden atlanır (kredi harcamaz). GitHub'ın zamanlayıcısı geç kalabileceği için aynı saatlerde GitHub'dan bağımsız bir zamanlanmış görev de iş akışını başlatır.
- Elle deneme: Actions > Fiyat güncelle > Run workflow. `dry` = kuru tur (kredi harcamaz, yalnızca çalışıp çalışmayacağını ve anahtar sırasını gösterir), `force` = sınırı yoksayan gerçek deneme turu, `key_slot` = yalnızca 2. ya da 3. anahtarla dene.
- MediaMarkt tamamlama turu: MediaMarkt'ın anahtar sözcük aramaları eksiksiz değildir (sonuç listesi sınırlıdır, sıra turdan tura kayar); satışta olan bazı ürünler genel aramada hiç görünmeyebilir (ör. Tab S10 FE+ Mavi 12/256, Buds4 Siyah).
  Genel taramadan sonra, Vatan/Teknosa'da bulunan ama bu turda MediaMarkt'ta görülmeyen barkodlu ürünler için barkodun kendisiyle doğrudan arama yapılır (sorgu başına 2 kredi, tur başına en fazla 12 sorgu; `config.json` > `stores.mediamarkt.gap`).
  Kabul kuralı aynıdır: yalnızca MediaMarkt'ın kendi satışı (`seller.type = retailer`); pazaryeri satıcısı yine alınmaz. Bulunamayan ya da yalnızca pazaryerinde olan ürünler `data/state.json` içindeki `gaps` kaydında tutulur ve 3 / 7 gün boyunca yeniden aranmaz (kredi israfı olmasın).
  Genel taramanın bulamadığı ama barkodla bulunan ürünler her turda yeniden aranır (fiyatı taze kalsın, önbellekten düşmesin). Genel tarama çökmüşse ya da tur bütçesi dolmuşsa tamamlama atlanır; tur bozulmaz. Sonuç `prices.json` > `run.stores.mediamarkt.gap` içinde görünür.
- Günlük sınır: en fazla 2 tur; tur başına 110, gün başına 220 kredi (`config.json`). İki tur arası en az 3 saat.

Veri kaynağı ReefAPI'dir; mağazaların resmi API'si değildir.
