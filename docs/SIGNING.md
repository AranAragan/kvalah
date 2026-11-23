# Подпись кода kvalah

Без подписи Windows SmartScreen показывает «Система Windows защитила ваш компьютер», а macOS — «приложение от неустановленного разработчика». Сборка уже готова к подписи: workflow `.github/workflows/release.yml` **сам включает подпись, когда в репозитории появляются нужные секреты**, и собирает неподписанные файлы, пока их нет. Ниже — что нужно сделать владельцу репозитория (сделать это за него нельзя: заявку подаёт и личность подтверждает сам владелец).

| Вариант | Цена | Кому доступен | Статус в CI |
|---|---|---|---|
| **1. SignPath Foundation** (рекомендуется) | бесплатно для open source | любой open-source проект, который примут | готово, включается секретами |
| **2. Azure Artifact Signing** (бывш. Trusted Signing) | $9.99/мес | частные лица — **только США и Канада**; организации — США, Канада, ЕС, UK и др. | готово, включается секретами |
| 3. macOS: Apple Developer ID + нотаризация | $99/год | любой | готово, необязательно |

> Важно про подпись и автообновление: подписанная версия запоминает издателя (`KVALAH_WIN_PUBLISHER`) и потом ставит только обновления, подписанные тем же издателем. Переход «неподписанная → подписанная» проходит без проблем; обратно — нет. Если подпись однажды включена, все следующие релизы тоже должны быть подписаны тем же сертификатом.

---

## 1. SignPath Foundation (бесплатно)

SignPath Foundation выдаёт open-source проектам сертификат на имя «SignPath Foundation» и бесплатную подписку SignPath.io. Издатель в Windows будет **SignPath Foundation**.

### 1.1. Требования (проверьте до подачи заявки)

Полный текст: <https://signpath.org/terms>. Коротко и применительно к kvalah:

- [x] **OSI-лицензия** без коммерческого двойного лицензирования — MIT (`LICENSE`).
- [x] **Публичный репозиторий**, весь код открыт, нет проприетарных компонентов (Electron — MIT, pdf.js — Apache-2.0, electron-updater — MIT).
- [ ] **Проект уже выпущен** в том виде, который будет подписываться → сначала опубликуйте неподписанный релиз v0.7.0 (см. `docs/PUBLISHING.md`).
- [x] **Функциональность описана на странице загрузки** — README.
- [ ] **Активная поддержка и узнаваемость.** SignPath отказывает совсем новым проектам без «проверяемой репутации». Помогают звёзды, скачивания, issues, упоминания (Reddit r/LocalLLaMA, Хабр). Если откажут — подайте снова через пару месяцев.
- [x] **Сборка только в CI из исходников репозитория** — `release.yml`, подпись идёт через GitHub Action SignPath с проверкой происхождения сборки.
- [x] **Подписываются только свои файлы.** Подписываются `kvalah.exe` и установщик. DLL Electron/Chromium остаются как есть (так разрешено правилами).
- [x] **Деинсталляция есть** — установщик NSIS регистрирует удаление в «Приложения и возможности».
- [x] **Без скрытой передачи данных** — раздел *Privacy policy* в README; проверку обновлений можно отключить.
- [ ] **MFA (двухфакторная аутентификация)** включена на GitHub и в SignPath у всех участников.
- [x] **Раздел «Code signing policy» на главной странице проекта** — уже есть в `README.md`: фраза «Free code signing provided by SignPath.io, certificate by SignPath Foundation», роли (Committers/Reviewers/Approvers) и политика конфиденциальности. После одобрения уберите из этого раздела пометку *«applies once the project is accepted…»*. Ссылка «Code signing policy» добавляется в описание каждого релиза автоматически (`scripts/release-notes.mjs`).
- [ ] **Каждый релиз подтверждается вручную** (роль Approver) — это настраивается в политике подписи SignPath.

### 1.2. Подача заявки

