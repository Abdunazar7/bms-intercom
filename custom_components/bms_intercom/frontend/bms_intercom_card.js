/*
 * BMS Домофон — встроенный поп-ап вызывной панели.
 *
 * Загружается интеграцией автоматически на все дашборды. Следит за состоянием
 * домофонов и при входящем вызове показывает полноэкранное окно с видео,
 * звуком звонка и кнопками Ответить / Сбросить / Открыть дверь.
 *
 * Ничего настраивать в дашборде не нужно — модуль находит сущности по
 * атрибутам intercom_id / intercom_role, которые проставляет интеграция.
 */
(function () {
  "use strict";

  const STATIC = "/bms_intercom_static";
  const POLL_MS = 400;

  let overlay = null;
  let audio = null;
  let activeId = null; // intercom_id, для которого сейчас открыт поп-ап
  let micOn = false;
  let lastSig = null;  // подпись текущего состояния, чтобы не перерисовывать зря

  function getHass() {
    const el = document.querySelector("home-assistant");
    return el && el.hass ? el.hass : null;
  }

  // Сгруппировать сущности всех домофонов по intercom_id.
  function groupIntercoms(hass) {
    const groups = {};
    for (const st of Object.values(hass.states)) {
      const a = st.attributes || {};
      const id = a.intercom_id;
      if (!id) continue;
      const g = (groups[id] = groups[id] || { roles: {}, name: a.intercom_name || "Домофон" });
      if (a.intercom_role) g.roles[a.intercom_role] = st.entity_id;
      if (a.intercom_role === "call") {
        g.callState = a.call_state || (st.state === "on" ? "ringing" : "idle");
      }
    }
    return groups;
  }

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.id = "bms-intercom-overlay";
    overlay.innerHTML = `
      <style>
        #bms-intercom-overlay { position: fixed; inset: 0; z-index: 999999;
          background: rgba(8,10,16,.92); display: none; align-items: center;
          justify-content: center; font-family: var(--paper-font-body1_-_font-family, sans-serif); }
        #bms-intercom-overlay.show { display: flex; }
        .bms-card { width: min(92vw, 720px); background: #161a24; border-radius: 18px;
          overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
        .bms-head { display: flex; align-items: center; justify-content: space-between;
          padding: 14px 20px; color: #e6ebf2; font-size: 20px; font-weight: 600; }
        .bms-badge { font-size: 14px; font-weight: 600; padding: 4px 12px; border-radius: 999px; }
        .bms-badge.ring { background: #c0282890; color: #fff; animation: bmsblink 1s steps(2) infinite; }
        .bms-badge.talk { background: #1f8a4c; color: #fff; }
        @keyframes bmsblink { 50% { opacity: .35; } }
        .bms-video { width: 100%; aspect-ratio: 4/3; background: #000; object-fit: cover; display: block; }
        .bms-actions { display: flex; gap: 12px; padding: 16px 20px 22px; }
        .bms-btn { flex: 1; border: none; border-radius: 14px; padding: 16px 8px; font-size: 16px;
          font-weight: 600; color: #fff; cursor: pointer; display: flex; flex-direction: column;
          align-items: center; gap: 6px; transition: transform .05s, filter .15s; }
        .bms-btn:active { transform: scale(.96); }
        .bms-btn .ic { font-size: 26px; line-height: 1; }
        .bms-answer { background: #1f8a4c; }
        .bms-reject { background: #c02828; }
        .bms-door   { background: #2f6fed; }
        .bms-mic    { background: #46506b; }
        .bms-mic.on { background: #c9a227; }
        .bms-hidden { display: none !important; }
      </style>
      <div class="bms-card">
        <div class="bms-head">
          <span class="bms-title">Домофон</span>
          <span class="bms-badge ring">ВХОДЯЩИЙ ВЫЗОВ</span>
        </div>
        <img class="bms-video" alt="видео с панели" />
        <div class="bms-actions">
          <button class="bms-btn bms-answer"><span class="ic">📞</span>Ответить</button>
          <button class="bms-btn bms-mic bms-hidden"><span class="ic">🎙️</span>Микрофон</button>
          <button class="bms-btn bms-door"><span class="ic">🚪</span>Открыть</button>
          <button class="bms-btn bms-reject"><span class="ic">📵</span>Сбросить</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    audio = document.createElement("audio");
    audio.loop = true;
    audio.src = `${STATIC}/ring.mp3`;
    overlay.appendChild(audio);

    overlay.querySelector(".bms-answer").addEventListener("click", () => callRole("answer"));
    overlay.querySelector(".bms-reject").addEventListener("click", () => callRole("reject"));
    overlay.querySelector(".bms-door").addEventListener("click", () => callRole("open_door"));
    overlay.querySelector(".bms-mic").addEventListener("click", toggleMic);
  }

  function currentGroup() {
    const hass = getHass();
    if (!hass || !activeId) return null;
    return groupIntercoms(hass)[activeId] || null;
  }

  function callRole(role) {
    const hass = getHass();
    const g = currentGroup();
    if (!hass || !g) return;
    const entity = g.roles[role];
    if (entity) hass.callService("button", "press", { entity_id: entity });
  }

  function toggleMic() {
    micOn = !micOn;
    const btn = overlay.querySelector(".bms-mic");
    btn.classList.toggle("on", micOn);
    btn.querySelector(".ic").textContent = micOn ? "🔊" : "🎙️";
    // Реальный двусторонний звук (go2rtc WebRTC) подключается здесь;
    // в демо это переключатель состояния микрофона (push-to-talk).
  }

  function showFor(id, group) {
    const hass = getHass();
    const cam = group.roles.camera;
    const ringing = group.callState === "ringing";

    overlay.querySelector(".bms-title").textContent = group.name;
    const badge = overlay.querySelector(".bms-badge");
    badge.textContent = ringing ? "ВХОДЯЩИЙ ВЫЗОВ" : "РАЗГОВОР";
    badge.className = "bms-badge " + (ringing ? "ring" : "talk");

    // Микрофон по умолчанию выключен; кнопка появляется после ответа.
    const micBtn = overlay.querySelector(".bms-mic");
    micBtn.classList.toggle("bms-hidden", ringing);
    if (ringing) { micOn = false; micBtn.classList.remove("on"); micBtn.querySelector(".ic").textContent = "🎙️"; }
    overlay.querySelector(".bms-answer").classList.toggle("bms-hidden", !ringing);

    // Видео: MJPEG-поток камеры (демо-кадры или реальный поток панели).
    const img = overlay.querySelector(".bms-video");
    if (cam && hass.states[cam]) {
      const token = hass.states[cam].attributes.access_token;
      const url = `/api/camera_proxy_stream/${cam}?token=${token}`;
      if (img.dataset.src !== url) { img.dataset.src = url; img.src = url; }
    }

    overlay.classList.add("show");
    if (ringing) { audio.play().catch(() => {}); }
    else { audio.pause(); }
    activeId = id;
  }

  function hide() {
    if (!overlay) return;
    overlay.classList.remove("show");
    audio.pause();
    const img = overlay.querySelector(".bms-video");
    img.src = ""; img.dataset.src = "";
    activeId = null;
    lastSig = null;
  }

  function tick() {
    const hass = getHass();
    if (!hass) return;
    if (!overlay) buildOverlay();

    const groups = groupIntercoms(hass);
    // Выбираем первый домофон с активным вызовом (ringing приоритетнее).
    let pick = null;
    for (const [id, g] of Object.entries(groups)) {
      if (g.callState === "ringing") { pick = [id, g]; break; }
      if (g.callState === "answered" && !pick) pick = [id, g];
    }
    if (!pick) {
      if (lastSig !== null) hide();
      return;
    }
    // Перерисовываем только при смене домофона или статуса вызова.
    const sig = `${pick[0]}:${pick[1].callState}`;
    if (sig === lastSig) return;
    lastSig = sig;
    showFor(pick[0], pick[1]);
  }

  setInterval(tick, POLL_MS);

  // Также регистрируем как именованную карточку (можно добавить вручную, опционально).
  class BmsIntercomCard extends HTMLElement {
    setConfig() {}
    set hass(_) {}
    getCardSize() { return 0; }
  }
  if (!customElements.get("bms-intercom-card")) {
    customElements.define("bms-intercom-card", BmsIntercomCard);
  }
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "bms-intercom-card",
    name: "BMS Домофон (поп-ап)",
    description: "Поп-ап вызова работает автоматически; отдельная карточка не требуется.",
  });

  // eslint-disable-next-line no-console
  console.info("%cBMS Домофон поп-ап загружен", "color:#2f6fed;font-weight:600");
})();
