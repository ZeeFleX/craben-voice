const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const muteBtn = document.getElementById('mute');
const usersEl = document.getElementById('users');
const nameModal = document.getElementById('name-modal');
const nameForm = document.getElementById('name-form');
const nameInput = document.getElementById('name-input');
const micSelect = document.getElementById('mic-select');
const noiseToggle = document.getElementById('noise-toggle');
const pttToggle = document.getElementById('ptt-toggle');

let socket = null;
let myName = localStorage.getItem('crabenName') || '';

// id пира -> { pc, isInitiator, gain, analyser, source }
const peers = {};
// id пира -> громкость 0..2 (выше 1 — усиление через GainNode)
const volumes = {};
// id пира -> { muted, speaking }
const peerStates = {};
// Собственное состояние (в ростере видим и себя)
const myState = { muted: false, speaking: false };

let rawStream = null; // сырой поток с микрофона
let processedStream = null; // после цепочки обработки — уходит в WebRTC
let muted = false;
let spaceHeld = false;

// Настройки, переживающие перезагрузку страницы
const settings = {
  noise: localStorage.getItem('crabenNoise') !== '0',
  ptt: localStorage.getItem('crabenPtt') === '1',
  deviceId: localStorage.getItem('crabenDeviceId') || '',
};

// --- Аудиограф ---

let audioCtx = null;
let chain = null; // { source, highpass, compressor, dest }
let rnnoiseNode = null;
let rnnoiseLoadPromise = null;
let analyserSink = null; // неслышный сток для анализаторов (иначе они не тикают)
let localAnalyser = null;
const remoteAnalysers = {}; // id пира -> AnalyserNode

// Запасной вариант, если /ice-config недоступен
let RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}

function statusOk() {
  setStatus(settings.ptt ? 'Удерживай пробел, чтобы говорить' : 'Ты в голосовом чате', 'ok');
}

// --- Имя ---

nameForm.onsubmit = (e) => {
  e.preventDefault();
  myName = nameInput.value.trim().slice(0, 24) || 'Краб';
  localStorage.setItem('crabenName', myName);
  nameModal.classList.remove('visible');
  connect();
};

if (myName) {
  connect();
} else {
  nameModal.classList.add('visible');
  setStatus('');
  nameInput.focus();
}

// Браузер блокирует звук до первого жеста — будим AudioContext по кликам/клавишам
const resumeAudio = () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
};
document.addEventListener('pointerdown', resumeAudio);
document.addEventListener('keydown', resumeAudio);

// --- Микрофон и цепочка обработки ---
// getUserMedia -> high-pass 90 Гц (гул) -> компрессор (крики/шёпот) -> [RNNoise] -> WebRTC

function getMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true, // базовый браузерный шумодав, RNNoise идёт поверх
      autoGainControl: true,
    },
    video: false,
  });
}

async function initMic(deviceId) {
  try {
    if (rawStream) rawStream.getTracks().forEach((t) => t.stop());

    try {
      rawStream = await getMic(deviceId);
    } catch (err) {
      // Выбранный микрофон мог отвалиться — пробуем устройство по умолчанию
      if (!deviceId) throw err;
      rawStream = await getMic(undefined);
    }

    if (!audioCtx) {
      // Фиксируем 48 кГц — RNNoise работает только на этой частоте
      audioCtx = new AudioContext({ sampleRate: 48000 });
      analyserSink = audioCtx.createGain();
      analyserSink.gain.value = 0;
      analyserSink.connect(audioCtx.destination);
    }
    audioCtx.resume();

    buildLocalChain();
    // Шумодав включён в настройках — догружаем ворклет в фоне и встраиваем в цепочку
    if (settings.noise) ensureRnnoiseNode().then(() => connectChainTail());
    statusOk();
    muteBtn.disabled = false;

    // Подсовываем обработанный трек всем существующим пирам (смена микрофона)
    const track = processedStream.getAudioTracks()[0];
    for (const peer of Object.values(peers)) {
      const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender) sender.replaceTrack(track).catch(() => {});
    }

    applyMicGate();
    populateMicList();
  } catch (err) {
    setStatus('Нужен доступ к микрофону. Разреши и обнови страницу.', 'error');
  }
}

