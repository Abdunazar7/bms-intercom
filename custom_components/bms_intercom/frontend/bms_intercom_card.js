/*
 * BMS Intercom — встроенный поп-ап вызывной панели.
 *
 * Загружается интеграцией автоматически на все дашборды. Следит за состоянием
 * домофонов и при входящем вызове показывает полноэкранное окно с видео,
 * звуком звонка и кнопками Ответить / Сбросить / Открыть дверь.
 *
 * Видео + звук: реальная панель показывается через ОДНО собственное
 * WebRTC-соединение к камере (camera/webrtc/offer Home Assistant → go2rtc).
 * Одно соединение делает сразу всё:
 *   - видео (recvonly),
 *   - входящий звук панели (приходит в том же соединении),
 *   - микрофон оператора (talk-back) — добавляется в ту же аудиодорожку.
 * Так мы полностью контролируем mute/звук и чисто закрываем соединение в
 * конце каждого вызова (pc.close) — поэтому следующий вызов работает без
 * перезагрузки страницы.
 *
 * Talk-back (микрофон → панель) доходит, только если go2rtc умеет обратный
 * канал Hikvision (модуль isapi). Если нет — видео и входящий звук работают.
 *
 * В демо-режиме (без железа) камера отдаёт нарисованный MJPEG-поток — для него
 * используется простой <img>.
 *
 * Ничего настраивать в дашборде не нужно — модуль находит сущности по
 * атрибутам intercom_id / intercom_role, которые проставляет интеграция.
 */
