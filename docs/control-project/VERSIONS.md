# Sürüm ve checkpoint kaydı

- Beta.7: yeşil=Dahil, gri=Hariç kapsam eşlemesi; önceki teknik paket hazır. Kullanıcı önceki işlev testlerini hatasız bildirdi; tüm güvenilirlik kapıları tamamlanmış sayılmaz.
- 6 Kasım 2026 B021: public temizlik öncesi tüm kaynakların SHA256 doğrulamalı yerel checkpoint'i ve üç commit'i içeren Git bundle. Repo dışında korunur. Veri snapshot'ı alınmadı; kullanıcı DB'sine yazılmadı. Yerel konumlar public deftere eklenmez.
- Beta.8: public dokümantasyon, gizlilik temizliği ve bağımlılık güvenlik güncellemeleri. Kesin yayın/test sonuçları STATUS.md'de tutulur. Kaynak geçmişindeki özel kayıtlar da anonimleştirilir; eski checkpoint yalnız yerelde saklanır.
- Beta.8 teknik paket: 130547334 bayt; SHA256 `c45e341c8c0919eba28f643e0dd8d5e5bc91cbf05f652707f713a3df2f7c8395`. Typecheck/136 test/build/NSIS ve offline payload eşleşmesi PASS. Üretim audit 0; build zincirinde 6 moderate uyarı. Yeni kurulum/canlı kabul NOT_RUN.