function buildLocalChain() {
  if (chain) {
    chain.source.disconnect();
    chain.highpass.disconnect();
    chain.compressor.disconnect();
    if (rnnoiseNode) rnnoiseNode.disconnect();
  }

  const source = audioCtx.createMediaStreamSource(rawStream);

  const highpass = audioCtx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 90; // срезаем гул и бубнёж ниже голосового диапазона

  const compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  const dest = audioCtx.createMediaStreamDestination();

  source.connect(highpass);
  highpass.connect(compressor);

  chain = { source, highpass, compressor, dest };
  connectChainTail();

  // Анализатор для индикатора «я говорю» — снимаем сигнал после обработки
  if (localAnalyser) localAnalyser.disconnect();
  localAnalyser = audioCtx.createAnalyser();
  localAnalyser.fftSize = 512;
  compressor.connect(localAnalyser);
  localAnalyser.connect(analyserSink);

  processedStream = dest.stream;
}

// Хвост цепочки: компрессор -> [RNNoise] -> выход. Переключается на лету.
function connectChainTail() {
  if (!chain) return;
  chain.compressor.disconnect();
  if (rnnoiseNode) rnnoiseNode.disconnect();

  if (settings.noise && rnnoiseNode) {
    chain.compressor.connect(rnnoiseNode);
    rnnoiseNode.connect(chain.dest);
  } else {
    chain.compressor.connect(chain.dest);
  }
}

// Ворклет грузится лениво при первом включении шумодава (это ~2 МБ wasm)
async function ensureRnnoiseNode() {
  if (rnnoiseNode) return rnnoiseNode;
  if (!rnnoiseLoadPromise) {
    rnnoiseLoadPromise = (async () => {
      await audioCtx.audioWorklet.addModule('/vendor/rnnoise-sync.js');
      await audioCtx.audioWorklet.addModule('/js/rnnoise-worklet.js');
      rnnoiseNode = new AudioWorkletNode(audioCtx, 'rnnoise');
      return rnnoiseNode;
    })().catch((err) => {
      console.error('Не удалось загрузить RNNoise:', err);
      rnnoiseLoadPromise = null;
      return null;
    });
  }
  return rnnoiseLoadPromise;
}

noiseToggle.checked = settings.noise;
noiseToggle.onchange = async () => {
  settings.noise = noiseToggle.checked;
  localStorage.setItem('crabenNoise', settings.noise ? '1' : '0');
  if (settings.noise) {
    noiseToggle.disabled = true;
    await ensureRnnoiseNode();
    noiseToggle.disabled = false;
  }
  connectChainTail();
};

// --- Выбор микрофона ---

async function populateMicList() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audioinput'
    );
    const current = settings.deviceId || (rawStream && rawStream.getAudioTracks()[0].getSettings().deviceId);
    micSelect.innerHTML = '';
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || 'Микрофон ' + (micSelect.length + 1);
      if (d.deviceId === current) opt.selected = true;
      micSelect.appendChild(opt);
    }
  } catch (err) {
    console.warn('Не удалось получить список микрофонов:', err);
  }
}

micSelect.onchange = () => {
  settings.deviceId = micSelect.value;
  localStorage.setItem('crabenDeviceId', settings.deviceId);
  initMic(settings.deviceId);
};

// --- Мьют и push-to-talk ---

// Единственное место, где решается, идёт ли голос в эфир
function applyMicGate() {
  if (!processedStream) return;
  const transmitting = !muted && (!settings.ptt || spaceHeld);
  processedStream.getAudioTracks().forEach((t) => (t.enabled = transmitting));
  muteBtn.textContent = settings.ptt
    ? spaceHeld
      ? '🎙️ Говоришь…'
      : '⌨️ Push-to-talk: пробел'
    : muted
      ? '🔇 Микрофон выкл.'
      : '🎙️ Микрофон вкл.';
  muteBtn.classList.toggle('muted', muted || (settings.ptt && !spaceHeld));
}

function setMuted(value) {
  muted = value;
  myState.muted = value;
  applyMicGate();
  updatePeerRow(socket && socket.id);
  sendState({ muted });
}

