# Feasibility Report — Phase 1

Araştırma tarihi: 15 Eylül 2026

## Sonuç matrisi

| Yetenek | Sonuç | Kullanılan yüzey |
| --- | --- | --- |
| Yerel Codex thread keşfi | Official / Supported | `thread/list` |
| Thread Goal okuma | Official / Supported | `thread/goal/get` |
| Goal pause/resume | Official / Supported; Phase 2 doğrulaması gerekli | `thread/goal/set` ile `paused` / `active` |
| Aktif turu kesme | Official / Supported; seçilen yumuşak pause modelinde kullanılmaz | `turn/interrupt` |
| ChatGPT kullanım yüzdeleri ve reset zamanları | Official / Supported | `account/rateLimits/read` |
| Bulut ChatGPT Work Goal yönetimi | Belgelenmiş yerel arayüzde yok | Phase 1 dışında |
| ChatGPT dahili backend endpoint'leri | Unofficial | Kullanılmıyor |
| Browser automation | Teknik olarak mümkün, kırılgan | Kullanılmıyor |

Kaynak: [OpenAI Docs — Codex App Server](https://learn.chatgpt.com/docs/app-server)

Phase 1 smoke testi, mevcut ChatGPT kimlik doğrulamasıyla 300 dakikalık ve 10.080 dakikalık kullanım pencerelerini okuyabildi ve yerel Goal keşfini tamamladı. Test hiçbir uzak yazma çağrısı göndermedi.

## Mimari

Electron main process şu sorumlulukları taşır:

1. `codex.exe app-server --stdio` yaşam döngüsü ve JSON-RPC bağlantısı.
2. Kullanım/Goal normalizasyonu, scheduler ve policy değerlendirmesi.
3. SQLite kalıcılığı ve audit kayıtları.
4. Tray, uygulama yaşam döngüsü ve dar IPC köprüsü.

Sandbox içindeki React renderer yalnızca snapshot gösterir ve izin verilen ayar/komutları typed IPC ile main process'e gönderir. Uzak pause/resume metotları adapter sözleşmesinde bulunur ancak Phase 1 uygulaması her çağrıda hata vererek fail-closed davranır.

## Veri modeli

- `goals`: Remote ve runtime durumları, priority, controller ownership, dışlama ve zamanlar.
- `goal_events`: Remote/runtime durum geçişleri.
- `usage_history`: İki kullanım penceresi ve reset zamanları.
- `controller_actions`: Dry-run önerileri, hatalar ve sistem olayları.
- `settings`: Doğrulanmış controller ayarları.
- `policy_state`: Hysteresis için geçerli minimum priority.
- `current_proposals`: Yalnızca en son cycle'ın UI önerileri.

## Scheduler

Her cycle tekil çalışır: kullanım oku → Goal keşfet → normalize et → SQLite'a yaz → fail-safe kontrolü → iki pencereyi AND ile değerlendir → priority/concurrency/cooldown uygula → dry-run önerilerini audit'e yaz → snapshot yayınla.

Kullanım verisi eksik veya hatalıysa `MONITORING_ERROR` oluşur, mevcut öneriler temizlenir ve uzak işlem yapılmaz. Kullanımın belirgin düşmesi veya reset zamanının ilerlemesi reset olayı olarak kaydedilir.

## Riskler ve Phase 2 kapısı

- App Server sözleşmesi sürümle değişebilir; uygulama sürümü gösterir ve bozuk payload'da fail-closed davranır.
- Ayrı App Server sürecinin masaüstü uygulamasında çalışan Goal continuation'ını durdurup devam ettirmesi, test Goal'ıyla kanıtlanmadan Phase 2 açılmayacaktır.
- Goal pause aktörü remote payload'da verilmez; ownership yalnızca başarılı controller aksiyon kayıtlarından çıkarılacaktır.
- ChatGPT oturum süresi dolarsa App Server hatası gösterilir; uygulama parola, cookie veya token saklamaz.
- Kullanım pencereleri payload konumuna göre değil `windowDurationMins` değerlerine göre seçilir; gerekli iki pencere yoksa işlem yapılmaz.
- Browser otomasyonu ve undocumented backend endpoint'leri otomatik fallback değildir.
