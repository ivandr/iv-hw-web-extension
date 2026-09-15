# Warden — браузерное расширение

Расширение Chrome / Edge (Manifest V3) для [hw-warden.com](https://hw-warden.com):
перехватывает RPC-вызовы игры Hero Wars Alliance и отправляет их на бэкенд ms-hw
для аналитики гильдии (войны, турниры, прогресс, калькулятор).

## Как это работает

```
inject.js ──postMessage──▶ content.js ──sendMessage──▶ background.js ──HTTP──▶ ms-hw
MAIN world страницы игры   isolated world (bridge, UI) service worker (очередь)
```

- **`src/inject.js`** — инжектится в MAIN world страницы игры. Оборачивает `fetch`,
  `XMLHttpRequest` и `WebSocket` (MQTT-пуши), разбирает RPC-батчи `api/rpc` и
  пересылает только методы из whitelist'а `ALLOWED_METHODS` — **актуальный список
  методов смотри там**, README его сознательно не дублирует. Особые случаи
  (обобщённое имя `getSummary`, MQTT-типы) прокомментированы прямо в коде.
- **`src/content.js`** — мост isolated↔MAIN world; рисует pill-индикатор и
  toast-уведомления об отправленных методах на странице игры.
- **`src/background.js`** — service worker: очередь с батчингом
  (`POST /api/hw/har/ingest`), авторизация через `POST /api/auth/exchange`
  (JWT кладётся в cookie сайтов Warden через `chrome.cookies`), бейдж на иконке.
  Плюс DEV-only механики, см. ниже.
- **`src/marker.js`** — на страницах web-приложения Warden ставит
  `<meta name="warden-version">`, по которому сайт понимает, что расширение установлено.
- **`src/i18n.js` + `_locales/{ru,en}/`** — локализация (стандартный Chrome i18n формат
  + переключатель Auto/RU/EN в popup через `chrome.storage.local.localeOverride`).
  Любой `messages.json`, который фетчится из content-script, обязан быть перечислен
  в `web_accessible_resources` манифеста — иначе fetch молча упадёт.
- **`src/popup/`** — popup расширения: карточка игрока (имя/гильдия/роль),
  статус синхронизации, счётчики отправки.

## DEV и PROD режимы

Режим определяется автоматически по способу установки
(`chrome.management.getSelf().installType`):

| | PROD (Chrome Web Store) | DEV (Load unpacked) |
|---|---|---|
| Цели отправки | только `api.hw-warden.com` | fan-out: `localhost:9102` **и** прод параллельно |
| Gamedata dumper (splitlib / переводы / remote-config → Chrome Downloads `HW/data/<версия>/`) | — | ✔ |

DEV-only функциональность опирается на permissions `webRequest`, `downloads`
и CDN-хосты в `host_permissions` — всё это вырезается из prod-сборки скриптом `build.ps1`.

Легаси-хост `warden-api.pankov.dev` ведёт на тот же бэкенд и доживает переходный
период для старых копий расширения (≤1.0.8).

## Установка (dev)

1. `chrome://extensions/` (или `edge://extensions/`) → включить **Developer mode**.
2. **Load unpacked** → выбрать корень этого репозитория.
3. Открыть https://www.hero-wars-alliance.com/ и зайти в игру — в правом нижнем углу
   появится pill расширения, в popup — карточка игрока и статус синхронизации.

Для gamedata dumper'а файлы падают в `Downloads/HW/data/`; чтобы они оказывались
в рабочей папке импорта, удобно сделать симлинк:
`mklink /D D:\HW\data %USERPROFILE%\Downloads\HW\data`.

## Сборка для Chrome Web Store

```powershell
.\build.ps1
```

Создаёт `warden-<version>.zip` (версия из `manifest.json`): внутрь попадают только
`manifest.json` + `src/` + `icons/` + `_locales/`, из манифеста вырезаются
DEV-only permissions и localhost-матчи. Детали и причины — в комментариях `build.ps1`.

`tools/popup-preview.html` — локальный предпросмотр popup без установки расширения;
`tools/fit-to-store.ps1` — подгонка скриншотов под требования CWS. В сборку не входят.

## Бэкенд-контракт

- `POST /api/hw/har/ingest` — `{playerId, calls: [{method, requestArgs, response, requestIdent, calledAt}]}`;
  бэк складывает записи в `hw.har_rpc_call` (сессия `ext-{playerId}-{yyyy-MM-dd}`) и
  раздаёт по доменным импортёрам.
- `POST /api/auth/exchange` — по `user_getClanInfo` апсертит пользователя/гильдию и
  возвращает JWT для сессии сайта.
