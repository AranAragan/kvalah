# Публикация kvalah: GitHub, релизы, winget, Scoop

Всё, что можно автоматизировать, уже автоматизировано: релиз собирается и публикуется GitHub Actions по тегу. Ниже — первый запуск и порядок выпуска следующих версий.

## 1. Первая публикация репозитория

```bash
# в папке репозитория
git remote add origin https://github.com/AranAragan/kvalah.git
git push -u origin main
git push origin v0.7.0          # тег запускает .github/workflows/release.yml
```

Репозиторий должен быть **публичным** (иначе автообновление не увидит релизы, а SignPath и winget не примут проект).

После первого push в настройках репозитория на GitHub:

1. **About** (шестерёнка справа на главной): описание «Reliable coding agent for 7–32B open models on a single home GPU», сайт — ссылка на Releases, topics: `llm`, `ai-agent`, `coding-agent`, `ollama`, `llama-cpp`, `lm-studio`, `vllm`, `local-llm`, `electron`.
2. **Settings → Code security → Private vulnerability reporting → Enable** (на это ссылается `SECURITY.md`).
3. **Settings → Actions → General → Workflow permissions**: оставьте «Read repository contents», права на запись workflow запрашивает сам там, где нужно (публикация релиза, обновление манифестов).
4. Если включите защиту ветки `main`, разрешите `github-actions[bot]` пушить, либо коммитьте обновлённые манифесты Scoop/winget вручную (job выдаст предупреждение).
5. Включите 2FA на аккаунте (нужно для SignPath и хорошая практика для подписи релизов).

## 2. Что делает релиз (тег `vX.Y.Z`)

`.github/workflows/release.yml`:

| Job | Что делает |
|---|---|
| `verify` | тег = версия из `package.json`, есть раздел в `CHANGELOG.md`, `npm run check`, `npm test` |
| `linux` | `kvalah-X.Y.Z-linux-x86_64.AppImage`, `kvalah-X.Y.Z-linux-amd64.deb`, `latest-linux.yml` |
| `macos` | `kvalah-X.Y.Z-mac-{x64,arm64}.dmg` и `.zip`, `latest-mac.yml` (подпись — если есть секреты) |
| `windows` | `kvalah-X.Y.Z-win-x64-setup.exe` (NSIS), `kvalah-X.Y.Z-win-x64-portable.zip`, `latest.yml`; подпись SignPath/Azure — если есть секреты (`docs/SIGNING.md`) |
| `publish` | `SHA256SUMS.txt`, GitHub Release (не черновик) с заметками из `CHANGELOG.md` |
| `package-managers` | вписывает SHA256 в манифесты Scoop/winget и коммитит их в `main`; при наличии `WINGET_TOKEN` отправляет PR в `microsoft/winget-pkgs` |

Файлы `latest*.yml` — это каналы автообновления: без них установленные копии не увидят новую версию. Не удаляйте их из релиза.

Повторить сборку для существующего тега: **Actions → Release → Run workflow**, поле `tag`.

## 3. Выпуск следующей версии

```bash
# 1) версия
npm version 0.7.1 --no-git-tag-version
# 2) CHANGELOG.md: перенести пункты из [Unreleased] в "## [0.7.1] - ГГГГ-ММ-ДД"
# 3) заготовки манифестов для новой версии (хэши заполнит CI после релиза)
node scripts/package-managers.mjs --version 0.7.1
npm test
git commit -am "Release 0.7.1" && git tag v0.7.1 && git push && git push origin v0.7.1
```

Предварительные версии (`0.8.0-beta.1`) публикуются как pre-release, в winget/Scoop не отправляются, автообновление их получает только у тех, у кого уже стоит pre-release.

## 4. winget

Пакет: `AranAragan.Kvalah`, тип установщика `nullsoft` (NSIS), установка для текущего пользователя. Манифесты: `packaging/winget/manifests/a/AranAragan/Kvalah/<версия>/`.