1. Включите 2FA на GitHub (Settings → Password and authentication).
2. Опубликуйте репозиторий и первый неподписанный релиз (`docs/PUBLISHING.md`).
3. Заполните форму <https://signpath.org/apply>. Что указать:
   - Project name: `kvalah`; Repository: `https://github.com/AranAragan/kvalah`; License: MIT.
   - Homepage / download page: `https://github.com/AranAragan/kvalah` и `…/releases`.
   - Описание: «Desktop coding agent for local open-weight LLMs (Ollama, LM Studio, llama.cpp, vLLM). Electron app, Windows installer built by GitHub Actions with electron-builder (NSIS).»
   - Build system: **GitHub Actions**; artifacts: **NSIS installer (.exe) and the application executable**.
   - Code signing policy: ссылка на раздел README `https://github.com/AranAragan/kvalah#code-signing-policy`.
   - Team: Enver Abdullaev (@AranAragan) — author, reviewer, approver.
4. Дождитесь ответа (обычно от нескольких дней до нескольких недель). Отвечайте на вопросы коротко — так просит сама SignPath.

### 1.3. Настройка в SignPath.io (после одобрения)

В веб-интерфейсе <https://app.signpath.io>:

1. **Project** со slug `kvalah`, Repository URL `https://github.com/AranAragan/kvalah`.
2. **Trusted build system:** добавьте в организацию предопределённую систему **GitHub.com** и свяжите её с проектом (это включает проверку, что файлы собраны GitHub Actions из этого репозитория).
3. **Artifact configurations** — две, содержимое уже лежит в репозитории:
   - slug `win-unpacked` ← `packaging/signpath/win-unpacked.xml` (подписывает `kvalah.exe` внутри собранной папки);
   - slug `installer` ← `packaging/signpath/installer.xml` (подписывает `kvalah-<версия>-win-x64-setup.exe`).
   Оба файла проверяют метаданные (`product-name="kvalah"`, `product-version`), как требует SignPath Foundation. Значения сверены с локальной сборкой: у `kvalah.exe` ProductVersion = `0.7.0.0` (поэтому в XML `${version}.0`), у установщика — `0.7.0`.
4. **Signing policy** со slug `release-signing`: сертификат от SignPath Foundation, **Approval required** (одобряющий — вы), Submitters — CI-пользователь из следующего пункта.
5. **CI user** (Users → Add CI user) с ролью Submitter в политике; создайте ему **API token**.

### 1.4. Секреты и переменные в GitHub

`Settings → Secrets and variables → Actions`:

| Тип | Имя | Значение |
|---|---|---|
| Secret | `SIGNPATH_API_TOKEN` | API-токен CI-пользователя SignPath |
| Variable | `SIGNPATH_ORGANIZATION_ID` | ID организации (SignPath → Organization → Settings) |
| Variable | `SIGNPATH_PROJECT_SLUG` | `kvalah` (необязательно, это значение по умолчанию) |
| Variable | `SIGNPATH_POLICY_SLUG` | `release-signing` (необязательно, по умолчанию) |
| Variable | `KVALAH_WIN_PUBLISHER` | `SignPath Foundation` — CN сертификата; electron-updater будет принимать только обновления от этого издателя |

### 1.5. Как проходит подписанный релиз

1. Тег `v*` → job `windows` собирает `release/win-unpacked` и отправляет его в SignPath (artifact configuration `win-unpacked`).
2. Вы получаете письмо/уведомление и **одобряете** запрос в SignPath (job ждёт до 2 часов).
3. Из подписанной папки собираются установщик NSIS и портативный zip, установщик отправляется на подпись (`installer`) — снова одобрение.
4. `scripts/refresh-latest-yml.mjs` пересчитывает SHA-512 в `latest.yml`, чтобы автообновление приняло подписанный файл.
5. Шаг «Show signatures» выводит статус подписи в лог.

