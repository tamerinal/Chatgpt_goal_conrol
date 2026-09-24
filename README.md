# ChatGPT Goal Controller

Windows system tray uygulaması olarak çalışan, yerel Codex Goal'larını ve paylaşılan ChatGPT kullanım pencerelerini izleyen Phase 1 prototipi.

## Güvenlik sınırı

Bu sürüm daima dry-run modundadır. `thread/goal/set` ve `turn/interrupt` göndermez; yalnızca önerilen pause/resume kararlarını yerel audit kaydına yazar.

## Geliştirme

```powershell
npm install
npm test
npm run smoke:app-server
npm run dev
```

Windows kurulum paketi:

```powershell
npm run package:win
```

Uygulama `codex.exe app-server --stdio` başlatır ve mevcut Codex ChatGPT oturumunu kullanır. Parola, cookie veya erişim belirteci uygulama veritabanına yazılmaz.
