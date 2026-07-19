const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const muteBtn = document.getElementById('mute');
const audiosEl = document.getElementById('audios');
const usersEl = document.getElementById('users');
const nameModal = document.getElementById('name-modal');
const nameForm = document.getElementById('name-form');
const nameInput = document.getElementById('name-input');

let socket = null;
let myName = localStorage.getItem('crabenName') || '';

// id пира -> RTCPeerConnection
const peers = {};
// id пира -> громкость 0..1
const volumes = {};
let localStream = null;
let muted = false;

// Запасной вариант, если /ice-config недоступен
let RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
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

// --- Микрофон ---

async function initMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    setStatus('Ты в голосовом чате', 'ok');
    muteBtn.disabled = false;
  } catch (err) {
    setStatus('Нужен доступ к микрофону. Разреши и обнови страницу.', 'error');
  }
}

muteBtn.onclick = () => {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  muteBtn.textContent = muted ? '🔇 Микрофон выкл.' : '🎙️ Микрофон вкл.';
  muteBtn.classList.toggle('muted', muted);
};

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

function createPeer(id) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers[id] = pc;

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    let audio = document.getElementById('audio-' + id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + id;
      audio.autoplay = true;
      audiosEl.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.volume = volumes[id] ?? 1;
  };

  return pc;
}

function removePeer(id) {
  if (peers[id]) {
    peers[id].close();
    delete peers[id];
  }
  delete volumes[id];
  const audio = document.getElementById('audio-' + id);
  if (audio) audio.remove();
}

// --- Список участников ---

function setVolume(id, v) {
  volumes[id] = v;
  const audio = document.getElementById('audio-' + id);
  if (audio) audio.volume = v;
}

function renderRoster(list) {
  countEl.textContent = 'В комнате: ' + list.length;
  if (localStream) setStatus('Ты в голосовом чате', 'ok');
  usersEl.innerHTML = '';

  for (const { id, name } of list) {
    const li = document.createElement('li');

    const icon = document.createElement('img');
    icon.src = '/crab.svg';
    icon.alt = '';
    icon.className = 'user-icon';
    li.appendChild(icon);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-name';
    nameSpan.textContent = name;
    li.appendChild(nameSpan);

    if (id === socket.id) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = 'это ты';
      li.appendChild(you);
    } else {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(Math.round((volumes[id] ?? 1) * 100));
      slider.title = 'Громкость: ' + name;
      slider.oninput = () => setVolume(id, slider.value / 100);
      li.appendChild(slider);
    }

    usersEl.appendChild(li);
  }
}

// --- Сигналинг через socket.io ---

function connect() {
  socket = io({ auth: { name: myName } });

  // Сервер прислал список уже подключённых — мы новичок, сами звоним всем
  socket.on('peers', async (ids) => {
    await Promise.all([initMic(), initIceConfig()]);
    for (const id of ids) {
      const pc = createPeer(id);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: id, data: { description: pc.localDescription } });
    }
  });

  socket.on('signal', async ({ from, data }) => {
    const pc = peers[from] || createPeer(from);
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

  socket.on('peer-left', removePeer);

  socket.on('roster', renderRoster);

  socket.on('disconnect', () => {
    setStatus('Соединение с сервером потеряно, переподключаемся…', 'error');
    Object.keys(peers).forEach(removePeer);
  });

  socket.on('connect', () => {
    if (localStream) setStatus('Ты в голосовом чате', 'ok');
  });
}
