/*
 * BMS Intercom — встроенный поп-ап вызывной панели.
 *
 * Загружается интеграцией автоматически на все дашборды. Следит за состоянием
 * домофонов и при входящем вызове показывает полноэкранное окно с видео,
 * звуком звонка и кнопками Ответить / Сбросить / Открыть дверь.
 *
 * Видео: используется штатный элемент Home Assistant <ha-camera-stream> — тот
 * же, что и в обычной карточке камеры. Поэтому картинка (и входящий звук с
 * панели) приходят так же надёжно, как в карточке, независимо от того, отдаёт
 * ли go2rtc поток по WebRTC или HLS.
 *
 * Микрофон оператора (talk-back): по нажатию кнопки открывается отдельное
 * аудио-WebRTC-соединение к той же камере (camera/webrtc/offer) с дорожкой
 * микрофона. Если go2rtc поддерживает обратный канал к панели (Hikvision
 * two-way audio), голос уходит на домофон. Если нет — видео и входящий звук
 * всё равно работают.
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

  // --- Текущий рендерер видео --------------------------------------------
  let videoEl = null;   // активный элемент (ha-camera-stream | img)
  let videoKind = null; // 'ha' | 'mjpeg'
  let videoCam = null;  // entity_id камеры, который сейчас отрисован
  let ringingNow = false; // звонит ли сейчас (для подсказки про звук)

  // --- Аудио-WebRTC для talk-back (микрофон оператора → панель) -----------
  let pc = null;          // RTCPeerConnection (только для отправки голоса)
  let audioSender = null; // RTCRtpSender дорожки микрофона
  let wrUnsub = null;     // функция отписки от camera/webrtc/offer
  let wrSession = null;   // session_id, выданный Home Assistant
  let wrCamEntity = null; // entity_id камеры, к которой привязан текущий pc
  let wrPending = [];     // ICE-кандидаты, накопленные до получения session_id
  let wrToken = 0;        // защита от гонок между teardown и start

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
        .bms-video-slot { width: 100%; aspect-ratio: 4/3; background: #000; display: block; overflow: hidden; cursor: pointer; }
        .bms-video-slot > * { width: 100%; height: 100%; display: block; }
        .bms-video-slot img, .bms-video-slot video { object-fit: cover; }
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
          <div class="bms-video-slot"></div>
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
    overlay.querySelector(".bms-video-slot").addEventListener("click", () => setVideoMuted(false));
    overlay.querySelector(".bms-sound-hint").addEventListener("click", (e) => { e.stopPropagation(); setVideoMuted(false); });
    // Любой первый тап в окне (по кнопке/видео) — это жест: включаем звук панели.
    overlay.addEventListener("pointerdown", () => { if (!ringingNow) setVideoMuted(false); }, true);
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
    // «Ответить» — пользовательский жест: сразу включаем звук панели в видео.
    if (role === "answer") unmuteVideo();
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
    // 1) явный HTTPS-адрес из настроек интеграции
    if (g && g.httpsBase && g.httpsBase.indexOf("https://") === 0) {
      return g.httpsBase.replace(/\/+$/, "") + tail;
    }
    // 2) встроенный авто-прокси интеграции: тот же хост, отдельный HTTPS-порт
    if (g && g.httpsPort && location.hostname) {
      return "https://" + location.hostname + ":" + g.httpsPort + tail;
    }
    // 3) external/internal_url Home Assistant
    for (const base of [cfg.external_url, cfg.internal_url]) {
      if (base && base.indexOf("https://") === 0) {
        return base.replace(/\/+$/, "") + tail;
      }
    }
    return null;
  }

  // --- Видео --------------------------------------------------------------
  function videoSlot() {
    return overlay && overlay.querySelector(".bms-video-slot");
  }

  function clearVideo() {
    const slot = videoSlot();
    if (slot) slot.innerHTML = "";
    videoEl = null;
    videoKind = null;
    videoCam = null;
    updateSoundHint();
  }

  // ha-camera-stream разворачивается в ha-hls-player / ha-web-rtc-player,
  // внутри которых (в их shadow DOM) лежит реальный <video>. Ищем рекурсивно.
  function deepFindVideo(root) {
    if (!root || !root.querySelector) return null;
    const direct = root.querySelector("video");
    if (direct) return direct;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const found = deepFindVideo(el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  function innerVideo() {
    if (videoKind === "ha" && videoEl) {
      return deepFindVideo(videoEl.shadowRoot) || deepFindVideo(videoEl);
    }
    return null;
  }

  function waitInnerVideo(tries) {
    tries = tries || 25;
    return new Promise((resolve) => {
      let n = 0;
      const t = setInterval(() => {
        const v = innerVideo();
        if (v || ++n >= tries) { clearInterval(t); resolve(v); }
      }, 100);
    });
  }

  // Пытаемся включить звук панели. Если браузер блокирует autoplay со звуком —
  // тихо откатываемся в muted (видео продолжает идти) и оставляем подсказку.
  async function attemptUnmute() {
    if (videoKind !== "ha" || !videoEl) return false;
    const inner = await waitInnerVideo();
    try {
      videoEl.muted = false;
      if (inner) {
        inner.muted = false;
        const p = inner.play();
        if (p && typeof p.then === "function") await p;
      }
      updateSoundHint();
      return true;
    } catch (e) {
      setVideoMuted(true);
      return false;
    }
  }

  function isVideoMuted() {
    if (videoKind !== "ha" || !videoEl) return true;
    const inner = innerVideo();
    return inner ? inner.muted : videoEl.muted !== false;
  }

  function setVideoMuted(muted) {
    if (videoKind !== "ha" || !videoEl) return;
    try {
      videoEl.muted = muted;
      const inner = innerVideo();
      if (inner) {
        inner.muted = muted;
        if (!muted) inner.play().catch(() => {});
      }
    } catch (e) { /* ignore */ }
    updateSoundHint();
  }

  function unmuteVideo() {
    setVideoMuted(false);
  }

  function updateSoundHint() {
    const hint = overlay && overlay.querySelector(".bms-sound-hint");
    if (!hint) return;
    // Подсказку показываем только в разговоре, когда видео есть, но звук выключен.
    const show = videoKind === "ha" && !!videoEl && !ringingNow && isVideoMuted();
    hint.classList.toggle("bms-hidden", !show);
  }

  function renderVideo(hass, cam, st, ringing) {
    const slot = videoSlot();
    if (!slot) return;
    const canStream = st && ((st.attributes.supported_features || 0) & FEATURE_STREAM);
    const haStream = !!customElements.get("ha-camera-stream");

    if (canStream && haStream) {
      if (videoKind !== "ha" || videoCam !== cam) {
        clearVideo();
        const el = document.createElement("ha-camera-stream");
        el.hass = hass;
        el.stateObj = st;
        el.controls = false;
        // Всегда стартуем без звука: иначе браузер блокирует autoplay и видео
        // остаётся чёрным. Звук панели включается тапом по видео / кнопкой.
        el.muted = true;
        slot.appendChild(el);
        videoEl = el;
        videoKind = "ha";
        videoCam = cam;
        console.info("%cBMS Intercom: видео через ha-camera-stream (%s)", LOG, cam);
      } else {
        videoEl.hass = hass;
        videoEl.stateObj = st;
      }
      updateSoundHint();
    } else if (st) {
      // Демо / панель без потока / нет ha-camera-stream → MJPEG-кадр.
      if (videoKind !== "mjpeg" || videoCam !== cam) {
        clearVideo();
        const img = document.createElement("img");
        img.alt = "видео с панели";
        const token = st.attributes.access_token;
        img.src = `/api/camera_proxy_stream/${cam}?token=${token}`;
        slot.appendChild(img);
        videoEl = img;
        videoKind = "mjpeg";
        videoCam = cam;
        if (canStream && !haStream) {
          console.warn("BMS Intercom: ha-camera-stream недоступен, показываю MJPEG-заглушку");
        }
      }
    }
  }

  // --- Talk-back: микрофон оператора → панель через go2rtc backchannel -----
  // Вернуть направление аудиосекции SDP (sendrecv/recvonly/sendonly/inactive).
  function audioDirection(sdp) {
    if (!sdp) return null;
    const lines = sdp.split(/\r?\n/);
    let inAudio = false;
    let dir = null;
    for (const line of lines) {
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
      .sendMessagePromise({
        type: "camera/webrtc/candidate",
        entity_id: cam,
        session_id: wrSession,
        candidate: c,
      })
      .catch(() => {});
  }

  function handleSignal(msg) {
    if (!pc || !msg) return;
    if (msg.type === "session") {
      wrSession = msg.session_id;
      const queued = wrPending;
      wrPending = [];
      for (const c of queued) sendCandidate(wrCamEntity, c);
    } else if (msg.type === "answer") {
      // Диагностика обратного канала: если go2rtc/панель готовы принимать наш
      // звук, в аудиосекции ответа будет recvonly/sendrecv. Если sendonly/
      // inactive — обратного канала к панели нет (нужен backchannel в go2rtc).
      const dir = audioDirection(msg.answer);
      const ok = dir === "recvonly" || dir === "sendrecv";
      console.info(
        "%cBMS Intercom: talk-back ответ панели — аудио %s (обратный канал %s)",
        LOG, dir || "?", ok ? "ЕСТЬ ✅" : "НЕТ ❌"
      );
      if (!ok) {
        showToast("Панель не принимает обратный звук (go2rtc без backchannel). Видео и входящий звук работают.");
      }
      pc.setRemoteDescription({ type: "answer", sdp: msg.answer }).catch((e) =>
        console.warn("BMS Intercom: setRemoteDescription", e)
      );
    } else if (msg.type === "candidate") {
      let cand = msg.candidate;
      if (typeof cand === "string") cand = { candidate: cand };
      if (cand && cand.candidate != null) pc.addIceCandidate(cand).catch(() => {});
    } else if (msg.type === "error") {
      console.warn("BMS Intercom: talk-back WebRTC error", msg);
      showToast("Не удалось открыть аудиоканал к панели.");
    }
  }

  async function startTalkback(cam, track) {
    const hass = getHass();
    if (!hass || !cam || !hass.connection) return;
    stopTalkback();
    const myToken = ++wrToken;
    wrCamEntity = cam;
    wrSession = null;
    wrPending = [];

    let iceServers = [{ urls: "stun:stun.home-assistant.io:80" }];
    try {
      const cfg = await hass.connection.sendMessagePromise({
        type: "camera/webrtc/get_client_config",
        entity_id: cam,
      });
      const servers = cfg && cfg.configuration && cfg.configuration.iceServers;
      if (Array.isArray(servers)) iceServers = servers;
    } catch (e) {
      /* старый HA без этой команды — продолжаем с host-кандидатами */
    }
    if (myToken !== wrToken) return;

    pc = new RTCPeerConnection({ iceServers });
    // sendrecv: отправляем голос оператора; recv нам не нужен (звук панели
    // воспроизводит видео), но sendrecv надёжнее открывает обратный канал.
    const tr = pc.addTransceiver(track, { direction: "sendrecv" });
    audioSender = tr.sender;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendCandidate(cam, ev.candidate);
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      console.info("%cBMS Intercom: talk-back %s", LOG, pc.connectionState);
      if (pc.connectionState === "failed") {
        showToast("Аудиоканал к панели не установился.");
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (myToken !== wrToken) return;
      wrUnsub = await hass.connection.subscribeMessage(
        (msg) => { if (myToken === wrToken) handleSignal(msg); },
        { type: "camera/webrtc/offer", entity_id: cam, offer: pc.localDescription.sdp }
      );
    } catch (e) {
      console.warn("BMS Intercom: talk-back offer не прошёл", e);
      showToast("Не удалось открыть аудиоканал к панели.");
    }
  }

  function stopTalkback() {
    wrToken++;
    if (wrUnsub) {
      try {
        const r = wrUnsub();
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch (e) { /* ignore */ }
      wrUnsub = null;
    }
    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch (e) { /* ignore */ }
      pc = null;
    }
    audioSender = null;
    wrSession = null;
    wrCamEntity = null;
    wrPending = [];
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
    // Микрофон в браузере доступен только в защищённом контексте (HTTPS/localhost).
    if (!window.isSecureContext || !navigator.mediaDevices) {
      const su = secureUrl();
      if (su) {
        showToast("Микрофон работает только по HTTPS. Откройте защищённую версию:", su);
      } else {
        showToast("Микрофон работает только по HTTPS (или localhost). Включите HTTPS для Home Assistant — тогда здесь появится кнопка перехода.");
      }
      return;
    }
    if (!micOn) {
      const g = currentGroup();
      const cam = g && g.roles.camera;
      if (!cam) { showToast("Камера панели не найдена."); return; }
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        showToast("Доступ к микрофону отклонён в браузере.");
        return;
      }
      const track = micStream.getAudioTracks()[0];
      micOn = true;
      await startTalkback(cam, track);
    } else {
      stopTalkback();
      stopMic();
    }
    btn.classList.toggle("on", micOn);
    btn.querySelector(".ic").textContent = micOn ? "🔊" : "🎙️";
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

    // Микрофон по умолчанию выключен; кнопка появляется после ответа.
    const micBtn = overlay.querySelector(".bms-mic");
    micBtn.classList.toggle("bms-hidden", ringing);
    micBtn.title = window.isSecureContext ? "Микрофон (push-to-talk)" : "Микрофон доступен только по HTTPS";
    if (ringing) { stopTalkback(); stopMic(); micBtn.classList.remove("on"); micBtn.querySelector(".ic").textContent = "🎙️"; }
    overlay.querySelector(".bms-answer").classList.toggle("bms-hidden", !ringing);

    const st = cam && hass.states[cam];
    if (st) renderVideo(hass, cam, st, ringing);
    // В разговоре пытаемся сразу включить звук панели (если жест уже был —
    // например, ответили из попапа; иначе сработает при первом тапе).
    if (st && !ringing) attemptUnmute();

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
    stopTalkback();
    clearVideo();
    const micBtn = overlay.querySelector(".bms-mic");
    if (micBtn) { micBtn.classList.remove("on"); micBtn.querySelector(".ic").textContent = "🎙️"; }
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
    if (sig === lastSig) {
      // Подкормим ha-camera-stream свежим hass (токены/состояние).
      if (videoKind === "ha" && videoEl) videoEl.hass = hass;
      return;
    }
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
    name: "BMS Intercom (поп-ап)",
    description: "Поп-ап вызова работает автоматически; отдельная карточка не требуется.",
  });

  // eslint-disable-next-line no-console
  console.info("%cBMS Intercom поп-ап загружен", LOG);
})();
