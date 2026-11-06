# Yaşayan proje kaydı

## 6 Kasım 2026 — public yayın hazırlığı

Etkin kapsam: kullanıcının public depo kontrolü, kişisel kayıt temizliği, son kurulum paketinin yayımlanması ve merge talebi. Canlı Goal/session, kullanıcı ayarı ve yerel kurulum değişikliği bu çalışmada yapılmaz.

- Başlangıç kaynağı beta.7; temiz çalışma ağacı. Typecheck PASS; 136/136 test, 19/19 dosya PASS.
- Önceki kullanıcı işlev testleri 18 Ekim'de hatasız bildirildi. Bu genel beyan ayrıntısız stres/restart/kurtarma kapılarına PASS değildir.
- Kişisel konuşma/turn kimlikleri, kullanıcıya özel yollar, hesap kullanım test günlükleri ve özel talimat geçmişi public ağaçtan çıkarıldı. Orijinaller repo dışındaki yerel B021 kaynak checkpoint ve Git bundle içinde korunuyor; uygulama DB'si değiştirilmedi.
- Sürüm beta.8: yayın dokümanları, kişisel kayda bağımlı eski test yardımcılarının çıkarılması, sentetik test verileri ve bağımlılık güvenlik düzeltmeleri. Manuel kontrol/scheduler ürün davranışı değiştirilmiyor.
- Beta.8 typecheck PASS, 136/136 test (19/19 dosya) PASS, production build PASS. Electron 44.10.2, Zod 4.6.7, Vite 7.3.7, Vitest 5.1.0, electron-builder 26.18.0 ve uyumlu transitif düzeltmeler kullanıldı.
- İlk npm audit: 14 bulgu (5 high, 9 moderate). Son üretim taraması: 0 bulgu. Tüm geliştirme ağacında electron-builder/minimatch zincirine bağlı 6 moderate bulgu kaldı; npm'nin önerdiği kırıcı builder sürüm değişimi uygulanmadı. High/critical kalmadı. Bu artık risk yalnız build araçları kapsamındadır; genel güvenlik garantisi verilmez.
- Orijinal üç commit'in 127 benzersiz blob'unda erişim anahtarı/private key/JWT kalıbı bulunmadı. Temizlenen geçmişin 85 benzersiz blob'unda ve son kaynak ağacında bilinen kişisel kimlik/yol/görev adı ve secret kalıpları bulunmadı. Regex taraması tam güvenlik denetimi değildir.
- İlk paket taraması SQLite native derleme proje/artıklarında yerel yol buldu; bu paket yayımlanmadı. Paket filtreleriyle vcxproj/filters/sln/gypi/pdb/lib/exp/obj ve test uzantısı çıkarıldı, yalnız runtime native modül unpack edilir.
- Son NSIS build --publish never exit0. Beta.8 EXE: 130547334 bayt; SHA256 `c45e341c8c0919eba28f643e0dd8d5e5bc91cbf05f652707f713a3df2f7c8395`. Beş build dosyası ve dört kaynak asset birebir eşleşti; asar içindeki 278 metin dosyasında hedeflenen secret/kişisel kalıplar bulunmadı. Paketlenmiş 144 dosyada bilinen kişisel değer yok; EXE offline açılıp payload içindeki 144 dosyanın hash'i doğrulanan win-unpacked ile eşleştirildi.
- Paket Electron 44.10.2 ile yalnız ELECTRON_RUN_AS_NODE modunda, gerçek uygulamayı/bağlantıyı açmadan, native SQLite :memory: SELECT 1 PASS. Filtre değişimi runtime modülünü bozmadı.
- Yeni gerçek UI/Goal testi, stres/restart ve yerel kurulum NOT_RUN. Tam güvenilirlik kabulü tamamlanmadı.

Sıradaki adım: son paket içeriği/hash kontrolü, anonimleştirilmiş geçmişin kontrollü güncellenmesi, GitHub PR merge ve beta release doğrulaması. Eski public commit'lerin önceden alınmış kopyaları/cache'leri yerel veya Git ref temizliğiyle geri çağrılamaz.
