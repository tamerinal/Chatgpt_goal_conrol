# Güvenilir Goal / Session kontrolü planı

Bu public kayıt teknik kapsamı tutar. Özel eski günlükler yerel yedekte korunur.

Etkin iş: public beta teslimi, gizlilik kontrolü, bağımlılık düzeltmeleri, teknik regresyon, paket ve yayın. Ürün politikaları AGENTS.md içindedir. Bu teslim S3–S7 güvenilirlik projesini tamamlanmış saymaz.

S0 başlangıç/veri koruma; S1 olay ve kanıt; S2 doğrulanmış pause; S3 ortak otomatik başlatma kapısı; S4 kalıcı kurtarma; S5 tek Continue/sahiplik; S6 UI/audit; S7 kontrollü kabul/teslim sırası korunur. Teknik kapı ile canlı kabul ayrı kaydedilir. Eksik kapı için PASS verilmez.

Manuel satır Başlat/Durdur otomatik politika kapısından bağımsızdır; otomatik yollar kota/kapsam/cooldown/kapasite kurallarını korur. Sonuç doğrulaması ve writer sınırı bütün yollarda geçerlidir.
