# 0.1.10-beta.8

- Windows kurulum ve ilk ortak Codex bağlantı adımları README'ye eklendi.
- Kişisel geliştirme günlükleri, gerçek konuşma kimlikleri, hesap kullanım kanıtları ve bilgisayara özel yollar public kaynak/geçmişten çıkarıldı. Özel eski kayıtlar yerel yedekte korunur.
- Test verileri sentetikleştirildi; özel eski hedefe bağlı iki canlı tanı script'i kaldırıldı. Salt okunur gözlemci sohbet mesaj içeriğini yazdırmaz.
- Electron 44.10.2 ve uyumlu bağımlılık güvenlik güncellemeleri. Typecheck, 136 test ve production build PASS. Üretim bağımlılık taraması 0 bulgu; geliştirme/paketleme araçlarında 6 moderate minimatch zinciri uyarısı sürüyor (high/critical yok).
- Native SQLite derleme artıkları ve bilgisayar yolu içeren proje dosyaları kurulum paketinden çıkarıldı; runtime modülü korundu.
- Beta.7 kapsam düzeltmesi korunur: yeşil=Dahil, gri=Hariç. Manuel Başlat/Durdur ve otomatik politika davranışı korunur.

Bu sürüm deneysel Windows x64 betadır. Yeni canlı UI/Goal, kurulum ve stres/restart kabulü yapılmadı. Kod imzası yoktur. Tüm güvenilirlik projesinin tamamlandığı anlamına gelmez.

Kurulum: Releases içindeki EXE'yi indirin, SHA256SUMS.txt ile doğrulayın, açık Controller'dan Exit ile çıkıp aynı kullanıcı hesabına kurun. Uygulama verisini silmeyin. İlk bağlantı ve ayar ayrıntıları README.md içindedir.