muteBtn.onclick = () => {
  if (!processedStream || settings.ptt) return;
  setMuted(!muted);
};

pttToggle.checked = settings.ptt;
pttToggle.onchange = () => {
  settings.ptt = pttToggle.checked;
  localStorage.setItem('crabenPtt', settings.ptt ? '1' : '0');
  if (settings.ptt) muted = false;
  applyMicGate();
  if (processedStream) statusOk();
};

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

document.addEventListener('keydown', (e) => {
  if (!settings.ptt || e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
  e.preventDefault();
  spaceHeld = true;
  applyMicGate();
});

document.addEventListener('keyup', (e) => {
  if (!settings.ptt || e.code !== 'Space') return;
  spaceHeld = false;
  applyMicGate();
});

// --- Состояние участников (мьют, речь) ---

function sendState(patch) {
  if (socket && socket.connected) socket.emit('state', patch);
}

function updatePeerRow(id) {
  const li = usersEl.querySelector('li[data-id="' + id + '"]');
  if (!li) return;
  const state = id === (socket && socket.id) ? myState : peerStates[id] || {};
  li.classList.toggle('speaking', !!state.speaking);
  const muteIcon = li.querySelector('.mute-icon');
  if (muteIcon) muteIcon.hidden = !state.muted;
}

// --- Индикатор речи: RMS по анализаторам с гистерезисом ---

const SPEAK_ON = 0.02;
const SPEAK_OFF_DELAY = 400; // мс тишины, прежде чем погасить индикатор
const rmsBuf = new Float32Array(512);
const speakState = {}; // ключ ('me' или id пира) -> { speaking, lastAbove }

function rmsOf(analyser) {
  analyser.getFloatTimeDomainData(rmsBuf);
  let sum = 0;
  for (let i = 0; i < rmsBuf.length; i++) sum += rmsBuf[i] * rmsBuf[i];
  return Math.sqrt(sum / rmsBuf.length);
}

setInterval(() => {
  if (!audioCtx) return;
  const now = performance.now();
  const entries = [['me', localAnalyser], ...Object.entries(remoteAnalysers)];

  for (const [key, analyser] of entries) {
    if (!analyser) continue;
    const st = speakState[key] || (speakState[key] = { speaking: false, lastAbove: 0 });
    if (rmsOf(analyser) > SPEAK_ON) st.lastAbove = now;
    const speaking = now - st.lastAbove < SPEAK_OFF_DELAY;

    if (speaking !== st.speaking) {
      st.speaking = speaking;
      if (key === 'me') {
        myState.speaking = speaking;
        if (socket) updatePeerRow(socket.id);
        sendState({ speaking });
      } else {
        (peerStates[key] || (peerStates[key] = {})).speaking = speaking;
        updatePeerRow(key);
      }
    }
  }
}, 120);

// --- Забираем у сервера актуальный список STUN/TURN-серверов ---

async function initIceConfig() {
  try {
    const res = await fetch('/ice-config');
    if (res.ok) RTC_CONFIG = await res.json();
  } catch (err) {
    console.warn('Не удалось получить /ice-config, используем только STUN:', err);
  }
}

// --- WebRTC mesh ---

// Просим у кодека 64 кбит/с — для голоса это с запасом, по умолчанию ~32
function tuneAudioSender(sender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = 64000;
    sender.setParameters(params).catch(() => {});
  } catch (err) {
    /* старые браузеры — пропускаем */
  }
}

function createPeer(id, isInitiator) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer = { pc, isInitiator, gain: null, analyser: null, source: null };
  peers[id] = peer;

  if (processedStream) {
    processedStream.getTracks().forEach((track) => {
      tuneAudioSender(pc.addTrack(track, processedStream));
    });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    attachRemoteAudio(id, e.streams[0]);
  };

  // Соединение умерло (смена сети, NAT) — инициатор перезапускает ICE
  pc.onconnectionstatechange = async () => {
    if (pc.connectionState !== 'failed' || !peer.isInitiator) return;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: id, data: { description: pc.localDescription } });
    } catch (err) {
      console.error('ICE restart не удался:', err);
    }
  };

  return pc;
}

