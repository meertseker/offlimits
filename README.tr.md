# offlimits

**Kodlama ajanınızı production'dan uzak tutan hook.**

Production yasak bölgedir. Prompt rica eder, hook zorlar. `--dangerously-skip-permissions` dahil her izin modunda çalışır.

Tam dokümantasyon İngilizcedir: [README.md](README.md). Bu sayfa kısa bir özettir.

## Ne yapar

offlimits, Claude Code için tek bir PreToolUse hook'u olan bir eklentidir. Ajanın çalıştırmak üzere olduğu her kabuk komutunu, dosya yazımını ve MCP çağrısını okur; production'a dokunanları reddeder:

- `main` dalına push, dal silme, `gh pr merge`
- canlı veritabanı değişiklikleri (`prisma migrate deploy`, `supabase db push`, uzak `psql`)
- deploy komutları (Vercel, Fly, Terraform, kubectl, Helm ve diğerleri)
- paket yayınlama (`npm publish`, `cargo publish`)
- Supabase MCP üzerinden yazma SQL'i
- hook ve politika dosyalarının ajan tarafından değiştirilmesi

Bağımlılık, ağ çağrısı, hesap ve telemetri yoktur.

## Kurulum

```sh
claude plugin install offlimits --marketplace meertseker/offlimits
```

Claude Code 2.1.292 veya üstü ve Node 20 veya üstü gerekir. Kurulumdan sonra `/offlimits test` ile kapıyı kendi oturumunuzda deneyin.

## Roller

| Rol | Nasıl | Ne yapabilir |
|---|---|---|
| `coordinator` | `OFFLIMITS_ROLE=coordinator` | Her şey. Birleştiren ve deploy eden tek oturum |
| `worker` | `OFFLIMITS_ROLE=worker` ve koordinatörün tüm alt ajanları | Tüm kurallar reddeder |
| `solo` | değişken yok | Sert kurallar reddeder, tanımsız MCP yazmaları sorar |

Rol yalnızca sizin başlattığınız ortam değişkeninden gelir. Ajan kendini yükseltemez; `role-spoof` kuralı bunu engeller.

## Gerçek bir test

Claude Code 2.1.310 ile `--dangerously-skip-permissions` ve `OFFLIMITS_ROLE=worker` ile başlattığımız bir oturumda ajanın `git push origin main` komutu engellendi. Ajan engellendiğini bildirdi ve dolambaçlı yol denemedi.

## Sınırlar

offlimits bir sandbox değildir ve aşılamaz olduğunu iddia etmez. `node -e` gibi satır içi yorumlayıcılar, sarmalayıcı betikler ve takma adlar denetlenmez. Tam liste: [docs/limits.md](docs/limits.md).

## Daha fazlası

- Yapılandırma: [docs/policy.md](docs/policy.md)
- Hangi olayları yakalardı: [docs/incidents.md](docs/incidents.md)
- Lisans: MIT
