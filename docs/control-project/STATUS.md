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

## Yayın sonucu

- [PR #1](https://github.com/tamerinal/Chatgpt_goal_conrol/pull/1) merge edildi; kaynak commit `452e709`, merge commit `39f9ae3`. Kullanıcının kişisel bilgi kaldırma talebi kapsamında üç eski commit yeniden yazıldı; remote main yalnız beklenen eski SHA ile eşleşince force-with-lease/atomic güncellendi. Başka uzak çalışma ezilmedi.
- [v0.1.10-beta.8](https://github.com/tamerinal/Chatgpt_goal_conrol/releases/tag/v0.1.10-beta.8) 6 Kasım 2026 11:15 İstanbul'da public prerelease olarak yayımlandı. EXE ve SHA256SUMS.txt mevcut; GitHub asset SHA256 ve boyutu yerel son paketle eşleşiyor. Release hedefi merge commit'idir.
- Uzak depodan yeni bare clone alındı: beş erişilebilir commit içinde eski üç özel commit yok; güncel dal ağacı temizlenmiş geçmişe dayanıyor.
- **Gizlilik kalan işi:** Eski referanssız commit'in GitHub API üzerinden SHA ile hâlâ alınabildiği doğrulandı. Bu nedenle bütün sunucu kopyaları silindi denemez. [GitHub açıklamasına](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository#fully-removing-the-data-from-github) göre sunucu garbage collection/cache temizliği için Support incelemesi gerekir. Destek talebi taslağı eski SHA ayrıntılarıyla yalnız yerel B021 checkpoint'inde hazırlandı; mesaj gönderilmedi. Önceden alınmış clone/fork kopyaları da geri çağrılamaz.

Yayın ve merge tamam. Sıradaki gizlilik adımı: depo sahibinin GitHub Support'a yerel hazır taslakla başvurması; purge sonucu gelmeden tam sunucu silinmesini PASS saymama. Yeni canlı test veya yerel kurulum yapılmadı; geliştirme aşaması ilerletilmedi.