Ограничение: деинсталлятор внутри установщика при этой схеме остаётся неподписанным (его генерирует NSIS во время сборки). На SmartScreen это не влияет — проверяется сам установщик. С Azure (вариант 2) подписываются все три файла.

---

## 2. Azure Artifact Signing (альтернатива, платно)

Подходит, только если у вас есть **организация** в США/Канаде/ЕС/UK (или другой поддерживаемой стране) либо вы — **частное лицо в США или Канаде**. Нужна платная подписка Azure (бесплатная/пробная не подходит), тариф Basic — $9.99 в месяц. Документация: <https://learn.microsoft.com/azure/artifact-signing/quickstart>.

1. Создайте ресурс **Artifact Signing account** в поддерживаемом регионе (например, North Europe → endpoint `https://neu.codesigning.azure.net`).
2. Пройдите **Identity validation** (Public) — несколько рабочих дней.
3. Создайте **Certificate profile** типа *Public Trust*.
4. Зарегистрируйте приложение в Microsoft Entra ID (App registration), создайте Client secret и выдайте приложению роль **Artifact Signing Certificate Profile Signer** на аккаунт.
5. Добавьте в GitHub:

| Тип | Имя | Значение |
|---|---|---|
| Secret | `AZURE_TENANT_ID` | ID тенанта Entra |
| Secret | `AZURE_CLIENT_ID` | Application (client) ID |
| Secret | `AZURE_CLIENT_SECRET` | секрет приложения |
| Variable | `AZURE_SIGNING_ENDPOINT` | например `https://neu.codesigning.azure.net` |
| Variable | `AZURE_SIGNING_ACCOUNT` | имя аккаунта Artifact Signing |
| Variable | `AZURE_SIGNING_PROFILE` | имя профиля сертификата |
| Variable | `KVALAH_WIN_PUBLISHER` | CN сертификата (ваше имя или название организации, как в профиле) |

Если заданы секреты SignPath, используется SignPath; иначе, если заданы секреты Azure, — Azure. electron-builder подписывает `kvalah.exe`, деинсталлятор и установщик сам (модуль PowerShell `TrustedSigning` ставится автоматически).

Ещё один вариант для частного лица вне США/Канады — обычный OV-сертификат (например, Certum «Open Source Code Signing» с облачным ключом). Его можно подключить через стандартные переменные electron-builder `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`, но сертификаты на облачных токенах обычно требуют отдельной настройки — это не сделано.

---

## 3. macOS: подпись и нотаризация (необязательно)

Без них приложение подписывается ad-hoc (запускается и на Apple Silicon), но Gatekeeper предупреждает при первом запуске, а **автообновление на macOS работает в режиме уведомления** (ссылка на скачивание вместо установки).

Нужна платная программа Apple Developer ($99/год). Затем:

1. Создайте сертификат **Developer ID Application**, экспортируйте его с ключом в `.p12`.
2. Создайте app-specific password на <https://account.apple.com> (для нотаризации).
3. Добавьте секреты:

| Secret | Значение |
|---|---|
| `MAC_CSC_LINK` | `.p12` в base64 (`base64 -i cert.p12`) |
| `MAC_CSC_KEY_PASSWORD` | пароль от `.p12` |
| `APPLE_ID` | Apple ID разработчика |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | Team ID (10 символов) |

С ними `release.yml` включает hardened runtime, подпись Developer ID и нотаризацию, а приложение само определяет подпись (`codesign`, TeamIdentifier) и переключает автообновление в полный режим.

---

## Проверка

- Windows: свойства файла → «Цифровые подписи», или `Get-AuthenticodeSignature .\kvalah-0.7.0-win-x64-setup.exe`.
- macOS: `codesign -dv --verbose=2 /Applications/kvalah.app` и `spctl -a -vv /Applications/kvalah.app`.
- Репутация SmartScreen набирается со временем даже у подписанных файлов: первые недели предупреждение может появляться реже, но не исчезнуть сразу.
