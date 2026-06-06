/*
 * BMS Intercom — встроенный поп-ап вызывной панели.
 *
 * Центрированное окно размером с видео. Поверх видео — шапка (имя домофона из
 * сущности + статус), таймер/«входящий вызов», кнопки и дата-время. Три режима:
 *   ringing — входящий вызов: Сбросить · Ответить · Открыть
 *   talk    — разговор: Сбросить · Открыть · Микрофон (микрофон оператора вкл
 *             по умолчанию; звук панели всегда включён, не отключается)
 *   idle    — просмотр без вызова (по переключателю «Просмотр»): Открыть · Звук
 *             (звук панели выключен по умолчанию). Закрытие — крестик/фон.
 *
 * Видео и звук идут через одно WebRTC-соединение к камере (camera/webrtc/offer
 * Home Assistant → go2rtc). Микрофон оператора добавляется в ту же дорожку.
 */
(function () {
  "use strict";

  const STATIC = "/bms_intercom_static";
  const POLL_MS = 400;
  const FEATURE_STREAM = 2; // CameraEntityFeature.STREAM
  const AUTO_END_RING_MS = 5000;  // «Открыть» во время звонка (без ответа) → 5с
  const AUTO_END_TALK_MS = 30000; // «Открыть» уже в разговоре → 30с
  const LOG = "color:#2f6fed;font-weight:600";

  // --- SVG-иконки (24x24, currentColor) ----------------------------------
  const ICONS = {
    building: "M12,7V3H2v18h20V7H12z M6,19H4v-2h2V19z M6,15H4v-2h2V15z M6,11H4V9h2V11z M6,7H4V5h2V7z M10,19H8v-2h2V19z M10,15H8v-2h2V15z M10,11H8V9h2V11z M10,7H8V5h2V7z M20,19h-8v-2h2v-2h-2v-2h2v-2h-2V9h8V19z M18,11h-2v2h2V11z M18,15h-2v2h2V15z",
    phone: "M6.62,10.79c1.44,2.83 3.76,5.14 6.59,6.59l2.2-2.2c0.27-0.27 0.67-0.36 1.02-0.24 1.12,0.37 2.33,0.57 3.57,0.57 0.55,0 1,0.45 1,1V20c0,0.55-0.45,1-1,1C10.61,21 3,13.39 3,4c0-0.55 0.45-1 1-1h3.5c0.55,0 1,0.45 1,1 0,1.25 0.2,2.45 0.57,3.57 0.11,0.35 0.03,0.74-0.25,1.02L6.62,10.79z",
    hangup: "M12,9c-1.6,0-3.15,0.25-4.6,0.72v3.1c0,0.39-0.23,0.74-0.56,0.9-0.98,0.49-1.87,1.12-2.66,1.85-0.18,0.18-0.43,0.29-0.71,0.29-0.28,0-0.53-0.11-0.71-0.29L0.29,13.08C0.11,12.9 0,12.65 0,12.38c0-0.28 0.11-0.53 0.29-0.71C3.34,8.78 7.46,7 12,7s8.66,1.78 11.71,4.67c0.18,0.18 0.29,0.43 0.29,0.71 0,0.27-0.11,0.52-0.29,0.7l-2.48,2.48c-0.18,0.18-0.43,0.29-0.71,0.29-0.27,0-0.52-0.11-0.7-0.29-0.79-0.73-1.69-1.36-2.67-1.85-0.33-0.16-0.56-0.5-0.56-0.9v-3.1C15.15,9.25 13.6,9 12,9z",
    lock: "M12,17c1.1,0 2-0.9 2-2s-0.9-2-2-2-2,0.9-2,2 0.9,2 2,2z M18,8c1.1,0 2,0.9 2,2v10c0,1.1-0.9,2-2,2H6c-1.1,0-2-0.9-2-2V10c0-1.1 0.9-2 2-2h1V6c0-2.76 2.24-5 5-5s5,2.24 5,5v2H18z M12,3c-1.66,0-3,1.34-3,3v2h6V6c0-1.66-1.34-3-3-3z",
    mic: "M12,2c1.66,0 3,1.34 3,3v6c0,1.66-1.34,3-3,3s-3-1.34-3-3V5c0-1.66 1.34-3 3-3z M19,11c0,3.53-2.61,6.44-6,6.93V21h-2v-3.07C7.61,17.44 5,14.53 5,11h2c0,2.76 2.24,5 5,5s5-2.24 5-5H19z",
    micOff: "M19,11c0,1.19-0.34,2.3-0.9,3.28l-1.23-1.23C17.14,12.43 17.3,11.74 17.3,11H19z M15,11.16L9,5.18V5c0-1.66 1.34-3 3-3s3,1.34 3,3V11.16z M4.27,3 21,19.73 19.73,21l-4.19-4.19c-0.77,0.46-1.63,0.77-2.54,0.91V21h-2v-3.28C7.72,17.23 5,14.41 5,11h1.7c0,3 2.54,5.1 5.3,5.1 0.81,0 1.6-0.19 2.31-0.52l-1.66-1.66L12,14c-1.66,0-3-1.34-3-3v-0.72L3,4.27 4.27,3z",
    volume: "M14,3.23v2.06c2.89,0.86 5,3.54 5,6.71s-2.11,5.85-5,6.71v2.06c4-0.91 7-4.49 7-8.77S18,4.14 14,3.23z M16.5,12c0-1.77-1-3.29-2.5-4.03v8.06c1.5-0.74 2.5-2.26 2.5-4.03z M3,9v6h4l5,5V4L7,9H3z",
    volumeOff: "M12,4 9.91,6.09 12,8.18V4z M4.27,3 3,4.27 7.73,9H3v6h4l5,5v-6.73l4.25,4.25c-0.67,0.51-1.42,0.93-2.25,1.17v2.06c1.38-0.31 2.63-0.95 3.68-1.81L19.73,21 21,19.73 12,10.73 4.27,3z M19,12c0,0.94-0.2,1.82-0.54,2.64l1.51,1.51C20.62,14.91 21,13.5 21,12c0-4.28-3-7.86-7-8.77v2.06c2.89,0.86 5,3.54 5,6.71z",
    bell: "M12,2c0.55,0 1,0.45 1,1v0.29c2.89,0.86 5,3.54 5,6.71v6l3,3v1H3v-1l3-3v-6c0-3.17 2.11-5.85 5-6.71V3c0-0.55 0.45-1 1-1z M14,20c0,1.1-0.9,2-2,2s-2-0.9-2-2H14z",
    camera: "M4,4h3l2-2h6l2,2h3c1.1,0 2,0.9 2,2v12c0,1.1-0.9,2-2,2H4c-1.1,0-2-0.9-2-2V6c0-1.1 0.9-2 2-2z M12,7c-2.76,0-5,2.24-5,5s2.24,5 5,5 5-2.24 5-5-2.24-5-5-5z M12,9c1.66,0 3,1.34 3,3s-1.34,3-3,3-3-1.34-3-3 1.34-3 3-3z",
    close: "M19,6.41 17.59,5 12,10.59 6.41,5 5,6.41 10.59,12 5,17.59 6.41,19 12,13.41 17.59,19 19,17.59 13.41,12 19,6.41z",
  };
  function svg(name) {
    return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
  }

  let overlay = null;
  let card = null;
  let audio = null;
  let activeId = null;
  let currentMode = null; // 'ringing' | 'talk' | 'idle'
  let micOn = false;
  let micStream = null;
  let micCtx = null, micSrc = null, micProc = null; // Web Audio для захвата микрофона
  let lastSig = null;
  let talkStart = 0;       // время начала разговора (для таймера)
  let autoEndTimer = null; // авто-завершение после «Открыть»

  // --- WebRTC ------------------------------------------------------------
  let pc = null, remoteStream = null;
  let wrUnsub = null, wrSession = null, wrCam = null, wrPending = [], wrToken = 0;
  let videoMode = null; // 'webrtc' | 'mjpeg'

  function getHass() {
    const el = document.querySelector("home-assistant");
    return el && el.hass ? el.hass : null;
  }

  function groupIntercoms(hass) {
    const groups = {};
    if (!hass || !hass.states) return groups;
    for (const st of Object.values(hass.states)) {
      const a = st.attributes || {};
      const id = a.intercom_id;
      if (!id) continue;
      const g = (groups[id] = groups[id] || { roles: {}, name: a.intercom_name || "Домофон" });
      if (a.intercom_role) g.roles[a.intercom_role] = st.entity_id;
      if (a.intercom_https_base) g.httpsBase = a.intercom_https_base;
      if (a.intercom_https_port) g.httpsPort = a.intercom_https_port;
      if (a.intercom_role === "call") {
        g.callState = a.call_state || (st.state === "on" ? "ringing" : "idle");
      }
      if (a.intercom_role === "view") g.viewOn = st.state === "on";
    }
    return groups;
  }

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.id = "bms-intercom-overlay";
    overlay.innerHTML = `
      <style>
        #bms-intercom-overlay { position: fixed; inset: 0; z-index: 999999; display: none;
          align-items: center; justify-content: center; background: rgba(6,8,14,.82);
          -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
          font-family: var(--paper-font-body1_-_font-family, "Segoe UI", Roboto, system-ui, sans-serif); }
        #bms-intercom-overlay.show { display: flex; }
        .bms-card { position: relative; width: min(94vw, 820px); aspect-ratio: 4/3; max-height: 92vh;
          border-radius: 20px; overflow: hidden; background: #0c0f16;
          box-shadow: 0 30px 90px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.05);
          animation: bmsin .24s ease; }
        @keyframes bmsin { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }
        .bms-video, .bms-video-img { position: absolute; inset: 0; width: 100%; height: 100%;
          object-fit: cover; background: transparent; display: block; }
        .bms-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #2c3444; }
        .bms-ph svg { width: 72px; height: 72px; }
        .bms-top { position: absolute; top: 0; left: 0; right: 0; z-index: 3; display: flex;
          align-items: center; justify-content: space-between; padding: 14px 16px 26px;
          background: linear-gradient(180deg, rgba(6,8,14,.82) 0%, rgba(6,8,14,0) 100%); color: #eef2f8; }
        .bms-brand { display: flex; align-items: center; gap: 10px; }
        .bms-bi { width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,.12);
          display: flex; align-items: center; justify-content: center; }
        .bms-bi svg { width: 18px; height: 18px; color: #cdd6e6; }
        .bms-title { font-size: 17px; font-weight: 700; }
        .bms-right { display: flex; align-items: center; gap: 12px; }
        .bms-status { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700;
          letter-spacing: .5px; text-transform: uppercase; }
        .bms-status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
        .bms-status.ring { color: #ff6b6b; }
        .bms-status.talk { color: #3ddc8a; }
        .bms-status.idle { color: #3ddc8a; }
        .bms-x { width: 30px; height: 30px; border: none; border-radius: 50%; cursor: pointer;
          background: rgba(255,255,255,.14); color: #fff; display: flex; align-items: center; justify-content: center; }
        .bms-x svg { width: 18px; height: 18px; }
        .bms-pill { position: absolute; top: 50px; left: 16px; z-index: 3; display: flex; align-items: center;
          gap: 8px; padding: 7px 13px; border-radius: 999px; font-size: 14px; font-weight: 700; color: #eef2f8;
          background: rgba(18,24,36,.72); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
        .bms-pill svg { width: 16px; height: 16px; }
        .bms-pill.ring { color: #ff8a8a; animation: bmsblink 1.1s steps(2) infinite; }
        .bms-pill.talk { color: #3ddc8a; }
        @keyframes bmsblink { 50% { opacity: .45; } }
        .bms-bottom { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; padding: 30px 18px 18px;
          background: linear-gradient(0deg, rgba(6,8,14,.9) 0%, rgba(6,8,14,0) 100%);
          display: flex; justify-content: center; }
        .bms-actions { display: flex; gap: 28px; align-items: flex-start; }
        .bms-btn { border: none; background: none; cursor: pointer; color: #eef2f8; display: flex;
          flex-direction: column; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; }
        .bms-btn .ic { width: 58px; height: 58px; border-radius: 50%; background: #3a4254; display: flex;
          align-items: center; justify-content: center; transition: transform .07s, filter .15s; }
        .bms-btn .ic svg { width: 26px; height: 26px; color: #fff; }
        .bms-btn:hover .ic { filter: brightness(1.13); }
        .bms-btn:active .ic { transform: scale(.92); }
        .bms-answer .ic { background: #1fb866; }
        .bms-reject .ic { background: #ef4d3d; }
        .bms-door .ic { background: #2f7bf6; }
        .bms-mic.off .ic { background: #c0392b; }
        .bms-datetime { position: absolute; right: 16px; bottom: 14px; z-index: 2; color: #aeb8c8;
          font-size: 13px; font-family: ui-monospace, Menlo, Consolas, monospace; }
        .bms-cam { position: absolute; left: 16px; bottom: 14px; z-index: 2; display: flex; align-items: center;
          gap: 7px; color: #cdd6e6; font-size: 13px; }
        .bms-cam::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #3ddc8a; }
        /* видимость по режимам */
        .bms-only-ring, .bms-only-talk, .bms-only-idle, .bms-only-call { display: none; }
        .bms-card[data-mode="ringing"] .bms-only-ring,
        .bms-card[data-mode="ringing"] .bms-only-call,
        .bms-card[data-mode="talk"] .bms-only-talk,
        .bms-card[data-mode="talk"] .bms-only-call,
        .bms-card[data-mode="idle"] .bms-only-idle { display: flex; }
        .bms-card[data-mode="idle"] .bms-actions { width: 100%; justify-content: space-between; padding: 0 9%; }
        .bms-hidden { display: none !important; }
        .bms-toast { position: absolute; left: 50%; bottom: 110px; transform: translateX(-50%); z-index: 5;
          max-width: 86%; background: #20283a; color: #eaf0f8; border: 1px solid #3a4660; border-radius: 14px;
          padding: 11px 16px; font-size: 14px; line-height: 1.35; text-align: center;
          box-shadow: 0 8px 26px rgba(0,0,0,.55); opacity: 0; pointer-events: none; transition: opacity .2s; }
        .bms-toast.show { opacity: 1; }
      </style>
      <div class="bms-card" data-mode="ringing">
        <div class="bms-ph">${svg("camera")}</div>
        <video class="bms-video" autoplay playsinline muted></video>
        <img class="bms-video-img bms-hidden" alt="видео с панели" />
        <div class="bms-top">
          <span class="bms-brand"><span class="bms-bi">${svg("building")}</span><span class="bms-title">Домофон</span></span>
          <span class="bms-right">
            <span class="bms-status ring"><span class="bms-status-text">Входящий вызов</span></span>
            <button class="bms-x bms-only-idle" title="Закрыть">${svg("close")}</button>
          </span>
        </div>
        <div class="bms-pill ring bms-only-call"><span class="bms-pill-ic">${svg("bell")}</span><span class="bms-pill-text">Входящий вызов</span></div>
        <div class="bms-cam bms-only-idle">Камера активна</div>
        <div class="bms-bottom">
          <div class="bms-actions">
            <button class="bms-btn bms-reject bms-only-call"><span class="ic">${svg("hangup")}</span>Сбросить</button>
            <button class="bms-btn bms-answer bms-only-ring"><span class="ic">${svg("phone")}</span>Ответить</button>
            <button class="bms-btn bms-door"><span class="ic">${svg("lock")}</span>Открыть</button>
            <button class="bms-btn bms-mic bms-only-talk"><span class="ic">${svg("mic")}</span>Микрофон</button>
            <button class="bms-btn bms-sound bms-only-idle"><span class="ic">${svg("volume")}</span>Звук</button>
          </div>
        </div>
        <div class="bms-datetime"></div>
      </div>`;
    document.body.appendChild(overlay);
    card = overlay.querySelector(".bms-card");

    audio = document.createElement("audio");
    audio.loop = true;
    audio.src = `${STATIC}/ring1.mp3`;
    overlay.appendChild(audio);

    overlay.querySelector(".bms-answer").addEventListener("click", () => callRole("answer"));
    overlay.querySelector(".bms-reject").addEventListener("click", () => callRole("reject"));
    overlay.querySelector(".bms-door").addEventListener("click", () => callRole("open_door"));
    overlay.querySelector(".bms-mic").addEventListener("click", toggleMic);
    overlay.querySelector(".bms-sound").addEventListener("click", () => setMuted(!isMuted()));
    overlay.querySelector(".bms-x").addEventListener("click", closeIdle);
    overlay.querySelector(".bms-video").addEventListener("click", () => { if (currentMode !== "idle") setMuted(false); });
    // Клик по затемнённому фону закрывает только idle-просмотр.
    overlay.addEventListener("click", (e) => { if (e.target === overlay && currentMode === "idle") closeIdle(); });
  }

  function currentGroup() {
    const hass = getHass();
    if (!hass || !activeId) return null;
    return groupIntercoms(hass)[activeId] || null;
  }

  function closeIdle() {
    const hass = getHass();
    const g = currentGroup();
    if (hass && g && g.roles.view) hass.callService("switch", "turn_off", { entity_id: g.roles.view });
  }

  function callRole(role) {
    const hass = getHass();
    const g = currentGroup();
    if (!hass || !g) return;
    const entity = g.roles[role];
    if (entity) hass.callService("button", "press", { entity_id: entity });
    if (role === "answer") {
      setMuted(false);   // звук панели всегда включён в разговоре
      startMic(true);    // микрофон оператора включён по умолчанию (тихо)
    } else if (role === "open_door") {
      // Открытие двери завершает вызов автоматически.
      if (currentMode === "ringing" || currentMode === "talk") {
        clearAutoEnd();
        // Открыли во время звонка (не ответив) — старая логика: примем вызов
        // (чтобы панель не пищала «не ответили») и завершим через 5с.
        // Открыли уже в разговоре — завершаем через 30с.
        const delay = currentMode === "talk" ? AUTO_END_TALK_MS : AUTO_END_RING_MS;
        if (currentMode === "ringing" && g.roles.answer) {
          hass.callService("button", "press", { entity_id: g.roles.answer });
        }
        autoEndTimer = setTimeout(() => { autoEndTimer = null; callRole("reject"); }, delay);
      }
    } else if (role === "reject") {
      clearAutoEnd();
    }
  }

  function clearAutoEnd() {
    if (autoEndTimer) { clearTimeout(autoEndTimer); autoEndTimer = null; }
  }

  function showToast(msg, link) {
    if (!overlay) return;
    let t = overlay.querySelector(".bms-toast");
    if (!t) { t = document.createElement("div"); t.className = "bms-toast"; card.appendChild(t); }
    t.textContent = msg;
    if (link) {
      const a = document.createElement("a");
      a.href = link; a.textContent = "Открыть по HTTPS";
      a.style.cssText = "display:inline-block;margin-top:8px;color:#7db1ff;font-weight:700;text-decoration:none;";
      t.appendChild(document.createElement("br")); t.appendChild(a);
    }
    t.classList.add("show");
    clearTimeout(t._hide);
    t._hide = setTimeout(() => t.classList.remove("show"), link ? 12000 : 5000);
  }

  function secureUrl() {
    const hass = getHass();
    const cfg = (hass && hass.config) || {};
    const g = currentGroup();
    const tail = location.pathname + location.search + location.hash;
    if (g && g.httpsBase && g.httpsBase.indexOf("https://") === 0) return g.httpsBase.replace(/\/+$/, "") + tail;
    if (g && g.httpsPort && location.hostname) return "https://" + location.hostname + ":" + g.httpsPort + tail;
    for (const base of [cfg.external_url, cfg.internal_url]) {
      if (base && base.indexOf("https://") === 0) return base.replace(/\/+$/, "") + tail;
    }
    return null;
  }

  // --- Звук панели --------------------------------------------------------
  function videoElem() { return overlay && overlay.querySelector("video.bms-video"); }
  function isMuted() { const v = videoElem(); return !v || v.muted; }

  function setMuted(muted) {
    const v = videoElem();
    if (!v) return;
    v.muted = muted;
    if (!muted) v.play().catch(() => {});
    updateSoundBtn();
  }

  function attemptUnmute() {
    const v = videoElem();
    if (!v) return;
    v.muted = false;
    Promise.resolve(v.play()).then(() => updateSoundBtn())
      .catch(() => { v.muted = true; v.play().catch(() => {}); updateSoundBtn(); });
  }

  function updateSoundBtn() {
    const btn = overlay && overlay.querySelector(".bms-sound");
    if (!btn) return;
    const muted = isMuted();
    btn.querySelector(".ic").innerHTML = svg(muted ? "volumeOff" : "volume");
  }

  // --- Микрофон оператора → панель (native ISAPI two-way audio) -----------
  // Захватываем микрофон, понижаем до 8 кГц, кодируем в G.711 µ-law и шлём
  // байты по WebSocket в интеграцию, которая отдаёт их панели (ISAPI). go2rtc
  // для микрофона не нужен.
  const MULAW_BIAS = 0x84, MULAW_CLIP = 32635;
  function muLawSample(sample) {
    let sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    if (sample > MULAW_CLIP) sample = MULAW_CLIP;
    sample += MULAW_BIAS;
    let exp = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; exp--, mask >>= 1) { /* find exponent */ }
    const mantissa = (sample >> (exp + 3)) & 0x0F;
    return (~(sign | (exp << 4) | mantissa)) & 0xFF;
  }
  function encodeMuLaw(f32) {
    const out = new Uint8Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = Math.max(-1, Math.min(1, f32[i])) * 32767;
      out[i] = muLawSample(s | 0);
    }
    return out;
  }
  function downsampleTo8k(f32, inRate) {
    if (inRate === 8000) return f32;
    const ratio = inRate / 8000;
    const outLen = Math.floor(f32.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio), end = Math.floor((i + 1) * ratio);
      let sum = 0, n = 0;
      for (let j = start; j < end && j < f32.length; j++) { sum += f32[j]; n++; }
      out[i] = n ? sum / n : 0;
    }
    return out;
  }
  function b64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function sendTalkData(u8) {
    const hass = getHass();
    if (!hass || !activeId || !u8.length) return;
    hass.connection.sendMessagePromise({ type: "bms_intercom/talk_data", entry_id: activeId, data: b64(u8) }).catch(() => {});
  }

  function updateMicBtn() {
    const btn = overlay && overlay.querySelector(".bms-mic");
    if (!btn) return;
    btn.classList.toggle("off", !micOn);
    btn.querySelector(".ic").innerHTML = svg(micOn ? "mic" : "micOff");
  }

  async function startMic(silent) {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      if (!silent) {
        const su = secureUrl();
        if (su) showToast("Микрофон работает только по HTTPS. Откройте защищённую версию:", su);
        else showToast("Микрофон работает только по HTTPS (или localhost).");
      }
      micOn = false; updateMicBtn(); return false;
    }
    const hass = getHass();
    if (!hass || !activeId) { micOn = false; updateMicBtn(); return false; }
    if (micStream) { micOn = true; updateMicBtn(); return true; }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      if (!silent) showToast("Доступ к микрофону отклонён в браузере.");
      micOn = false; updateMicBtn(); return false;
    }
    try { await hass.connection.sendMessagePromise({ type: "bms_intercom/talk_start", entry_id: activeId }); }
    catch (e) { console.warn("BMS Intercom: talk_start", e); }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      micCtx = new AC();
      if (micCtx.state === "suspended") { try { await micCtx.resume(); } catch (e) {} }
      micSrc = micCtx.createMediaStreamSource(micStream);
      micProc = micCtx.createScriptProcessor(4096, 1, 1);
      micProc.onaudioprocess = (ev) => {
        if (!micOn) return;
        const ds = downsampleTo8k(ev.inputBuffer.getChannelData(0), micCtx.sampleRate);
        sendTalkData(encodeMuLaw(ds));
      };
      const zero = micCtx.createGain();
      zero.gain.value = 0;
      micSrc.connect(micProc); micProc.connect(zero); zero.connect(micCtx.destination);
    } catch (e) {
      console.warn("BMS Intercom: аудио-конвейер микрофона", e);
    }
    micOn = true; updateMicBtn(); return true;
  }

  async function toggleMic() {
    if (micOn) stopMic(); else await startMic();
    updateMicBtn();
  }

  function stopMic() {
    const wasActive = !!micStream;
    if (micProc) { try { micProc.disconnect(); micProc.onaudioprocess = null; } catch (e) {} micProc = null; }
    if (micSrc) { try { micSrc.disconnect(); } catch (e) {} micSrc = null; }
    if (micCtx) { try { micCtx.close(); } catch (e) {} micCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (wasActive) {
      const hass = getHass();
      if (hass && activeId) hass.connection.sendMessagePromise({ type: "bms_intercom/talk_stop", entry_id: activeId }).catch(() => {});
    }
    micOn = false;
  }

  // --- WebRTC (только приём: видео + входящий звук панели) ----------------
  function sendCandidate(cam, candidate) {
    const hass = getHass();
    if (!hass) return;
    if (!wrSession) { wrPending.push(candidate); return; }
    const c = { candidate: candidate.candidate || "" };
    if (candidate.sdpMid != null) c.sdpMid = candidate.sdpMid;
    if (candidate.sdpMLineIndex != null) c.sdpMLineIndex = candidate.sdpMLineIndex;
    hass.connection.sendMessagePromise({ type: "camera/webrtc/candidate", entity_id: cam, session_id: wrSession, candidate: c }).catch(() => {});
  }

  function handleSignal(msg) {
    if (!pc || !msg) return;
    if (msg.type === "session") {
      wrSession = msg.session_id;
      const queued = wrPending; wrPending = [];
      for (const c of queued) sendCandidate(wrCam, c);
    } else if (msg.type === "answer") {
      pc.setRemoteDescription({ type: "answer", sdp: msg.answer }).catch((e) => console.warn("setRemoteDescription", e));
    } else if (msg.type === "candidate") {
      let cand = msg.candidate;
      if (typeof cand === "string") cand = { candidate: cand };
      if (cand && cand.candidate != null) pc.addIceCandidate(cand).catch(() => {});
    } else if (msg.type === "error") {
      console.warn("BMS Intercom: WebRTC error", msg);
    }
  }

  async function startWebrtc(cam) {
    const hass = getHass();
    if (!hass || !cam || !hass.connection) return;
    stopWebrtc();
    const myToken = ++wrToken;
    wrCam = cam; wrSession = null; wrPending = [];
    remoteStream = new MediaStream();
    const v = videoElem();
    if (v) { v.srcObject = remoteStream; v.muted = true; }

    let iceServers = [{ urls: "stun:stun.home-assistant.io:80" }];
    try {
      const cfg = await hass.connection.sendMessagePromise({ type: "camera/webrtc/get_client_config", entity_id: cam });
      const servers = cfg && cfg.configuration && cfg.configuration.iceServers;
      if (Array.isArray(servers)) iceServers = servers;
    } catch (e) { /* ignore */ }
    if (myToken !== wrToken) return;

    pc = new RTCPeerConnection({ iceServers });
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" }); // микрофон идёт через ISAPI, не сюда

    pc.ontrack = (ev) => {
      if (remoteStream && !remoteStream.getTracks().includes(ev.track)) remoteStream.addTrack(ev.track);
      const vv = videoElem();
      if (vv) { if (vv.srcObject !== remoteStream) vv.srcObject = remoteStream; vv.play().catch(() => {}); }
    };
    pc.onicecandidate = (ev) => { if (ev.candidate) sendCandidate(cam, ev.candidate); };
    pc.onconnectionstatechange = () => { if (pc) console.info("%cBMS Intercom: WebRTC %s", LOG, pc.connectionState); };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (myToken !== wrToken) return;
      wrUnsub = await hass.connection.subscribeMessage(
        (m) => { if (myToken === wrToken) handleSignal(m); },
        { type: "camera/webrtc/offer", entity_id: cam, offer: pc.localDescription.sdp }
      );
    } catch (e) { console.warn("BMS Intercom: WebRTC offer не прошёл", e); }
  }

  function stopWebrtc() {
    wrToken++;
    if (wrUnsub) { try { const r = wrUnsub(); if (r && r.catch) r.catch(() => {}); } catch (e) {} wrUnsub = null; }
    if (pc) { try { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); } catch (e) {} pc = null; }
    wrSession = null; wrCam = null; wrPending = [];
    if (remoteStream) { remoteStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); remoteStream = null; }
    const v = videoElem();
    if (v) { v.srcObject = null; v.muted = true; }
  }

  // --- Видео --------------------------------------------------------------
  function showVideo(hass, cam, st, mode) {
    const vid = videoElem();
    const img = overlay.querySelector("img.bms-video-img");
    const canStream = st && ((st.attributes.supported_features || 0) & FEATURE_STREAM);
    if (canStream) {
      videoMode = "webrtc";
      img.classList.add("bms-hidden"); img.src = "";
      vid.classList.remove("bms-hidden");
      if (wrCam !== cam || !pc) startWebrtc(cam);
      // ringing — рингтон, idle — звук панели выкл по умолчанию; talk — звук вкл.
      if (mode === "talk") attemptUnmute(); else setMuted(true);
    } else if (st) {
      videoMode = "mjpeg";
      stopWebrtc();
      vid.classList.add("bms-hidden");
      img.classList.remove("bms-hidden");
      const token = st.attributes.access_token;
      const url = `/api/camera_proxy_stream/${cam}?token=${token}`;
      if (img.dataset.src !== url) { img.dataset.src = url; img.src = url; }
    }
  }

  function applyStage(id, group, mode) {
    const hass = getHass();
    const cam = group.roles.camera;
    currentMode = mode;

    card.dataset.mode = mode;
    overlay.querySelector(".bms-title").textContent = group.name;

    const status = overlay.querySelector(".bms-status");
    status.className = "bms-status " + mode;
    overlay.querySelector(".bms-status-text").textContent =
      mode === "ringing" ? "Входящий вызов" : mode === "talk" ? "Разговор" : "Онлайн";

    // Таблетка слева: входящий / таймер разговора.
    const pill = overlay.querySelector(".bms-pill");
    if (mode === "ringing") {
      pill.className = "bms-pill ring bms-only-call";
      pill.querySelector(".bms-pill-ic").innerHTML = svg("bell");
      pill.querySelector(".bms-pill-text").textContent = "Входящий вызов";
    } else if (mode === "talk") {
      pill.className = "bms-pill talk bms-only-call";
      pill.querySelector(".bms-pill-ic").innerHTML = svg("phone");
      if (!talkStart) talkStart = nowMs();
    }
    if (mode !== "talk") talkStart = 0;

    if (mode === "ringing") stopMic();
    updateMicBtn();
    updateSoundBtn();

    const st = cam && hass.states[cam];
    if (st) showVideo(hass, cam, st, mode);

    overlay.classList.add("show");
    if (mode === "ringing") audio.play().catch(() => {}); else audio.pause();
    updateClock();
    activeId = id;
  }

  function hide() {
    if (!overlay) return;
    overlay.classList.remove("show");
    audio.pause();
    clearAutoEnd();
    stopMic();
    stopWebrtc();
    const img = overlay.querySelector("img.bms-video-img");
    if (img) { img.src = ""; img.dataset.src = ""; }
    videoMode = null;
    talkStart = 0;
    currentMode = null;
    activeId = null;
    lastSig = null;
  }

  // --- Часы/таймер --------------------------------------------------------
  function nowMs() { return new Date().getTime(); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function updateClock() {
    if (!overlay || !overlay.classList.contains("show")) return;
    const d = new Date();
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dt = overlay.querySelector(".bms-datetime");
    if (dt) dt.textContent = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${days[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (currentMode === "talk" && talkStart) {
      const s = Math.max(0, Math.floor((nowMs() - talkStart) / 1000));
      const t = overlay.querySelector(".bms-pill-text");
      if (t) t.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    }
  }

  function tick() {
    const hass = getHass();
    if (!hass) return;
    if (!overlay) buildOverlay();

    const groups = groupIntercoms(hass);
    // 1) активный вызов (ringing приоритетнее answered)
    let pick = null, pickMode = null;
    for (const [id, g] of Object.entries(groups)) {
      if (g.callState === "ringing") { pick = [id, g]; pickMode = "ringing"; break; }
      if (g.callState === "answered" && !pick) { pick = [id, g]; pickMode = "talk"; }
    }
    // 2) иначе — открытый просмотр (idle)
    if (!pick) {
      for (const [id, g] of Object.entries(groups)) {
        if (g.viewOn) { pick = [id, g]; pickMode = "idle"; break; }
      }
    }
    if (!pick) { if (lastSig !== null) hide(); return; }

    const sig = `${pickMode}:${pick[0]}`;
    if (sig === lastSig) return;
    lastSig = sig;
    applyStage(pick[0], pick[1], pickMode);
  }

  setInterval(tick, POLL_MS);
  setInterval(updateClock, 1000);

  class BmsIntercomCard extends HTMLElement {
    setConfig() {}
    set hass(_) {}
    getCardSize() { return 0; }
  }
  if (!customElements.get("bms-intercom-card")) customElements.define("bms-intercom-card", BmsIntercomCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "bms-intercom-card",
    name: "BMS Intercom (поп-ап)",
    description: "Поп-ап вызова работает автоматически; отдельная карточка не требуется.",
  });

  // eslint-disable-next-line no-console
  console.info("%cBMS Intercom поп-ап загружен", LOG);
})();