(function () {
  "use strict";

  const STATIC = "/bms_intercom_static";
  const POLL_MS = 400;
  const FEATURE_STREAM = 2; // CameraEntityFeature.STREAM
  const LOG = "color:#2f6fed;font-weight:600";

  let overlay = null;
  let audio = null;
  let activeId = null; // intercom_id, для которого сейчас открыт поп-ап
  let micOn = false;
  let micStream = null; // активный поток микрофона оператора (если разрешён)
  let lastSig = null;  // подпись текущего состояния, чтобы не перерисовывать зря
  let ringingNow = false; // звонит ли сейчас (для подсказки про звук)

  // --- Состояние WebRTC (видео + входящий звук + микрофон) ----------------
  let pc = null;             // RTCPeerConnection
  let audioSender = null;    // RTCRtpSender аудио (для talk-back через replaceTrack)
  let remoteStream = null;   // MediaStream от панели (видео+звук)
  let wrUnsub = null;        // функция отписки от camera/webrtc/offer
  let wrSession = null;      // session_id, выданный Home Assistant
  let wrCam = null;          // entity_id камеры текущего соединения
  let wrPending = [];        // ICE-кандидаты до получения session_id
  let wrToken = 0;           // защита от гонок между teardown и start
  let videoMode = null;      // 'webrtc' | 'mjpeg' — что сейчас показываем

  function getHass() {
    const el = document.querySelector("home-assistant");
    return el && el.hass ? el.hass : null;
  }

  // Сгруппировать сущности всех домофонов по intercom_id.
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
        .bms-card { position: relative; width: min(92vw, 720px); background: #161a24; border-radius: 18px;
          overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
        .bms-head { display: flex; align-items: center; justify-content: space-between;
          padding: 14px 20px; color: #e6ebf2; font-size: 20px; font-weight: 600; }
        .bms-brand { display: flex; align-items: center; gap: 12px; }
        .bms-logo { width: 34px; height: 34px; display: block; flex: none; }
        .bms-badge { font-size: 14px; font-weight: 600; padding: 4px 12px; border-radius: 999px; }
        .bms-badge.ring { background: #c0282890; color: #fff; animation: bmsblink 1s steps(2) infinite; }
        .bms-badge.talk { background: #1f8a4c; color: #fff; }
        @keyframes bmsblink { 50% { opacity: .35; } }
        .bms-video-wrap { position: relative; }
        .bms-video { width: 100%; aspect-ratio: 4/3; background: #000; object-fit: cover; display: block; }
        .bms-sound-hint { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
          background: rgba(0,0,0,.62); color: #fff; padding: 7px 16px; border-radius: 999px; font-size: 13px;
          font-weight: 600; cursor: pointer; z-index: 2; display: flex; align-items: center; gap: 6px;
          box-shadow: 0 4px 14px rgba(0,0,0,.5); }
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
        .bms-toast { position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%);
          max-width: 88%; background: #20283a; color: #eaf0f8; border: 1px solid #3a4660;
          border-radius: 12px; padding: 10px 16px; font-size: 14px; line-height: 1.35; text-align: center;
          box-shadow: 0 8px 24px rgba(0,0,0,.5); opacity: 0; pointer-events: none; transition: opacity .2s; }
        .bms-toast.show { opacity: 1; }
      </style>
      <div class="bms-card">
        <div class="bms-head">
          <span class="bms-brand">
            <img class="bms-logo" src="${STATIC}/logo.svg" alt="BMS Intercom" />
            <span class="bms-title">Домофон</span>
          </span>
          <span class="bms-badge ring">ВХОДЯЩИЙ ВЫЗОВ</span>
        </div>
        <div class="bms-video-wrap">
          <video class="bms-video" autoplay playsinline muted></video>
          <img class="bms-video bms-video-img bms-hidden" alt="видео с панели" />
          <div class="bms-sound-hint bms-hidden"><span>🔇</span>Нажмите, чтобы слышать панель</div>
        </div>
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
    // Autoplay со звуком браузер блокирует, поэтому видео стартует без звука,
    // а звук панели включаем при первом же взаимодействии пользователя.
    overlay.querySelector(".bms-video").addEventListener("click", () => setMuted(false));
    overlay.querySelector(".bms-sound-hint").addEventListener("click", (e) => { e.stopPropagation(); setMuted(false); });
    overlay.addEventListener("pointerdown", () => { if (!ringingNow) setMuted(false); }, true);
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
    if (role === "answer") setMuted(false); // жест: сразу включаем звук панели
  }

  function showToast(msg, link) {
    if (!overlay) return;
    let t = overlay.querySelector(".bms-toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "bms-toast";
      overlay.querySelector(".bms-card").appendChild(t);
    }
    t.textContent = msg;
    if (link) {
      const a = document.createElement("a");
      a.href = link;
      a.textContent = "Открыть по HTTPS";
      a.style.cssText = "display:inline-block;margin-top:8px;color:#7db1ff;font-weight:700;text-decoration:none;";
      t.appendChild(document.createElement("br"));
      t.appendChild(a);
    }
    t.classList.add("show");
    clearTimeout(t._hide);
    t._hide = setTimeout(() => t.classList.remove("show"), link ? 12000 : 5000);
  }

  // Если HA знает свой HTTPS-адрес (cloud/external/internal), вернём ссылку на ту же страницу по HTTPS.
  function secureUrl() {
    const hass = getHass();
    const cfg = (hass && hass.config) || {};
    const g = currentGroup();
    const tail = location.pathname + location.search + location.hash;
    if (g && g.httpsBase && g.httpsBase.indexOf("https://") === 0) {
      return g.httpsBase.replace(/\/+$/, "") + tail;
    }
    if (g && g.httpsPort && location.hostname) {
      return "https://" + location.hostname + ":" + g.httpsPort + tail;
    }
    for (const base of [cfg.external_url, cfg.internal_url]) {
      if (base && base.indexOf("https://") === 0) {
        return base.replace(/\/+$/, "") + tail;
      }
    }
    return null;
  }

  // --- Звук видео ---------------------------------------------------------
  function videoElem() {
    return overlay && overlay.querySelector("video.bms-video");
  }

  // Принудительно включить/выключить звук панели (вызывается по жесту).
  function setMuted(muted) {
    const v = videoElem();
    if (!v) return;
    v.muted = muted;
    if (!muted) v.play().catch(() => {});
    updateSoundHint();
  }

  // Попытаться включить звук без явного жеста (после ответа). Если браузер
  // блокирует — тихо остаёмся без звука, видео продолжает идти.
  function attemptUnmute() {
    const v = videoElem();
    if (!v) return;
    v.muted = false;
    Promise.resolve(v.play())
      .then(() => updateSoundHint())
      .catch(() => { v.muted = true; v.play().catch(() => {}); updateSoundHint(); });
  }

  function updateSoundHint() {
    const hint = overlay && overlay.querySelector(".bms-sound-hint");
    if (!hint) return;
    const v = videoElem();
    const show = videoMode === "webrtc" && v && !!v.srcObject && !ringingNow && v.muted;
    hint.classList.toggle("bms-hidden", !show);
  }

  // --- WebRTC -------------------------------------------------------------
  function preferG711(transceiver) {
    // Hikvision two-way audio работает на G.711 (PCMU/PCMA 8кГц). Просим браузер
    // отдавать микрофон в G.711, чтобы go2rtc мог передать звук панели как есть.
    try {
      const caps = window.RTCRtpSender && RTCRtpSender.getCapabilities
        ? RTCRtpSender.getCapabilities("audio") : null;
      if (caps && transceiver.setCodecPreferences) {
        const g711 = (c) => /pcmu|pcma|g722/i.test(c.mimeType);
        const pref = caps.codecs.filter(g711);
        const rest = caps.codecs.filter((c) => !g711(c));
        if (pref.length) transceiver.setCodecPreferences([...pref, ...rest]);
      }
    } catch (e) { /* setCodecPreferences не поддержан — не критично */ }
  }

  function audioDirection(sdp) {
    if (!sdp) return null;
    let inAudio = false, dir = null;
    for (const line of sdp.split(/\r?\n/)) {
      if (line.startsWith("m=")) inAudio = line.startsWith("m=audio");
      else if (inAudio && line.startsWith("a=")) {
        const a = line.slice(2).trim();
        if (a === "sendrecv" || a === "recvonly" || a === "sendonly" || a === "inactive") dir = a;
      }
    }
    return dir;
  }

  function sendCandidate(cam, candidate) {
    const hass = getHass();
    if (!hass) return;
    if (!wrSession) { wrPending.push(candidate); return; }
    const c = { candidate: candidate.candidate || "" };
    if (candidate.sdpMid != null) c.sdpMid = candidate.sdpMid;
    if (candidate.sdpMLineIndex != null) c.sdpMLineIndex = candidate.sdpMLineIndex;
    hass.connection
      .sendMessagePromise({ type: "camera/webrtc/candidate", entity_id: cam, session_id: wrSession, candidate: c })
      .catch(() => {});
  }

  function handleSignal(msg) {
    if (!pc || !msg) return;
    if (msg.type === "session") {
      wrSession = msg.session_id;
      const queued = wrPending;
      wrPending = [];
      for (const c of queued) sendCandidate(wrCam, c);
    } else if (msg.type === "answer") {
      const dir = audioDirection(msg.answer);
      const ok = dir === "recvonly" || dir === "sendrecv";
      console.info("%cBMS Intercom: ответ панели — talk-back %s (%s)", LOG, ok ? "ЕСТЬ ✅" : "НЕТ ❌", dir || "?");
      pc.setRemoteDescription({ type: "answer", sdp: msg.answer }).catch((e) =>
        console.warn("BMS Intercom: setRemoteDescription", e));
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
    wrCam = cam;
    wrSession = null;
    wrPending = [];
    remoteStream = new MediaStream();
    const v = videoElem();
    if (v) { v.srcObject = remoteStream; v.muted = true; }

    let iceServers = [{ urls: "stun:stun.home-assistant.io:80" }];
    try {
      const cfg = await hass.connection.sendMessagePromise({ type: "camera/webrtc/get_client_config", entity_id: cam });
      const servers = cfg && cfg.configuration && cfg.configuration.iceServers;
      if (Array.isArray(servers)) iceServers = servers;
    } catch (e) { /* старый HA без этой команды — host-кандидатов на LAN хватает */ }
    if (myToken !== wrToken) return;

    pc = new RTCPeerConnection({ iceServers });
    pc.addTransceiver("video", { direction: "recvonly" });
    const at = pc.addTransceiver("audio", { direction: "sendrecv" });
    audioSender = at.sender;
    preferG711(at);

    pc.ontrack = (ev) => {
      // go2rtc иногда не заполняет ev.streams — собираем дорожки сами.
      if (remoteStream && !remoteStream.getTracks().includes(ev.track)) {
        remoteStream.addTrack(ev.track);
      }
      const vv = videoElem();
      if (vv) {
        if (vv.srcObject !== remoteStream) vv.srcObject = remoteStream;
        vv.play().catch(() => {});
      }
    };
    pc.onicecandidate = (ev) => { if (ev.candidate) sendCandidate(cam, ev.candidate); };
    pc.onconnectionstatechange = () => {
      if (pc) console.info("%cBMS Intercom: WebRTC %s", LOG, pc.connectionState);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (myToken !== wrToken) return;
      wrUnsub = await hass.connection.subscribeMessage(
        (m) => { if (myToken === wrToken) handleSignal(m); },
        { type: "camera/webrtc/offer", entity_id: cam, offer: pc.localDescription.sdp }
      );
      console.info("%cBMS Intercom: видео+звук через WebRTC (%s)", LOG, cam);
    } catch (e) {
      console.warn("BMS Intercom: WebRTC offer не прошёл", e);
    }
  }

  function stopWebrtc() {
    wrToken++;
    if (wrUnsub) {
      try { const r = wrUnsub(); if (r && typeof r.catch === "function") r.catch(() => {}); } catch (e) { /* ignore */ }
      wrUnsub = null;
    }
    if (pc) {
      try { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); } catch (e) { /* ignore */ }
      pc = null;
    }
    audioSender = null;
    wrSession = null;
    wrCam = null;
    wrPending = [];
    if (remoteStream) { remoteStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); remoteStream = null; }
    const v = videoElem();
    if (v) { v.srcObject = null; v.muted = true; }
  }

  function stopMic() {
    if (micStream) {
      micStream.getTracks().forEach((tr) => tr.stop());
      micStream = null;
    }
    micOn = false;
  }

  async function toggleMic() {
    const btn = overlay.querySelector(".bms-mic");
    if (!window.isSecureContext || !navigator.mediaDevices) {
      const su = secureUrl();
      if (su) showToast("Микрофон работает только по HTTPS. Откройте защищённую версию:", su);
      else showToast("Микрофон работает только по HTTPS (или localhost). Включите HTTPS для Home Assistant — тогда здесь появится кнопка перехода.");
      return;
    }
    if (!micOn) {
      if (!audioSender) { showToast("Звуковой канал ещё не готов. Нажмите «Ответить» и попробуйте снова."); return; }
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        showToast("Доступ к микрофону отклонён в браузере.");
        return;
      }
      const track = micStream.getAudioTracks()[0];
      try {
        await audioSender.replaceTrack(track);
      } catch (e) {
        console.warn("BMS Intercom: replaceTrack(mic)", e);
        showToast("Не удалось подключить микрофон к разговору.");
        stopMic();
        return;
      }
      micOn = true;
      setMuted(false); // заодно включаем звук панели
    } else {
      if (audioSender) { try { await audioSender.replaceTrack(null); } catch (e) { /* ignore */ } }
      stopMic();
    }
    btn.classList.toggle("on", micOn);
    btn.querySelector(".ic").textContent = micOn ? "🔊" : "🎙️";
  }

  function showVideo(hass, cam, st, ringing) {
    const vid = videoElem();
    const img = overlay.querySelector("img.bms-video-img");
    const canStream = st && ((st.attributes.supported_features || 0) & FEATURE_STREAM);

    if (canStream) {
      videoMode = "webrtc";
      img.classList.add("bms-hidden");
      img.src = "";
      vid.classList.remove("bms-hidden");
      if (wrCam !== cam || !pc) startWebrtc(cam);
      // Во время звонка — без звука (играет рингтон). После ответа пробуем
      // включить звук панели (если уже был жест — сразу, иначе по первому тапу).
      if (ringing) setMuted(true);
      else attemptUnmute();
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

  function showFor(id, group) {
    const hass = getHass();
    const cam = group.roles.camera;
    const ringing = group.callState === "ringing";
    ringingNow = ringing;

    overlay.querySelector(".bms-title").textContent = group.name;
    const badge = overlay.querySelector(".bms-badge");
    badge.textContent = ringing ? "ВХОДЯЩИЙ ВЫЗОВ" : "РАЗГОВОР";
    badge.className = "bms-badge " + (ringing ? "ring" : "talk");

    const micBtn = overlay.querySelector(".bms-mic");
    micBtn.classList.toggle("bms-hidden", ringing);
    micBtn.title = window.isSecureContext ? "Микрофон (push-to-talk)" : "Микрофон доступен только по HTTPS";
    if (ringing) { stopMic(); micBtn.classList.remove("on"); micBtn.querySelector(".ic").textContent = "🎙️"; }
    overlay.querySelector(".bms-answer").classList.toggle("bms-hidden", !ringing);

    const st = cam && hass.states[cam];
    if (st) showVideo(hass, cam, st, ringing);

    overlay.classList.add("show");
    if (ringing) { audio.play().catch(() => {}); }
    else { audio.pause(); }
    activeId = id;
  }

  function hide() {
    if (!overlay) return;
    overlay.classList.remove("show");
    audio.pause();
    stopMic();
    stopWebrtc();
    const img = overlay.querySelector("img.bms-video-img");
    if (img) { img.src = ""; img.dataset.src = ""; }
    videoMode = null;
    const micBtn = overlay.querySelector(".bms-mic");
    if (micBtn) { micBtn.classList.remove("on"); micBtn.querySelector(".ic").textContent = "🎙️"; }
    updateSoundHint();
    activeId = null;
    lastSig = null;
  }

  function tick() {
    const hass = getHass();
    if (!hass) return;
    if (!overlay) buildOverlay();

    const groups = groupIntercoms(hass);
    let pick = null;
    for (const [id, g] of Object.entries(groups)) {
      if (g.callState === "ringing") { pick = [id, g]; break; }
      if (g.callState === "answered" && !pick) pick = [id, g];
    }
    if (!pick) {
      if (lastSig !== null) hide();
      return;
    }
    const sig = `${pick[0]}:${pick[1].callState}`;
    if (sig === lastSig) return;
    lastSig = sig;
    showFor(pick[0], pick[1]);
  }

  setInterval(tick, POLL_MS);

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
    name: "BMS Intercom (поп-ап)",
    description: "Поп-ап вызова работает автоматически; отдельная карточка не требуется.",
  });

  // eslint-disable-next-line no-console
  console.info("%cBMS Intercom поп-ап загружен", LOG);
})();
