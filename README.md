# ChatGPT Goal Controller

Windows için deneysel tray uygulaması. Aynı bilgisayardaki Codex Goal'larını ve hesap kullanım pencerelerini izler; seçilen Goal'ları kota kurallarına göre duraklatıp devam ettirebilir. Bulut ChatGPT görevlerini yöneten resmî bir OpenAI ürünü değildir.

## Windows kurulumu

1. [Son sürümü indirin](https://github.com/tamerinal/Chatgpt_goal_conrol/releases). `ChatGPT.Goal.Controller.Setup.0.1.10-beta.8.exe` dosyasını kullanın. Kaynak kod ZIP'i kurulum paketi değildir.
2. İsterseniz indirilen dosyanın SHA256 değerini release içindeki `SHA256SUMS.txt` ile karşılaştırın:

   ```powershell
   Get-FileHash .\ChatGPT.Goal.Controller.Setup.0.1.10-beta.8.exe -Algorithm SHA256
   ```

3. Açık Controller varsa tray menüsünden **Exit** ile çıkın. Kurulum dosyasını çalıştırıp kullanıcı hesabınız için kurun. Mevcut ayarları korumak için aynı kullanıcı hesabını kullanın; uygulama verisini silmeyin.
4. Codex Desktop ve hesabınızda Goal desteği gerekir. Codex'e kendi hesabınızla giriş yapın. Controller parola, cookie veya erişim anahtarı istemez.

Paket kod imzalı değildir; Windows yayıncıyı doğrulayamayabilir. Kurulum dosyası ve checksum yalnız bu deponun Releases sayfasından edinilmelidir. Bu beta Windows x64 için hazırlanır.

## İlk bağlantı

1. Controller ayarlarında **Otomatik değerlendirme** seçeneğini kapatın. Yeni kurulumda varsayılanı açıktır; yeni keşfedilen Goal'lar başlangıçta Hariç tutulur.
2. Codex Desktop'tan tamamen çıkın. Controller'da **Codex ile ortak bağlantıyı aç** düğmesine basın. Helper açık Desktop'ı kapatmaz veya writer kontrolünü zorla devralmaz.
3. **Şimdi Kontrol Et** ile Goal listesini ve kotayı doğrulayın.
4. Önce ayrı, önemsiz bir test Goal'unda Başlat/Durdur davranışını kontrol edin. Ardından yöneteceğiniz Goal'ları Dahil yapıp istediğiniz rezervleri, kapasiteyi ve otomatik değerlendirmeyi ayarlayın.

Desktop ve Controller aynı `127.0.0.1:4509` sunucusunu kullanır. Sonraki açılışlarda da Controller'ın ortak bağlantı düğmesini kullanın; normal Codex kısayolu ayrı bağlantı açabilir. Helper ortam değişkenlerini yalnız açtığı sürece verir. Başka bir sunucuya otomatik fallback veya writer devralma yapılmaz.

## Başlat, Durdur ve kapsam

- **Başlat:** Otomatik kontrol kapalı veya Goal Hariç olsa da başlatmayı ister. Yerel kota, cooldown ve kapasite engellerini uygulamaz. Sunucu limitleri ve writer erişimi geçerlidir.
- **Durdur:** Goal'u duraklatır ve aktif session'ı kesmeyi ister. Goal ve turn sonuçları ayrı doğrulanır; belirsiz sonuç başarı sayılmaz ve kör tekrar edilmez.
- **Yeşil/açık = Dahil**, **gri/kapalı = Hariç**. Anahtar yalnız otomatik yönetim kapsamını gösterir. Manuel düğmeler kapsamı değiştirmez.
- Dahil bir Goal, otomatik değerlendirme açıkken sonraki döngüde kurallara göre yeniden başlayabilir. Durdur düğmesi kalıcı Hariç seçimi değildir.
- Otomatik yollar güncel iki kota penceresi, Goal override, cooldown ve kapasite kurallarını uygular. Controller ek Continue mesajı üretmek yerine Codex'in native Goal devamını bekler. Approval taleplerini otomatik yanıtlamaz.

## Veriler ve sorun giderme

Yerel ayarlar, Goal özeti, kullanım ve işlem geçmişi `%APPDATA%\chatgpt-goal-controller\goal-controller.db` içinde saklanır. Bu dosya kişisel içerik barındırabilir; GitHub'a yüklemeyin. Ortak bağlantı günlükleri `%LOCALAPPDATA%\ChatGPT Goal Controller\shared-codex\` altındadır. Yedek almadan uygulama verisini silmeyin. Controller'dan çıkmak ortak Codex sunucusunu veya devam eden işi öldürmez.

Bağlantı hatasında önce Desktop'ın tamamen kapalı olduğunu doğrulayıp ortak bağlantı düğmesini kullanın. Writer conflict durumunda başka uygulamanın kontrolünü zorlamayın. Hata bildirirken token, auth dosyası, DB, konuşma kimliği, kişisel dosya yolu ve ham session çıktısını paylaşmayın.

Beta.7'de kapsam anahtarının renk eşlemesi düzeltildi. Beta.8 herkese açık yayın hazırlığı, kişisel kayıt temizliği ve bağımlılık güvenlik güncellemelerini içerir. Önceki kullanıcı işlev testleri olumlu bildirilmiştir; bu sürüm için yeni canlı UI/Goal testi yapılmamıştır. Kalıcı kurtarma, stres/restart ve tüm güvenilirlik kabul kapıları tamamlanmış sayılmaz. Desktop ortak bağlantısı sürüme bağlı deneysel bir entegrasyondur.

## Kaynaktan geliştirme

Node.js 22.12+ ve npm, Windows paketlemesi için Windows x64 gerekir. Native SQLite modülü gerektiğinde derleme araçlarına ihtiyaç duyabilir. Kurulum lifecycle script'leri Electron'u indirip native bağımlılıkları hazırlayabilir; canlı Goal başlatmaz.

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

Geliştirme uygulamasını açmak için `npm run dev` kullanılır; bu komut gerçek hesaba bağlanabilir. Teknik testler sahte adaptörler ve izole DB kullanır. `smoke:app-server`, `stress:app-server` ve canlı fixture script'leri teknik test suite'inin parçası değildir; açık hedef/operatör yetkisi olmadan çalıştırılmamalıdır.

Windows kurulum paketi üretmek için:

```powershell
npm run package:win -- --publish never
```

Çıktı `release/0.1.10-beta.8/` altına yazılır. Paketleme uygulamayı kurmaz veya otomatik yayınlamaz. Release notları ve teknik doğrulama durumu [proje kaydında](docs/control-project/STATUS.md) tutulur.
