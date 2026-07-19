const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3737;

app.use(express.static('public'));

// Собираем iceServers для клиента: STUN всегда, TURN — если настроен через env.
// TURN_SECRET — режим coturn use-auth-secret: выдаём временные креды (сутки),
// постоянный секрет в браузер не попадает. Иначе можно задать TURN_USER/TURN_PASS.
function buildIceServers() {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const turnUrls = (process.env.TURN_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (turnUrls.length > 0) {
    const turn = { urls: turnUrls };
    if (process.env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 86400}:craben`;
      turn.username = username;
      turn.credential = crypto
        .createHmac('sha1', process.env.TURN_SECRET)
        .update(username)
        .digest('base64');
    } else if (process.env.TURN_USER && process.env.TURN_PASS) {
      turn.username = process.env.TURN_USER;
      turn.credential = process.env.TURN_PASS;
    }
    iceServers.push(turn);
  }
  return iceServers;
}

app.get('/ice-config', (req, res) => {
  res.json({ iceServers: buildIceServers() });
});

const names = new Map(); // socket.id -> имя краба

function sendRoster() {
  io.emit('roster', [...names.entries()].map(([id, name]) => ({ id, name })));
}

io.on('connection', (socket) => {
  const name = String(socket.handshake.auth.name || '').trim().slice(0, 24) || 'Краб';
  names.set(socket.id, name);

  // Отправляем новичку список уже подключённых — он им всем позвонит сам
  const others = [...io.sockets.sockets.keys()].filter((id) => id !== socket.id);
  socket.emit('peers', others);

  // Пересылаем WebRTC-сигналы (offer/answer/ice) между двумя браузерами
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    names.delete(socket.id);
    socket.broadcast.emit('peer-left', socket.id);
    sendRoster();
  });

  sendRoster();
});

server.listen(PORT, () => {
  console.log(`CrabenVoice запущен: http://localhost:${PORT}`);
});
