# Güvenilir Goal / Session kontrolü çalışma kuralları

Önce docs/control-project/PLAN.md, STATUS.md, TEST-GATES.md ve GOAL-PROMPT.md dosyalarını okuyun. Güncel kullanıcı talimatı önceliklidir.

- Mevcut kullanıcı değişikliklerini ve verilerini koruyun; temiz checkout varsaymayın.
- Yalnız etkin aşamayı uygulayın; eksik test kapısını geçmiş saymayın.
- Her çalışma sonunda STATUS.md ve VERSIONS.md kayıtlarını gerçek sonuçlarla güncelleyin.
- Typecheck, sahte adaptör/izole DB testleri ve canlı işlem başlatmayan build çalıştırılabilir.
- Gerçek uygulama ekranı ve canlı Goal/session testlerini kullanıcı yürütür; sonucu bekleyin. UUID açıkça teyit edilmeden hedef seçmeyin. Geliştirme sohbetini veya gerçek işleri varsayılan test hedefi yapmayın.
- Canlı start/interrupt, session mesajı, kurulum, DB onarımı ve yayın için güncel kullanıcı yetkisi gerekir. Test hazırlama yetkisi düğmelere basma yetkisi değildir.
- Otomatik approval, writer zorla devralma, belirsiz dispatch için kör tekrar ve test kapısını aşan otomasyon yoktur.
- Kendi sohbetini kesebilecek testten önce checkpoint ve kullanıcının yeniden devam yolu hazırlanır.
- Manuel Başlat yerel kota/cooldown/kapasite ve Dahil/Hariç engellerinden bağımsızdır; Durdur Goal pause ve aktif session interrupt ister. İkisi kapsamı değiştirmez. Otomatik yollar kendi kurallarını korur.
- Yeşil/açık kapsam anahtarı Dahil (excluded=false), gri/kapalı Hariç (excluded=true) demektir; global otomatik kontrol veya çalışma durumu değildir.
- Kişisel konuşma kimliklerini, hesap/kullanım kayıtlarını, auth verisini ve bilgisayara özel yolları Git'e koymayın. Yerel kanıt/yedekler ignore altında veya repo dışında tutulur.
