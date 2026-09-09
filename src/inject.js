(() => {
  const API_HOST = 'api.hero-wars-alliance.com';
  const API_PATH = '/api/rpc';
  const DEBUG = true;

  const ALLOWED_METHODS = new Set([
    'user_getClanInfo',
    'clanClash_getUserClanResult',
    'clanClash_getLaneBattle',
    'clanClash_getCurrentState',
    // --- Глобальный Чемпионат ---
    'clanWarChampInfo_getInfo',
    'clanWarChampInfo_getBriefInfo',
    'clanWarChampInfo_getAvailableHistory',
    'clanWarChampInfo_getDayHistory',
    'clanWarChampInfo_getSeason',
    'clanWarChampDefence_getDefence',
    // --- GW (Война Гильдий) ---
    'clanWarGetInfo',
    'clanWarGetDayHistory',
    'clanWarGetAvailableHistory',
    'clanWarGetDefence',
    // --- GW current-day: назначения и бои ---
    'clanWar_SetTargetMark',
    'clanWarAttack',
    'clanWarEndBattle',
    // --- Тренировки гильдии ---
    // clanTrainings_getAll (args onlyMy=false) — один ответ на весь клан: выставленные
    // стенды защиты (challenges) и состоявшиеся заходы (replays). Заход = атака по стенду,
    // внутри 1 или 10 боёв с остатком HP бойцов в процентах. Игра опрашивает метод раз в
    // ~10 секунд, пока открыт экран тренировок; бэк дедупит по неизменному ответу и по
    // игровым id заходов/боёв, так что переизбыток захватов ему не страшен.
    'clanTrainings_getAll',
    // --- Player-scope: инвентарь и прогресс героев (для журнала-планировщика) ---
    'inventoryGet',
    'heroGetAll',
    'titanGetAll',
    'userGetInfo',
    // Полная мощь аккаунта участника (для /hw/progress «Мощь аккаунта»). Игра дёргает
    // при открытии карточки участника; ловим пассивно (свой вызов подписать нельзя — подпись в wasm).
    'heroGetSumPower',
    // --- Events: квесты пользователя + remote-config URLs для CDN-чейнов ---
    'questGetAll',
    'questGetEvents',
    'remoteConfigInit',
    // --- Сезонные эвенты «Царства» (liveOps-механика specialQuest) ---
    // С 2026-08-10 расписание тиров и состав вкладок игра тянет HTTP-RPC'ом
    // getSpecialQuestState на холодном старте (в вызове новое поле "feature":"quest").
    // MQTT-push specialQuestEvents с тем же телом жив, но приходит нерегулярно
    // (на старте недели 10.08 не пришёл вовремя — задания не подгрузились);
    // ловим оба источника, перехват push'а — в MQTT_TYPES ниже.
    'getSpecialQuestState',
    'specialQuestInit',
    'specialQuestEvents',
    // --- Эвент-магазины: ассортимент магазинов событий (shopId >= 1000000) ---
    // По вызову на каждый shopId; бэк фильтрует эвентовые и копит снимки (event_shop).
    'shopGet',
    // ~2026-08 (сезон 28) вендор заменил per-shop shopGet батчевым shopGetMany:
    // args={"shopIds":[...]}, ответ — словарь {shopId: {id, slots, ...}}. Бэк сам
    // разворачивает его в per-shop shopGet при ingest'е; shopGet оставлен на случай отката.
    'shopGetMany',
    // --- Арена: соперники из поиска и лог боёв ---
    // battleGetByType — общий метод логов; бэк обрабатывает args.type 'arena' (арена целиком)
    // и 'grand' (бои Гранд Арены — в корпус контр-паков), остальные типы игнорирует.
    'arenaFindEnemies',
    'battleGetByType',
    'customArena_endBattle',
    // --- Аккаунт-уровневые усиления для Калькулятора ---
    // Приходят одним батчем на холодном старте игры, поэтому обновляются раз за сессию.
    // rune_getAll      — classRunes: уровень классовой рунной сферы и вклад каждого героя
    //                    (heroesRunes из того же ответа дублирует heroGetAll.hero_runes);
    // set_getAll       — уровни комплектации наборов;
    // talisman_getAll  — ВСЕ талисманы всех героев, включая неодетые (в heroGetAll приходит
    //                    только надетый) — для «Статистики для переброски» калькулятора;
    // getHeroSummary   — squadHeroSkills: уровни умений «Царства». Имя обобщённое, в том же
    //                    батче есть getSummary/getUnitSummary/getResidentSummary соседних
    //                    подсистем — их НЕ забираем.
    'rune_getAll',
    'set_getAll',
    'talisman_getAll',
    'getHeroSummary'
    // getSummary в этот список НЕ входит: он обрабатывается отдельно в resolveMethod()
    // и уходит на бэк как research_getSummary — см. комментарий там.
  ]);

  // Нативные console-методы захватываем на document_start: игра позже подменяет
  // console.log заглушкой, и динамический lookup писал бы в пустоту.
  const nativeLog = console.log.bind(console);
  const nativeWarn = console.warn.bind(console);
  const log = (...a) => DEBUG && nativeLog('[HW-EXT]', ...a);
  const warn = (...a) => nativeWarn('[HW-EXT]', ...a);

  // `getSummary` — обобщённое имя: в одном батче его вызывают четыре подсистемы Царства
  // (бонусы, производства, исследования, постройки) с одинаковыми args `{}` и одним URL.
  // Различить их можно только по форме ответа. Нужны исследования (`completedResearches`) —
  // их пересылаем под отдельным синтетическим именем, чтобы на бэке был свой ключ дедупа
  // `(method, args, scope)`: иначе все четыре схлопнулись бы в одну строку и затирали друг друга.
  // Остальные getSummary не отправляем вовсе.
  const RESEARCH_METHOD = 'research_getSummary';

  function resolveMethod(name, response) {
    if (name === 'getSummary') {
      return response && response.completedResearches ? RESEARCH_METHOD : null;
    }
    return ALLOWED_METHODS.has(name) ? name : null;
  }

  function shouldIntercept(url) {
    if (!url) return false;
    try {
      const u = new URL(url, location.href);
      return u.host === API_HOST && u.pathname.startsWith(API_PATH);
    } catch {
      return false;
    }
  }

  function postCaptured(payload) {
    window.postMessage({ source: 'hw-ext', type: 'rpc-capture', payload }, '*');
  }

  async function readBody(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    try {
      if (body instanceof Blob) return await body.text();
      if (body instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(body);
      if (ArrayBuffer.isView(body)) return new TextDecoder('utf-8').decode(body);
      if (body instanceof URLSearchParams) return body.toString();
    } catch (e) {
      warn('body read failed:', e);
    }
    return '';
  }

  function processCapture(requestText, responseText, headers) {
    let request;
    try {
      request = JSON.parse(requestText);
    } catch (e) {
      warn('request JSON parse failed; body head:', (requestText || '').slice(0, 120));
      return;
    }
    let response = null;
    try { response = responseText ? JSON.parse(responseText) : null; } catch {}

    const calls = request && Array.isArray(request.calls) ? request.calls : null;
    if (!calls || calls.length === 0) {
      log('no calls[] in request, keys:', Object.keys(request || {}));
      return;
    }

    const allMethods = calls.map(c => c && c.name).filter(Boolean);
    log('RPC batch:', allMethods);

    const responseMap = {};
    if (response && Array.isArray(response.results)) {
      for (const r of response.results) {
        if (r && r.ident) {
          responseMap[r.ident] = r.result && r.result.response != null ? r.result.response : null;
        }
      }
    }

    const playerId = headers['x-auth-player-id'] || null;
    const calledAt = new Date().toISOString();

    const filtered = calls
      .map(c => {
        if (!c) return null;
        const resp = responseMap[c.ident] != null ? responseMap[c.ident] : null;
        const method = resolveMethod(c.name, resp);
        if (!method) return null;
        return {
          method,
          requestArgs: c.args != null ? c.args : null,
          response: resp,
          requestIdent: c.ident || null,
          calledAt
        };
      })
      .filter(Boolean);

    log('matched MVP methods:', filtered.length, '/', calls.length, 'playerId:', playerId);

    if (filtered.length > 0) {
      postCaptured({ playerId, calls: filtered });
    }
  }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    if (h instanceof Headers) {
      h.forEach((v, k) => { out[k.toLowerCase()] = v; });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) out[k.toLowerCase()] = v;
    } else if (typeof h === 'object') {
      for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
    }
    return out;
  }

  // --- fetch wrapper ---
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!shouldIntercept(url)) {
      return origFetch.apply(this, arguments);
    }

    let requestText = '';
    let headers = {};
    try {
      if (init && init.body != null) {
        requestText = await readBody(init.body);
      } else if (input instanceof Request) {
        requestText = await input.clone().text();
      }
      const hSrc = (init && init.headers) || (input instanceof Request ? input.headers : null);
      headers = headersToObject(hSrc);
      log('fetch →', url, 'body bytes:', requestText.length);
    } catch (e) {
      warn('fetch request read failed:', e);
    }

    const response = await origFetch.apply(this, arguments);

    try {
      const cloned = response.clone();
      const respText = await cloned.text();
      processCapture(requestText, respText, headers);
    } catch (e) {
      warn('fetch capture failed:', e);
    }

    return response;
  };

  // --- XHR wrapper ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__hwUrl = url;
    this.__hwHeaders = {};
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (!this.__hwHeaders) this.__hwHeaders = {};
    this.__hwHeaders[String(name).toLowerCase()] = value;
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (shouldIntercept(this.__hwUrl)) {
      const xhr = this;
      log('xhr →', xhr.__hwUrl, 'body type:', body && body.constructor && body.constructor.name);
      xhr.addEventListener('load', async () => {
        try {
          const reqText = await readBody(body);
          processCapture(reqText, xhr.responseText || '', xhr.__hwHeaders || {});
        } catch (e) {
          warn('XHR capture failed:', e);
        }
      }, { once: true });
    }
    return origSend.apply(this, arguments);
  };

  // ===========================================================================
  // MQTT (WebSocket) — сезонные эвенты
  // ===========================================================================
  // Игра держит MQTT-соединение с `wss://emqx-hwmb-wss.nextersglobal.com/mqtt`
  // (paho-mqtt) и шлёт в него push'и по топикам `hwm/user/<id>`, `hwm/pub/clan/<id>`
  // и др. С 2026-07-16 по ~2026-08-10 расписание тиров и состав вкладок сезонных
  // эвентов приходили ТОЛЬКО сюда, сообщением `{"result":{"type":"specialQuestEvents",
  // "body":{"events":[{id,start,end,viewId,groups:[{id,repeatType,localeKey,quests}]}]}}}`
  // (конфиги specialQuestEvent/specialQuestGroup сняты с индекса remoteConfigInit).
  // С 2026-08-10 push приходит нерегулярно (на старте недели не был доставлен вовремя) —
  // основным источником стал HTTP-RPC getSpecialQuestState холодного старта (то же тело,
  // ловится обычным whitelist'ом выше); MQTT-перехват дополняет его. Живой снимок
  // авторитетнее конфига — repeatType фактический (в снимке конфига вкладки арены
  // помечены Repeatable, а в игре они single).
  //
  // Забираем только whitelist'нутые типы: топики global-map сыплют сотни
  // mapChunksUpdated в минуту — их ловить незачем.
  const MQTT_TYPES = new Set(['specialQuestEvents']);

  /**
   * Разбирает MQTT-пакеты из бинарного фрейма и возвращает payload'ы PUBLISH'ей.
   * Формат: [1 байт type/flags][remaining length varint][2 байта длины топика][топик]
   * [2 байта packet id — только при QoS>0][payload]. В одном WS-фрейме пакетов
   * может быть несколько подряд.
   */
  function parseMqttPublishes(buf) {
    const out = [];
    const b = new Uint8Array(buf);
    let pos = 0;
    while (pos + 2 <= b.length) {
      const header = b[pos];
      const packetType = header >> 4;
      let mult = 1, remaining = 0, q = pos + 1;
      while (q < b.length) {
        const enc = b[q++];
        remaining += (enc & 127) * mult;
        mult *= 128;
        if ((enc & 128) === 0) break;
        if (mult > 128 * 128 * 128) return out; // битый varint — дальше не парсим
      }
      const bodyEnd = q + remaining;
      if (bodyEnd > b.length) break;
      if (packetType === 3 && remaining > 2) {
        const topicLen = (b[q] << 8) | b[q + 1];
        let p = q + 2 + topicLen;
        if ((header >> 1) & 3) p += 2; // packet id при QoS 1/2
        const topic = new TextDecoder('utf-8').decode(b.subarray(q + 2, q + 2 + topicLen));
        const payload = new TextDecoder('utf-8').decode(b.subarray(p, bodyEnd));
        out.push({ topic, payload });
      }
      pos = bodyEnd;
    }
    return out;
  }

  /** Отдаёт push бэкенду как обычный «вызов» — метод = тип сообщения. */
  function handleMqttFrame(data) {
    let buf = null;
    if (data instanceof ArrayBuffer) buf = data;
    else if (ArrayBuffer.isView(data)) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    else return; // текстовые фреймы MQTT не использует
    let publishes;
    try { publishes = parseMqttPublishes(buf); } catch (e) { return; }
    for (const { topic, payload } of publishes) {
      if (payload.indexOf('specialQuest') < 0) continue; // дешёвый фильтр до JSON.parse
      let msg;
      try { msg = JSON.parse(payload); } catch { continue; }
      const result = msg && msg.result;
      const type = result && result.type;
      if (!type || !MQTT_TYPES.has(type)) continue;
      const body = result.body || null;
      const playerId = body && body.pushUserId != null ? String(body.pushUserId) : null;
      log('MQTT capture:', type, 'topic:', topic);
      postCaptured({
        playerId,
        calls: [{
          method: type,
          requestArgs: { transport: 'mqtt', topic },
          response: body,
          requestIdent: null,
          calledAt: new Date().toISOString()
        }]
      });
    }
  }

  const OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    const WrappedWebSocket = function(url, protocols) {
      const ws = protocols === undefined ? new OrigWebSocket(url) : new OrigWebSocket(url, protocols);
      try {
        // Слушаем на самом сокете: paho вешает свой onmessage, а addEventListener
        // работает параллельно и не мешает игре (мы только читаем).
        ws.addEventListener('message', (ev) => {
          try { handleMqttFrame(ev.data); } catch (e) { warn('MQTT capture failed:', e); }
        });
      } catch (e) {
        warn('WebSocket hook failed:', e);
      }
      return ws;
    };
    WrappedWebSocket.prototype = OrigWebSocket.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) WrappedWebSocket[k] = OrigWebSocket[k];
    window.WebSocket = WrappedWebSocket;
  }

  log('fetch/XHR/WebSocket interception installed');
})();