### Токен `WINGET_TOKEN`

1. GitHub → Settings → Developer settings → **Personal access tokens (classic)** → Generate new token.
2. Scope: **`public_repo`**. Срок — год (поставьте напоминание продлить).
3. Репозиторий kvalah → Settings → Secrets and variables → Actions → **New repository secret** `WINGET_TOKEN`.

С токеном job `package-managers` после каждого релиза:
- первый раз — отправляет готовые манифесты (`wingetcreate submit`);
- дальше — `wingetcreate update AranAragan.Kvalah --version … --urls … --submit` (новая версия на основе текущей в winget-pkgs).

`wingetcreate` делает форк `microsoft/winget-pkgs` в вашем аккаунте и открывает PR от вашего имени.

### Что сделать руками в первом PR

1. В PR в `microsoft/winget-pkgs` бот попросит принять Microsoft CLA — ответьте комментарием `@microsoft-github-policy-service agree`.
2. Дождитесь автоматической проверки (установка в песочнице, сканирование) и ревью модераторов — обычно от одного до нескольких дней. Если бот пометит `Needs-Author-Feedback`, ответьте в PR.
3. После слияния: `winget install AranAragan.Kvalah` (появляется в поиске через несколько часов).

Без токена можно отправить вручную на Windows:
```powershell
winget install wingetcreate
wingetcreate submit --token <PAT> packaging\winget\manifests\a\AranAragan\Kvalah\0.7.0
```
(хэши в манифестах уже будут заполнены job-ом после релиза — сделайте `git pull`). Альтернатива — [komac](https://github.com/russellbanks/Komac): `komac update AranAragan.Kvalah --version 0.7.1 --urls <url> --submit`.

## 5. Scoop

Репозиторий kvalah сам является bucket-ом (манифест `bucket/kvalah.json`). Пользователи:

```powershell
scoop bucket add kvalah https://github.com/AranAragan/kvalah
scoop install kvalah
scoop update kvalah
```

Хэш и версию в `bucket/kvalah.json` обновляет job `package-managers`; в манифесте также есть `checkver`/`autoupdate` (хэш берётся из `SHA256SUMS.txt` релиза). Когда у проекта появится заметная аудитория, можно предложить манифест в официальный bucket [ScoopInstaller/Extras](https://github.com/ScoopInstaller/Extras) — тогда хватит `scoop install extras/kvalah`.

## 6. Обновление уже установленной версии (0.6.x)

Установщик ставит программу в ту же папку `%LOCALAPPDATA%\Programs\kvalah`, что и прежний `Setup.exe`: просто запустите `kvalah-0.7.0-win-x64-setup.exe`. Он заменит файлы, удалит остатки старого установщика (`Uninstall.exe`, старую запись в «Приложениях», папку `resources\app\vendor`) и создаст ярлыки. Чаты и настройки в `%APPDATA%\kvalah` не трогаются. Папки `resources\app.backup-*` от ручных обновлений можно удалить вручную. Начиная с 0.7.0 следующие версии придут через автообновление.

## 7. Проверка автообновления

После v0.7.0 выпустите v0.7.1 (хотя бы с исправлением опечатки). Установленная 0.7.0 через ~15 секунд после запуска (или по «Помощь → Проверить обновления…») скачает её и покажет «Доступно обновление 0.7.1 — Перезапустить и установить». Журнал: папка данных → `logs/updater.log`.

## 8. Где рассказать о проекте

- Reddit [r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/) — видео/GIF работы агента и честно: какие модели и видеокарты проверены.
- PR в список интеграций [README Ollama](https://github.com/ollama/ollama#community-integrations) (раздел Desktop).
- Show HN, Product Hunt, Хабр, Discord-сообщества Ollama и llama.cpp.
- Звёзды и обсуждения нужны и для заявки в SignPath Foundation (требуется «проверяемая репутация»).
