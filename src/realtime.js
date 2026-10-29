// Socket.IO: presence, chat delivery, typing, WebRTC call signalling and
// per-user notification fan-out. Set REDIS_URL to run several instances.
const { Server } = require('socket.io');
const db = require('./db');
const { userFromToken } = require('./auth');
const { str, hit } = require('./lib');

const online = new Map(); // userId -> Set(socketId) on this instance
let io;

function attach(server) {
  io = new Server(server, {
    cors: { origin: false },
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25000,
    pingTimeout: 20000,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60000 },
  });
  if (process.env.REDIS_URL) {
    try {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const { createClient } = require('redis');
      const pub = createClient({ url: process.env.REDIS_URL });
      const sub = pub.duplicate();
      Promise.all([pub.connect(), sub.connect()]).then(() => {
        io.adapter(createAdapter(pub, sub));
        console.log('[noktura] Socket.IO using Redis adapter');
      }).catch(e => console.error('[noktura] Redis adapter failed, running single-instance:', e.message));
    } catch (e) { console.error('[noktura] REDIS_URL set but redis packages are missing:', e.message); }
  }

  io.use(async (socket, next) => {
    try { socket.user = await userFromToken(socket.handshake.auth?.token); next(); }
    catch (e) { next(new Error('Log in again.')); }
  });
  io.on('connection', onConnection);
  return io;
}

const isOnline = id => online.has(id);
const toUser = (userId, event, payload) => io && io.to('user:' + userId).emit(event, payload);
const broadcast = (event, payload) => io && io.emit(event, payload);
const toChat = (chatId, event, payload) => io && io.to('chat:' + chatId).emit(event, payload);
const joinUserToChat = (userId, chatId) => io && io.in('user:' + userId).socketsJoin('chat:' + chatId);

async function notify(userId, type, payload, client) {
  const n = { id: db.uid('n'), createdAt: Date.now() };
  await db.query('INSERT INTO notifications (id, user_id, type, payload, created_at) VALUES ($1,$2,$3,$4,$5)',
    [n.id, userId, type, JSON.stringify(payload), n.createdAt], client);
  toUser(userId, 'notification', { id: n.id, type, payload, at: n.createdAt, read: false });
}

const friendIds = async userId => (await db.all('SELECT friend_id FROM friends WHERE user_id = $1', [userId])).map(r => r.friend_id);
const isMember = (chatId, userId) => db.one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
const blockedBetween = (a, b) => db.one('SELECT 1 FROM blocks WHERE (user_id = $1 AND blocked_id = $2) OR (user_id = $2 AND blocked_id = $1)', [a, b]);
const safely = fn => async (...args) => { try { await fn(...args); } catch (e) { console.error('[socket]', e.message); } };

// Stores and fans out one chat message. Used by sockets and by the REST
// endpoints that post system lines (money sent in chat, event updates).
async function postMessage({ chatId, user, text, kind = 'text', meta = {} }) {
  const m = { id: db.uid('m'), chatId, from: user ? user.handle : 'system', text, kind, meta, at: Date.now() };
  await db.query('INSERT INTO messages (id, chat_id, from_user, user_id, text, kind, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [m.id, chatId, m.from, user ? user.id : null, text, kind, JSON.stringify(meta), m.at]);
  if (user) await db.query('UPDATE chat_members SET last_read_at = $3 WHERE chat_id = $1 AND user_id = $2', [chatId, user.id, m.at]);
  io.to('chat:' + chatId).emit('new_message', m);
  return m;
}

async function onConnection(socket) {
  const user = socket.user;
  if (!online.has(user.id)) online.set(user.id, new Set());
  online.get(user.id).add(socket.id);
  socket.join('user:' + user.id);
  try {
    const chats = await db.all('SELECT chat_id FROM chat_members WHERE user_id = $1', [user.id]);
    chats.forEach(c => socket.join('chat:' + c.chat_id));
    for (const id of await friendIds(user.id)) toUser(id, 'presence', { handle: user.handle, online: true });
  } catch (e) { console.error('[socket] join failed', e.message); }

  const flood = () => !hit('sock:' + user.id, 20, 10000);

  socket.on('send_message', safely(async ({ chatId, text, clientId } = {}, ack) => {
    text = str(text, 4000);
    if (!chatId || !text) return;
    if (flood()) return socket.emit('error_message', { error: 'You are sending messages too fast.' });
    if (!(await isMember(chatId, user.id))) return socket.emit('error_message', { error: 'You are not in this conversation.' });
    const chat = await db.one('SELECT type FROM chats WHERE id = $1', [chatId]);
    let others = [];
    if (chat.type === 'dm') {
      others = await db.all('SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2', [chatId, user.id]);
      if (others[0] && (await blockedBetween(user.id, others[0].user_id))) return socket.emit('error_message', { error: 'You can’t message this person.' });
    }
    const m = await postMessage({ chatId, user, text, meta: clientId ? { clientId: str(clientId, 40) } : {} });
    if (typeof ack === 'function') ack({ id: m.id });
    for (const o of others) await notify(o.user_id, 'message', { chatId, from: user.handle, preview: text.slice(0, 80) });
  }));
  socket.on('typing', safely(async ({ chatId } = {}) => {
    if (chatId && socket.rooms.has('chat:' + chatId) && hit('typ:' + user.id, 30, 10000)) socket.to('chat:' + chatId).emit('typing', { chatId, from: user.handle });
  }));
  socket.on('join_chat', safely(async ({ chatId } = {}) => {
    if (chatId && (await isMember(chatId, user.id))) socket.join('chat:' + chatId);
  }));

  // WebRTC signalling — the server only relays SDP/ICE between chat members.
  const relayToChat = event => safely(async (data = {}) => {
    if (!data.chatId || flood() || !(await isMember(data.chatId, user.id))) return;
    const payload = { chatId: data.chatId, from: user.handle, video: !!data.video };
    if (data.signal && JSON.stringify(data.signal).length < 20000) payload.signal = data.signal;
    socket.to('chat:' + data.chatId).emit(event, payload);
  });
  socket.on('call_invite', relayToChat('call_invite'));
  socket.on('call_signal', relayToChat('call_signal'));
  socket.on('call_end', relayToChat('call_end'));
  socket.on('call_accept', relayToChat('call_accept'));
  socket.on('call_reject', relayToChat('call_reject'));

  socket.on('disconnect', safely(async () => {
    const set = online.get(user.id);
    if (set) { set.delete(socket.id); if (!set.size) online.delete(user.id); }
    if (!isOnline(user.id)) for (const id of await friendIds(user.id)) toUser(id, 'presence', { handle: user.handle, online: false });
  }));
}

module.exports = { attach, notify, toUser, toChat, broadcast, joinUserToChat, postMessage, isOnline, friendIds, isMember, blockedBetween, onlineCount: () => online.size };
