# offlimits

**Claude Code'u bir yazılım ekibine çevirin.**

Konuştuğunuz tek bir koordinatör, kendi worktree'lerinde çalışan işçiler (worker) ve koordinatör dışında kimsenin production'a dokunmasına izin vermeyen bir kapı. `--dangerously-skip-permissions` dahil her izin modunda çalışır.

Tam dokümantasyon İngilizcedir: [README.md](README.md). Bu sayfa kısa bir özettir.

## Hızlı başlangıç

```sh
claude plugin install offlimits --marketplace meertseker/offlimits
node <plugin>/bin/team.mjs init      # veya Claude içinde /offlimits init
team coordinator                      # sonra onunla konuşun
```

Claude Code 2.1.292 veya üstü ve Node 20 veya üstü gerekir. `init` depoyu ekip deposuna çevirir (`offlimits.json`, CLAUDE.md bloğu, PR şablonu, `.offlimits/team/`) ve profilinize ekleyebileceğiniz bir `team` kabuk fonksiyonu yazdırır. `<plugin>` yolunu oturum başlangıcındaki banner'daki `team CLI:` satırında görürsünüz. npm paketi yoktur.

## Bir gün

Koordinatörle bir teknik lider gibi konuşursunuz. İşi böler, her parça için bir brief yazar ve her biri için yeni bir terminalde, ayrı worktree ve dalda bir işçi açar. İşçiler önce tasarlar, plan yazar, testle geliştirir ve sabit bir teslim notu bırakır. "Deploy et" dediğinizde koordinatör birleştirir, deploy adımlarını çalıştırır ve sağlık adresini kontrol eder. `team board` her şeridi (lane) ve aşamasını gösterir. Uzaklaşırsanız gece modu işçileri size soru sormadan çalıştırır; onayınız olmadan hiçbir şey birleştirilmez veya deploy edilmez.

Komutlar, `team` ayarları ve sınırlar: [docs/team.md](docs/team.md).

## Kapı: ne yapar

offlimits'in kapısı tek bir PreToolUse hook'udur. Ajanın çalıştırmak üzere olduğu her kabuk komutunu, dosya yazımını ve MCP çağrısını okur; production'a dokunanları reddeder: `main` dalına push, canlı veritabanı değişiklikleri, deploy, paket yayınlama, MCP üzerinden yazma SQL'i, hook ve politika dosyalarının değiştirilmesi. Bağımlılık, ağ çağrısı, hesap ve telemetri yoktur.

## Roller

| Rol | Nasıl | Ne yapabilir |
|---|---|---|
| `coordinator` | `team coordinator` (veya `OFFLIMITS_ROLE=coordinator`) | Her şey. Birleştiren ve deploy eden tek oturum |
| `worker` | `team worker` ile açılan oturumlar ve koordinatörün tüm alt ajanları | Tüm kurallar reddeder |
| `solo` | değişken yok | Sert kurallar reddeder, belirsiz çağrılar sorar |

Rol yalnızca başlatıcının ayarladığı ortam değişkeninden gelir. Ajan kendini yükseltemez; `role-spoof` kuralı bunu engeller. Oturum başlatan komutları (`team worker`, `done`, `coordinator`, `init`) işçiler çalıştıramaz.

## Gerçek bir test

Claude Code 2.1.310 ile `--dangerously-skip-permissions` ve `OFFLIMITS_ROLE=worker` ile başlattığımız oturumda ajanın `git push origin main` komutu engellendi. Ajan engellendiğini bildirdi ve dolambaçlı yol denemedi.

## Sınırlar

offlimits bir sandbox değildir ve aşılamaz olduğunu iddia etmez. `node -e` gibi satır içi yorumlayıcılar, sarmalayıcı betikler ve takma adlar denetlenmez. Tam liste: [docs/limits.md](docs/limits.md).

## Daha fazlası

- Yapılandırma: [docs/policy.md](docs/policy.md)
- Hangi olayları yakalardı: [docs/incidents.md](docs/incidents.md)
- Lisans: MIT
