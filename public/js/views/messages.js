import { state, api, qs, esc, icon, ago, fTime, linkify, safeUrl, avatar, go, fail, toast, modal, modalHead, busy, upload, pickFile, confirmBox, nkt, newKey, plural, on, emit, socket, CFG, $, $$, h } from '../core.js';
import { reportModal, moreMenu, needLogin } from './shared.js';

export async function messagesView(el, { id }) {
  if (!state.user) return needLogin('chat');
  let chats = [], active = id || null, messages = [], typingT;
  el.innerHTML = `<div class="msg ${active ? 'open' : ''}" id="msg">
    <aside class="inbox"><div class="inbox-h"><div><div class="kicker" style="margin-bottom:8px">Messages</div><div class="h-3">Inbox</div></div><button class="btn sm" id="newChat">${icon('plus')}New</button></div>
      <div style="padding:12px 20px;border-bottom:1px solid var(--line)"><input class="input" id="cf" placeholder="Search conversations" style="height:40px"></div>
      <div class="inbox-l" id="il"></div></aside>
    <section class="thread" id="th"></section></div>`;

  async function loadChats() {
    try { chats = (await api('/api/chats')).chats; drawInbox(); } catch (e) { fail(e); }
    state.unread.messages = chats.filter(c => !c.muted).reduce((s, c) => s + (c.id === active ? 0 : c.unread), 0); emit('unread');
  }
  function drawInbox() {
    const term = ($('#cf', el).value || '').toLowerCase();
    const list = chats.filter(c => !term || (c.name || '').toLowerCase().includes(term));
    $('#il', el).innerHTML = list.length ? list.map(c => `<div class="ci ${c.id === active ? 'on' : ''}" data-id="${esc(c.id)}">
      <span class="${c.online ? 'online' : ''}">${c.type === 'dm' ? avatar(c, 'md') : `<span class="av md inv">${c.type === 'event' ? icon('ticket', 'style="width:18px;height:18px"') : esc((c.name || '#')[0])}</span>`}</span>
      <div class="t"><b>${esc(c.name || 'Group')}</b><span>${c.lastMessage ? (c.lastMessage.from === state.user.handle ? 'You: ' : c.type !== 'dm' && c.lastMessage.from !== 'system' ? '@' + esc(c.lastMessage.from) + ': ' : '') + esc(c.lastMessage.text) : c.type === 'event' ? 'Event chat' : plural(c.memberCount, 'member')}</span></div>
      <div class="meta">${c.lastMessage ? ago(c.lastMessage.at) : ''}${c.unread && c.id !== active ? `<span class="unread">${c.unread}</span>` : ''}</div></div>`).join('')
      : `<div class="empty" style="padding:40px 20px">No conversations yet.<br><br><button class="btn sm" id="nc2">Start one</button></div>`;
    $$('[data-id]', $('#il', el)).forEach(d => (d.onclick = () => go('/messages/' + d.dataset.id)));
    const nc2 = $('#nc2', el); if (nc2) nc2.onclick = newChat;
  }
  $('#cf', el).oninput = drawInbox;
  $('#newChat', el).onclick = newChat;

  async function openThread() {
    const th = $('#th', el);
    if (!active) { th.innerHTML = `<div class="empty" style="margin:auto"><div class="h-3">Pick a conversation</div><p>Plans, tickets and who owes who — all in one thread.</p></div>`; return; }
    th.innerHTML = '<div class="empty" style="margin:auto">Loading…</div>';
    let info;
    try { [info, { messages }] = await Promise.all([api('/api/chats/' + active), api(`/api/chats/${active}/messages`)]); }
    catch (e) { th.innerHTML = `<div class="empty" style="margin:auto">${esc(e.message)}</div>`; return; }
    const chat = info.chat;
    const others = info.members.filter(m => m.handle !== state.user.handle);
    const dm = chat.type === 'dm';
    th.innerHTML = `<div class="thread-h">
        <button class="icon-btn" id="bk" aria-label="Back">${icon('back')}</button>
        ${dm ? `<a href="#/u/${esc(chat.handle)}">${avatar(others[0] || {}, 'md')}</a>` : `<span class="av md inv">${esc((chat.name || '#')[0])}</span>`}
        <div class="t"><b>${esc(chat.name)}</b><span id="sub">${dm ? (others[0]?.online ? 'Online' : 'Offline') : plural(info.members.length, 'member')}</span></div>
        ${dm ? `<button class="icon-btn" id="call" aria-label="Voice call">${icon('phone')}</button><button class="icon-btn" id="vcall" aria-label="Video call">${icon('video')}</button>` : ''}
        <button class="icon-btn" id="pay" aria-label="Send money">${icon('glass')}</button>
        <button class="icon-btn" id="more" aria-label="More">${icon('more')}</button>
      </div>
      <div class="thread-l" id="tl"></div>
      <div class="typing" id="typing"></div>
      <form class="composer" id="cmp"><button type="button" class="icon-btn" id="att" aria-label="Attach">${icon('paperclip')}</button><textarea id="txt" rows="1" placeholder="Message" maxlength="4000"></textarea><button class="icon-btn send" aria-label="Send">${icon('send')}</button></form>`;
    $('#bk', th).onclick = () => go('/messages');
    drawMessages(true);
    const txt = $('#txt', th);
    txt.oninput = () => { txt.style.height = 'auto'; txt.style.height = Math.min(160, txt.scrollHeight) + 'px'; socket?.emit('typing', { chatId: active }); };
    txt.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#cmp', th).requestSubmit(); } };
    if (matchMedia('(pointer:fine)').matches) txt.focus();
    $('#cmp', th).onsubmit = async e => {
      e.preventDefault();
      const text = txt.value.trim();
      if (!text) return;
      txt.value = ''; txt.style.height = 'auto';
      send(text);
    };
    $('#att', th).onclick = async () => {
      const f = await pickFile('image/*,application/pdf,video/mp4,audio/*');
      if (!f) return;
      try { const r = await upload(f, 'chat', active); send((/^image\//.test(r.contentType) ? '[image] ' : '[file] ') + location.origin + r.url + (/^image\//.test(r.contentType) ? '' : ' ' + f.name)); }
      catch (err) { fail(err); }
    };
    $('#pay', th).onclick = () => payInChat(chat, others);
    if (dm) { $('#call', th).onclick = () => startCall(active, chat.name, false); $('#vcall', th).onclick = () => startCall(active, chat.name, true); }
    $('#more', th).onclick = ev => moreMenu(ev.currentTarget, [
      { icon: 'bell', label: chat.muted ? 'Unmute' : 'Mute', fn: async () => { await api(`/api/chats/${active}/mute`, { method: 'POST', body: { muted: !chat.muted } }).catch(fail); chat.muted = !chat.muted; toast(chat.muted ? 'Muted.' : 'Unmuted.'); } },
      ...(!dm ? [{ icon: 'plus', label: 'Add people', fn: () => addPeople() }, { icon: 'logout', label: 'Leave chat', fn: async () => { if (await confirmBox('Leave this chat?', 'You’ll stop getting its messages.', 'Leave')) { await api(`/api/chats/${active}/leave`, { method: 'POST' }).catch(fail); go('/messages'); loadChats(); } } }] : []),
      ...(dm && chat.handle ? [{ icon: 'x', label: 'Block @' + chat.handle, fn: async () => { if (await confirmBox('Block @' + chat.handle + '?', 'They won’t be able to message or pay you, and won’t see your pins.', 'Block')) { await api('/api/blocks/' + chat.handle, { method: 'POST' }).catch(fail); toast('Blocked.'); } } },
        { icon: 'flag', label: 'Report @' + chat.handle, fn: () => reportModal('user', chat.handle) }] : []),
    ]);
    api(`/api/chats/${active}/read`, { method: 'POST' }).catch(() => {});
    const c = chats.find(x => x.id === active); if (c) { c.unread = 0; drawInbox(); }
  }

  function bubble(m) {
    if (m.kind === 'system') return `<div class="sysmsg">${esc(m.text)}</div>`;
    const me = m.from === state.user.handle;
    const time = fTime(m.at);
    if (m.kind === 'deleted') return `<div class="bubble deleted ${me ? 'me' : ''}" style="${me ? 'align-self:flex-end' : ''}">Message deleted</div>`;
    if (m.kind === 'payment') return `<div class="bubble pay" style="align-self:${me ? 'flex-end' : 'flex-start'}"><span class="kicker">${me ? 'You sent' : '@' + esc(m.from) + ' sent'}${m.meta?.to && !me && m.meta.to !== state.user.handle ? ' @' + esc(m.meta.to) : ''}</span><span class="amt">${nkt(m.meta?.amount)} NKT</span>${m.meta?.note ? `<span style="font-size:14px">${esc(m.meta.note)}</span>` : ''}<span class="at">${time}</span></div>`;
    let body = linkify(m.text);
    const img = /^\[image\] (\S+)/.exec(m.text);
    if (img && img[1].startsWith(location.origin + '/api/uploads/')) body = `<a href="${safeUrl(img[1])}" target="_blank"><img src="${safeUrl(img[1].replace(location.origin, ''))}" alt="Image" loading="lazy"></a>`;
    return `<div class="bubble ${me ? 'me' : ''}" data-mid="${esc(m.id)}">${!me ? `<span class="who">@${esc(m.from)}</span>` : ''}${body}<span class="at">${time}</span></div>`;
  }
  function drawMessages(scroll) {
    const tl = $('#tl', el);
    if (!tl) return;
    const near = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 120;
    tl.innerHTML = messages.length ? messages.map(bubble).join('') : '<div class="sysmsg" style="margin:auto">Say hello</div>';
    $$('.bubble.me[data-mid]', tl).forEach(b => (b.oncontextmenu = ev => { ev.preventDefault(); delMsg(b.dataset.mid); }));
    if (scroll || near) tl.scrollTop = tl.scrollHeight;
  }
  async function delMsg(mid) {
    if (!(await confirmBox('Delete message?', 'It will be removed for everyone in this chat.', 'Delete'))) return;
    try { await api(`/api/chats/${active}/messages/${mid}`, { method: 'DELETE' }); } catch (e) { fail(e); }
  }
  function send(text) {
    const clientId = newKey();
    if (socket?.connected) socket.emit('send_message', { chatId: active, text, clientId });
    else api(`/api/chats/${active}/messages`, { method: 'POST', body: { text } }).then(r => { messages.push(r.message); drawMessages(true); }).catch(fail);
  }

  function payInChat(chat, others) {
    const dm = chat.type === 'dm';
    const key = newKey();
    const m = modal(`${modalHead(dm ? 'Send to ' + chat.name : 'Send in ' + chat.name, 'Buy a round')}
      <form class="modal-b" id="pf">${dm ? '' : `<label class="field"><span>To</span><select class="select" name="toHandle">${others.map(o => `<option value="${esc(o.handle)}">@${esc(o.handle)}</option>`).join('')}</select></label>`}
        <div class="amount-input"><input name="amount" inputmode="decimal" placeholder="0.00"><span>NKT</span></div>
        <div class="chips" style="margin:-8px 0 20px">${[['Drink', 5], ['Round', 20], ['Taxi', 10], ['Ticket', 15]].map(([l, v]) => `<button type="button" class="chip" data-v="${v}" data-n="${l}">${l} · ${v}</button>`).join('')}</div>
        <label class="field"><span>Note</span><input class="input" name="note" maxlength="140" placeholder="This one’s on me"></label></form>
      <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="go">${icon('send')}Send</button></div>`);
    const f = $('#pf', m.el);
    $$('[data-v]', f).forEach(b => (b.onclick = () => { f.amount.value = b.dataset.v; if (!f.note.value) f.note.value = b.dataset.n === 'Round' ? 'This round’s on me' : b.dataset.n; }));
    $('#go', m.el).onclick = ev => busy(ev.currentTarget, async () => {
      try {
        const r = await api(`/api/chats/${active}/pay`, { method: 'POST', body: { amount: f.amount.value, note: f.note.value, toHandle: f.toHandle?.value }, idem: key });
        state.user.balance = r.balance; m.close();
      } catch (err) {
        if (err.code === 'insufficient_funds') toast(err.message, 'err', { label: 'Top up', fn: () => { m.close(); go('/wallet?topup=1'); } });
        else fail(err);
      }
    });
  }
  function addPeople() {
    const m = modal(`${modalHead('Add people')}<form class="modal-b" id="ap"><label class="field"><span>Handle</span><input class="input" name="h" placeholder="@handle" required></label></form><div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="go">Add</button></div>`);
    $('#go', m.el).onclick = ev => busy(ev.currentTarget, async () => { try { await api(`/api/chats/${active}/members`, { method: 'POST', body: { handle: $('#ap', m.el).h.value } }); m.close(); } catch (e) { fail(e); } });
  }

  await loadChats();
  await openThread();
  const offs = [
    on('rt:new_message', m => {
      if (m.chatId === active) {
        messages.push(m); drawMessages(m.from === state.user.handle);
        $('#typing', el) && ($('#typing', el).textContent = '');
        if (m.from !== state.user.handle) api(`/api/chats/${active}/read`, { method: 'POST' }).catch(() => {});
      }
      const c = chats.find(x => x.id === m.chatId);
      if (c) { c.lastMessage = { from: m.from, text: m.kind === 'payment' ? 'Payment' : m.text, at: m.at }; if (m.chatId !== active && m.from !== state.user.handle) c.unread++; chats = [c, ...chats.filter(x => x !== c)]; drawInbox(); }
      else loadChats();
    }),
    on('rt:message_deleted', d => { if (d.chatId === active) { const m = messages.find(x => x.id === d.id); if (m) { m.kind = 'deleted'; m.text = ''; drawMessages(); } } }),
    on('rt:typing', d => { if (d.chatId === active && d.from !== state.user.handle) { const t = $('#typing', el); if (t) { t.textContent = '@' + d.from + ' is typing…'; clearTimeout(typingT); typingT = setTimeout(() => { t.textContent = ''; }, 3000); } } }),
    on('rt:chat_created', loadChats),
    on('rt:presence', loadChats),
    on('rt:error_message', d => toast(d.error, 'err')),
  ];
  return () => offs.forEach(f => f());
}

async function newChat() {
  const picked = new Map();
  const m = modal(`${modalHead('New conversation')}
    <div class="modal-b"><div class="search" style="border:1px solid var(--line-2);height:48px;padding:0 14px">${icon('search')}<input id="uq" placeholder="Search people by handle" autocomplete="off"></div>
      <div class="chips" id="sel" style="margin-top:12px"></div>
      <label class="field" id="gname" hidden style="margin-top:16px"><span>Group name</span><input class="input" name="name" maxlength="60" placeholder="Friday crew"></label>
      <div class="city-list" id="ur"></div></div>
    <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="start" disabled>Start</button></div>`);
  const drawSel = () => {
    $('#sel', m.el).innerHTML = [...picked.keys()].map(hd => `<button class="chip on" data-rm="${esc(hd)}">@${esc(hd)} ×</button>`).join('');
    $$('[data-rm]', m.el).forEach(b => (b.onclick = () => { picked.delete(b.dataset.rm); drawSel(); }));
    $('#gname', m.el).hidden = picked.size < 2;
    $('#start', m.el).disabled = !picked.size;
  };
  const showFriends = async () => {
    try {
      const { friends } = await api('/api/friends');
      draw(friends, 'Friends');
    } catch { /* ignore */ }
  };
  const draw = (users, title) => {
    $('#ur', m.el).innerHTML = (title ? `<div class="kicker" style="padding:12px 0">${esc(title)}</div>` : '') + (users.map(u => `<button data-h="${esc(u.handle)}">@${esc(u.handle)}<span>${esc(u.city || '')}${u.online ? ' · online' : ''}</span></button>`).join('') || '<div class="empty">No one found.</div>');
    $$('[data-h]', m.el).forEach(b => (b.onclick = () => { picked.set(b.dataset.h, true); drawSel(); }));
  };
  let t;
  $('#uq', m.el).oninput = e => {
    clearTimeout(t);
    const q = e.target.value.trim();
    if (!q) return showFriends();
    t = setTimeout(async () => { try { draw((await api('/api/users/search?' + qs({ q }))).users); } catch (err) { fail(err); } }, 250);
  };
  showFriends();
  $('#start', m.el).onclick = ev => busy(ev.currentTarget, async () => {
    try {
      const members = [...picked.keys()];
      const r = await api('/api/chats', { method: 'POST', body: { members, type: members.length > 1 ? 'group' : 'dm', name: m.el.querySelector('[name=name]').value } });
      m.close(); go('/messages/' + r.chatId);
    } catch (e) { fail(e); }
  });
}

// ── calls (WebRTC, signalled over the socket) ─────────────────
let call = null;
const ice = () => ({ iceServers: CFG.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] });
function callUi(name, status, video) {
  document.querySelector('.call')?.remove();
  const ui = h(`<div class="call" role="dialog" aria-label="Call"><video class="remote" autoplay playsinline ${video ? '' : 'hidden'}></video><video class="self" autoplay playsinline muted ${video ? '' : 'hidden'}></video>
    <div class="who"><div class="kicker" style="color:#aaa;margin-bottom:12px" id="cs">${esc(status)}</div><div class="h-1">${esc(name)}</div></div>
    <div class="ctl" id="ctl"></div><audio autoplay></audio></div>`);
  document.body.appendChild(ui);
  return ui;
}
function endCall(notify = true) {
  if (!call) return;
  if (notify) socket?.emit('call_end', { chatId: call.chatId });
  call.pc?.close();
  call.stream?.getTracks().forEach(t => t.stop());
  document.querySelector('.call')?.remove();
  call = null;
}
async function media(video) {
  try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 1280, height: 720 } : false }); }
  catch { toast('Allow microphone' + (video ? ' and camera' : '') + ' access to call.', 'err'); return null; }
}
function makePc(chatId, ui) {
  const pc = new RTCPeerConnection(ice());
  pc.onicecandidate = e => e.candidate && socket?.emit('call_signal', { chatId, signal: { candidate: e.candidate } });
  pc.ontrack = e => {
    const [s] = e.streams;
    ui.querySelector('audio').srcObject = s;
    const rv = ui.querySelector('video.remote');
    rv.srcObject = s;
    if (s.getVideoTracks().length) rv.hidden = false;
    ui.querySelector('#cs').textContent = 'Connected';
  };
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) endCall(false); };
  return pc;
}
function controls(ui) {
  const ctl = ui.querySelector('#ctl');
  ctl.innerHTML = `<button class="btn" id="mute">${icon('mic')}Mute</button><button class="btn" id="cam">${icon('video')}Camera</button><button class="btn on" id="hang">End</button>`;
  ctl.querySelector('#hang').onclick = () => endCall(true);
  ctl.querySelector('#mute').onclick = e => { const t = call?.stream?.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; e.currentTarget.classList.toggle('on', !t.enabled); } };
  ctl.querySelector('#cam').onclick = async e => {
    if (!call) return;
    let t = call.stream.getVideoTracks()[0];
    if (!t) {
      const v = await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null);
      if (!v) return toast('Camera unavailable.', 'err');
      t = v.getVideoTracks()[0]; call.stream.addTrack(t); call.pc.addTrack(t, call.stream);
      const sv = ui.querySelector('video.self'); sv.srcObject = call.stream; sv.hidden = false;
      const offer = await call.pc.createOffer(); await call.pc.setLocalDescription(offer);
      socket?.emit('call_signal', { chatId: call.chatId, signal: { sdp: call.pc.localDescription } });
    } else { t.enabled = !t.enabled; e.currentTarget.classList.toggle('on', !t.enabled); }
  };
}
export async function startCall(chatId, name, video) {
  if (call) return;
  if (!socket?.connected) return toast('Connecting… try again in a second.', 'err');
  const stream = await media(video);
  if (!stream) return;
  const ui = callUi(name, 'Calling…', video);
  ui.querySelector('video.self').srcObject = stream;
  call = { chatId, stream, pc: null, ui, outgoing: true, video };
  controls(ui);
  socket.emit('call_invite', { chatId, video });
  call.timeout = setTimeout(() => { if (call && !call.pc) { toast('No answer.'); endCall(true); } }, 45000);
}
export function startCallListeners() {
  on('rt:call_invite', async d => {
    if (call || d.from === state.user?.handle) { socket?.emit('call_reject', { chatId: d.chatId }); return; }
    const ui = callUi('@' + d.from, d.video ? 'Incoming video call' : 'Incoming call', false);
    ui.querySelector('#ctl').innerHTML = `<button class="btn" id="dec">Decline</button><button class="btn on" id="acc">${icon('phone')}Answer</button>`;
    call = { chatId: d.chatId, ui, incoming: true };
    ui.querySelector('#dec').onclick = () => { socket?.emit('call_reject', { chatId: d.chatId }); ui.remove(); call = null; };
    ui.querySelector('#acc').onclick = async () => {
      const stream = await media(d.video);
      if (!stream) return;
      call.stream = stream;
      call.pc = makePc(d.chatId, ui);
      stream.getTracks().forEach(t => call.pc.addTrack(t, stream));
      if (d.video) { const sv = ui.querySelector('video.self'); sv.srcObject = stream; sv.hidden = false; }
      controls(ui);
      ui.querySelector('#cs').textContent = 'Connecting…';
      socket.emit('call_accept', { chatId: d.chatId });
    };
  });
  on('rt:call_accept', async d => {
    if (!call?.outgoing || call.chatId !== d.chatId || call.pc) return;
    clearTimeout(call.timeout);
    call.pc = makePc(d.chatId, call.ui);
    call.stream.getTracks().forEach(t => call.pc.addTrack(t, call.stream));
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    socket.emit('call_signal', { chatId: d.chatId, signal: { sdp: call.pc.localDescription } });
    call.ui.querySelector('#cs').textContent = 'Connecting…';
  });
  on('rt:call_signal', async d => {
    if (!call?.pc || call.chatId !== d.chatId || !d.signal) return;
    try {
      if (d.signal.sdp) {
        await call.pc.setRemoteDescription(d.signal.sdp);
        if (d.signal.sdp.type === 'offer') {
          const ans = await call.pc.createAnswer();
          await call.pc.setLocalDescription(ans);
          socket.emit('call_signal', { chatId: d.chatId, signal: { sdp: call.pc.localDescription } });
        }
      } else if (d.signal.candidate) await call.pc.addIceCandidate(d.signal.candidate);
    } catch (e) { console.warn('[call]', e); }
  });
  on('rt:call_reject', d => { if (call?.chatId === d.chatId && call.outgoing) { toast('Call declined.'); endCall(false); } });
  on('rt:call_end', d => { if (call?.chatId === d.chatId) endCall(false); });
}
