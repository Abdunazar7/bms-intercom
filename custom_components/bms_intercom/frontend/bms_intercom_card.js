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
          background: rgba(6,8,14,.94); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
          display: none; align-items: center; justify-content: center;
          font-family: var(--paper-font-body1_-_font-family, "Segoe UI", Roboto, system-ui, sans-serif); }
        #bms-intercom-overlay.show { display: flex; }
        .bms-card { position: relative; width: 100vw; height: 100vh; height: 100dvh;
          display: flex; flex-direction: column;
          background: linear-gradient(180deg, #1c2333 0%, #141823 100%);
          overflow: hidden; animation: bmsin .22s ease; }
        @keyframes bmsin { from { opacity: 0; } to { opacity: 1; } }
        .bms-head { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 16px 22px; }
        .bms-brand { display: flex; align-items: center; gap: 12px; color: #eef2f8; }
        .bms-logo { width: 32px; height: 32px; display: block; flex: none; border-radius: 9px; }
        .bms-title { font-size: 18px; font-weight: 700; letter-spacing: .2px; }
        .bms-badge { font-size: 11.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase;
          padding: 6px 13px 6px 11px; border-radius: 999px; display: flex; align-items: center; gap: 7px; }
        .bms-badge::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
        .bms-badge.ring { background: rgba(224,60,60,.16); color: #ff6b6b; animation: bmsblink 1.1s steps(2) infinite; }
        .bms-badge.talk { background: rgba(38,180,110,.16); color: #3ddc8a; }
        @keyframes bmsblink { 50% { opacity: .4; } }
        .bms-video-wrap { position: relative; flex: 1 1 auto; min-height: 0; margin: 0;
          background: #000; display: flex; align-items: center; justify-content: center; }
        .bms-video { width: 100%; height: 100%; aspect-ratio: auto; background: #000;
          object-fit: contain; display: block; }
        .bms-sound-hint { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
          background: rgba(0,0,0,.58); color: #fff; padding: 8px 16px; border-radius: 999px; font-size: 13px;
          font-weight: 600; cursor: pointer; z-index: 2; display: flex; align-items: center; gap: 7px;
          -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
          box-shadow: 0 4px 16px rgba(0,0,0,.5); }
        .bms-actions { flex: none; display: flex; gap: 12px; padding: 16px;
          width: 100%; max-width: 820px; margin: 0 auto; box-sizing: border-box;
          padding-bottom: max(16px, env(safe-area-inset-bottom)); }
        .bms-btn { flex: 1 1 0; min-width: 70px; border: none; border-radius: 20px; padding: 16px 8px 14px;
          font-size: 14px; font-weight: 600; color: #fff; cursor: pointer; display: flex; flex-direction: column;
          align-items: center; gap: 9px; background: #2b3346;
          transition: transform .07s ease, filter .15s ease, background .15s ease; }
        .bms-btn:hover { filter: brightness(1.12); }
        .bms-btn:active { transform: scale(.94); }
        .bms-btn .ic { width: 54px; height: 54px; border-radius: 50%; display: flex; align-items: center;
          justify-content: center; font-size: 27px; line-height: 1; background: rgba(255,255,255,.13); }
        .bms-answer { background: #1f9e57; }
        .bms-answer .ic { background: rgba(255,255,255,.2); }
        .bms-reject { background: #e2483a; }
        .bms-reject .ic { background: rgba(255,255,255,.2); transform: rotate(135deg); }
        .bms-door   { background: #2f6fed; }
        .bms-mic.off { background: #c0392b; }
        .bms-hidden { display: none !important; }
        .bms-toast { position: absolute; left: 50%; bottom: 124px; transform: translateX(-50%);
          max-width: 86%; background: #20283a; color: #eaf0f8; border: 1px solid #3a4660;
          border-radius: 14px; padding: 11px 16px; font-size: 14px; line-height: 1.35; text-align: center;
          box-shadow: 0 8px 26px rgba(0,0,0,.55); opacity: 0; pointer-events: none; transition: opacity .2s; }
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
          <button class="bms-btn bms-reject"><span class="ic">📞</span>Сбросить</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    audio = document.createElement("audio");
    audio.loop = true;
    audio.src = `${STATIC}/ring1.mp3`;
    overlay.appendChild(audio);

    overlay.querySelector(".bms-answer").addEventListener("click", () => callRole("answer"));
    overlay.querySelector(".bms-reject").addEventListener("click", () => callRole("reject"));
    overlay.querySelector(".bms-door").addEventListener("click", () => callRole("open_door"));
    overlay.querySelector(".bms-mic").addEventListener("click", toggleMic);
    // Звук панели (микрофон домофона) не отключается — он всегда включён после
    // ответа. Autoplay со звуком браузер блокирует, поэтому видео стартует без
    // звука, а звук включаем при первом взаимодействии (на всякий случай).
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
    if (role === "answer") {
      // Как телефон: ответили → слышим панель и сразу говорим (микрофон вкл).
      setMuted(false);   // звук панели (его выключить нельзя — всегда вкл)
      startMic(true);    // микрофон оператора включён по умолчанию (тихо)
    }
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
    if (!overlay) return;
    const v = videoElem();
    const muted = !v || v.muted;
    // Подсказка над видео — только в разговоре, пока звук панели почему-то
    // выключен (например, ответили не из попапа). Звук панели не отключается.
    const hint = overlay.querySelector(".bms-sound-hint");
    if (hint) {
      const show = videoMode === "webrtc" && v && !!v.srcObject && !ringingNow && muted;
      hint.classList.toggle("bms-hidden", !show);
    }
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

  function micAudioTrack() {
    return micStream ? micStream.getAudioTracks()[0] : null;
  }

  function updateMicBtn() {
    const btn = overlay && overlay.querySelector(".bms-mic");
    if (!btn) return;
    btn.classList.toggle("off", !micOn); // off = микрофон выключен (красный)
    const ic = btn.querySelector(".ic");
    if (ic) ic.textContent = micOn ? "🎙️" : "🔇";
  }

  // Включить микрофон оператора (по умолчанию он включён после ответа).
  // silent=true — авто-запуск при ответе (без всплывающих сообщений);
  // обычный вызов (кнопка) — с подсказками.
  async function startMic(silent) {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      if (!silent) {
        const su = secureUrl();
        if (su) showToast("Микрофон работает только по HTTPS. Откройте защищённую версию:", su);
        else showToast("Микрофон работает только по HTTPS (или localhost).");
      }
      micOn = false; updateMicBtn();
      return false;
    }
    if (!audioSender) { micOn = false; updateMicBtn(); return false; }
    if (!micStream) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        if (!silent) showToast("Доступ к микрофону отклонён в браузере.");
        micOn = false; updateMicBtn();
        return false;
      }
      try {
        await audioSender.replaceTrack(micAudioTrack());
      } catch (e) {
        console.warn("BMS Intercom: replaceTrack(mic)", e);
      }
    }
    const track = micAudioTrack();
    if (track) track.enabled = true;
    micOn = !!track;
    updateMicBtn();
    return micOn;
  }

  // Кнопка микрофона: вкл ↔ выкл (без переподключения — мгновенно через
  // track.enabled). При первом нажатии (если ещё не запущен) — запрашиваем доступ.
  async function toggleMic() {
    if (!micStream) { await startMic(); return; }
    const track = micAudioTrack();
    micOn = !micOn;
    if (track) track.enabled = micOn;
    updateMicBtn();
  }

  function stopMic() {
    if (micStream) {
      micStream.getTracks().forEach((tr) => tr.stop());
      micStream = null;
    }
    if (audioSender) { try { audioSender.replaceTrack(null); } catch (e) { /* ignore */ } }
    micOn = false;
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
    micBtn.title = window.isSecureContext ? "Микрофон (вкл/выкл)" : "Микрофон доступен только по HTTPS";
    if (ringing) stopMic();
    updateMicBtn();
    // Во время звонка — «Ответить»; в разговоре — «Микрофон».
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