// Голос собеседника идёт через Web Audio: GainNode позволяет крутить громкость
// выше 100% (в отличие от <audio>.volume), а анализатор кормит индикатор речи
function attachRemoteAudio(id, stream) {
  if (!audioCtx) return;
  detachRemoteAudio(id);

  const peer = peers[id];
  if (!peer) return;

  peer.source = audioCtx.createMediaStreamSource(stream);
  peer.gain = audioCtx.createGain();
  peer.gain.gain.value = volumes[id] ?? 1;
  peer.source.connect(peer.gain);
  peer.gain.connect(audioCtx.destination);

  peer.analyser = audioCtx.createAnalyser();
  peer.analyser.fftSize = 512;
  peer.source.connect(peer.analyser);
  peer.analyser.connect(analyserSink);
  remoteAnalysers[id] = peer.analyser;
}

function detachRemoteAudio(id) {
  const peer = peers[id];
  if (peer && peer.source) {
    peer.source.disconnect();
    if (peer.gain) peer.gain.disconnect();
    if (peer.analyser) peer.analyser.disconnect();
    peer.source = peer.gain = peer.analyser = null;
  }
  delete remoteAnalysers[id];
  delete speakState[id];
}

function removePeer(id) {
  if (peers[id]) {
    detachRemoteAudio(id);
    peers[id].pc.close();
    delete peers[id];
  }
  delete volumes[id];
  delete peerStates[id];
}

// --- Список участников ---

function setVolume(id, v) {
  volumes[id] = v;
  const peer = peers[id];
  if (peer && peer.gain) peer.gain.gain.value = v;
}

function renderRoster(list) {
  countEl.textContent = 'В комнате: ' + list.length;
  if (processedStream) statusOk();
  usersEl.innerHTML = '';

  for (const { id, name, muted: peerMuted } of list) {
    if (id !== socket.id && peerMuted !== undefined) {
      (peerStates[id] || (peerStates[id] = {})).muted = peerMuted;
    }
    const li = document.createElement('li');
    li.dataset.id = id;

    const icon = document.createElement('img');
    icon.src = '/crab.svg';
    icon.alt = '';
    icon.className = 'user-icon';
    li.appendChild(icon);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-name';
    nameSpan.textContent = name;
    li.appendChild(nameSpan);

    const muteIcon = document.createElement('span');
    muteIcon.className = 'mute-icon';
    muteIcon.textContent = '🔇';
    muteIcon.title = 'Микрофон выключен';
    li.appendChild(muteIcon);

    if (id === socket.id) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = 'это ты';
      li.appendChild(you);
    } else {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '200'; // до 200% — GainNode усиливает тихих собеседников
      slider.value = String(Math.round((volumes[id] ?? 1) * 100));
      slider.title = 'Громкость: ' + name;
      slider.oninput = () => setVolume(id, slider.value / 100);
      li.appendChild(slider);
    }

    usersEl.appendChild(li);
    updatePeerRow(id);
  }
}

// --- Сигналинг через socket.io ---

function connect() {
  socket = io({ auth: { name: myName } });

  // Сервер прислал список уже подключённых — мы новичок, сами звоним всем
  socket.on('peers', async (ids) => {
    await Promise.all([initMic(settings.deviceId || undefined), initIceConfig()]);
    for (const id of ids) {
      const pc = createPeer(id, true);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: id, data: { description: pc.localDescription } });
    }
    sendState({ muted });
  });

  socket.on('signal', async ({ from, data }) => {
    const pc = peers[from] ? peers[from].pc : createPeer(from, false);
    try {
      if (data.description) {
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (err) {
      console.error('Ошибка сигналинга:', err);
    }
  });

  socket.on('peer-left', (id) => {
    removePeer(id);
    // Строку участника уберёт ближайший roster, но состояние чистим сразу
  });

  socket.on('roster', renderRoster);

  socket.on('user-state', ({ id, ...patch }) => {
    Object.assign(peerStates[id] || (peerStates[id] = {}), patch);
    updatePeerRow(id);
  });

  socket.on('disconnect', () => {
    setStatus('Соединение с сервером потеряно, переподключаемся…', 'error');
    Object.keys(peers).forEach(removePeer);
  });

  socket.on('connect', () => {
    if (processedStream) statusOk();
  });
}
