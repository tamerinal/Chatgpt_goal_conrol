# ChatGPT Goal Controller

## 0.1.10-beta.6 bağımsız satır kontrolleri

Her Goal satırındaki **Başlat**, otomatik kontrol kapalı veya Goal Hariç olsa da yerel kota, cooldown ve kapasite kurallarını uygulamadan başlatmayı ister. **Durdur**, ilgili Goal'u duraklatır ve aktif session'ı keser; otomatik execution seçeneği bunu engellemez. İki düğme Dahil/Hariç seçimini değiştirmez. Goal Dahil ve otomatik kontrol açıksa sonraki kontrol kendi kurallarına göre yeniden başlatabilir veya durdurabilir; açık Dahil seçimi de duraklatılmış Goal'u otomatik devam adayı yapar. Sunucunun kendi limitleri ve writer erişimi geçerlidir, sonuç doğrulanmadan başarı yazılmaz. Belirsiz start kör tekrarlanmaz.

Kota okuma hatasında son bilinen Goal satırları açıkça etiketlenerek korunur; manuel işlem kendi güncel hedef okumasını yapar. Beta.6 teknik olarak test edildi; kurulu beta.5 ve bekleyen gerçek ekran/fixture testi STATUS.md'de kayıtlıdır.


Windows tray uygulaması olarak çalışan, aynı bilgisayardaki yerel Codex Goal'larını ve hesap kullanım pencerelerini izleyen deneysel kontrol uygulaması.

## 0.1.10-beta.2 bağlantısı

Windows Desktop varsayılan olarak kendi stdio sunucusunu açar; beta.1'in daemon proxy varsayımı bu bilgisayarda çalışmadı. Beta.2, Desktop ile Controller'ı aynı `127.0.0.1:4509` sunucusuna bağlar. Ayrı sunucuya otomatik fallback yoktur. Desktop açıkken helper çalışmayı reddeder; açık uygulamayı kapatmaz veya writer'ı devralmaz.

İlk kullanım: otomatik kontrolü ayarlardan kapatın, Codex Desktop'tan tamamen çıkın; Controller'da **Codex ile ortak bağlantıyı aç** düğmesine basın. Sonra **Şimdi Kontrol Et** ile listeyi doğrulayın. Yalnız test hedefini dahil edip kullanıcıyla pause/resume doğrulaması yapın; ardından istenen otomatik kontrol ayarını geri getirin. Sonraki açılışlarda bu düğmeyle Codex'i açın; normal Codex kısayolu varsayılan stdio modunu kullanır.

Helper mevcut kullanıcı kurulumunu bulur, gizli ortak sunucuyu başlatır veya kendi PID/başlangıç zamanı/executable/port kaydıyla doğruladığı sunucuyu kullanır. Günlükler `%LOCALAPPDATA%/ChatGPT Goal Controller/shared-codex/` altındadır. Desktop ortam değişkeni yalnız açılan sürece verilir; kalıcı sistem/hesap/config değişikliği yapılmaz. Controller'ın kapanması sadece kendi bağlantılarını kapatır; ortak sunucuyu veya devam eden işi öldürmez.

WebSocket taşıması resmî belgede deneysel/desteklenmeyen olarak tanımlanır; Desktop ortam değişkeni mevcut kurulu sürümün statik kaynağında görülmüştür, stabil Desktop API garantisi değildir: [App Server](https://learn.chatgpt.com/docs/app-server). İzole gerçek CLI testinde iki istemcinin aynı thread'i ve Goal değişikliğini gördüğü doğrulandı. Gerçek Desktop ekranında pause/resume kabulü bekleniyor.

Controller ayrı ChatGPT oturumu açmaz; kimlik doğrulamasını mevcut Codex sunucusu yönetir. Parola/cookie/token Controller veritabanına yazılmaz. Bu sürüm farklı bilgisayarlara uzaktan bağlanmaz.

Goal durumu ve sohbet çalışması ayrı doğrulanır. Goal aktif olunca Codex'in kendi Goal devam mekanizması beklenir; Controller ek `Continue`/`turn/start` mesajı üretmez. Yazma kontrolü başka süreçteyse sonuç doğrulanmış başarı sayılmaz. Bekleyen kullanıcı soruları otomatik yanıtlanmaz.

Bu sürüm canlı `thread/goal/set`, `thread/resume` ve gerektiğinde `turn/interrupt` gönderebilir; dry-run değildir. Kota ve kapsam ayarları korunur. Teknik testlerin geçmesi gerçek pause/resume kabulü değildir. Güvenilirlik planındaki kalıcı kurtarma ve tüm canlı kabul kapıları henüz tamamlanmamıştır.

## Durumlar

- **Goal durumu:** Codex'in hedef için bildirdiği yaşam döngüsü.
- **Çalışma:** Aynı sunucudan gözlenen session/turn; yüklü olmayan oturum durmuş varsayılmaz.
- **Yönetim / kapsam:** Yerel politika kaydı; writer erişim yetkisi değildir.
- **İşlem günlüğü:** Başarı, atlama ve hata ayrıntıları satırın altında gösterilir.

Tray, pencere ve Windows executable ikonları PNG/çok boyutlu ICO olarak paketlenir.

## Geliştirme

```powershell
npm install
npm test
npm run dev
```

Windows kurulum paketi:

```powershell
npm run package:win -- --publish never
```

Paket `release/0.1.10-beta.2/` altında üretilir. Kurulum ve canlı uygulama/Goal testleri kullanıcıyla yapılır. `smoke:app-server` ve `stress:app-server` gerçek sunucuya bağlanan geliştirme araçlarıdır; teknik test komutu değildir. `check-isolated-shared-server.ts --isolated-transport-check` ise boş geçici CODEX_HOME kullanır; hesap kopyalamaz, model turn'ü başlatmaz, yalnız sentetik thread/Goal ile gerçek taşıma davranışını sınar.
