# Test kapıları

- Teknik: typecheck, sahte adaptör/process, izole SQLite unit/integration ve UI component testleri; canlı işlem içermeyen production build/paket doğrulaması.
- Canlı: kullanıcıyla seçilmiş tek bağımsız hedef, açık hedef UUID ve güncel yetki; ekran/düğmeler kullanıcıda. Gerçek işi veya geliştirme sohbetini varsayılan hedef yapma.
- Stop kabulü: doğru thread/turn terminal kanıtı ve Goal durumu ayrı doğrulanır. ACK, idle/notLoaded veya doğal bitiş tek başına başarılı interrupt değildir.
- Start kabulü: aktif turn/çift tıklama, belirsiz dispatch, writer conflict ve native devam yarışı; kör tekrar yoktur.
- Otomatik politika: iki güncel kota, kapsam, cooldown, kapasite ve ayar değişimi. Manuel satır komutları bu yerel engellerden bağımsızdır.
- Kurtarma/restart/stres testleri ayrı kanıt ister. Genel kullanıcı memnuniyet beyanı ayrıntısı bilinmeyen kapılara PASS değildir.
- Yayın: kişisel içerik/secret taraması (geçmiş dahil), installer içeriği, SHA256, kaynak eşleşmesi ve release asset kontrolü. Yeni paket canlı test edilmediyse açıkça belirt.

Her sonuç: tarih, kaynak sürümü, uygulayan, PASS/FAIL/NOT_RUN, kanıt ve sonraki karar. Kanıta hesap/session verisi eklemeyin; özel makbuzları ignore altında veya repo dışında saklayın.
