import { state, api, qs, esc, icon, ago, fDay, fTime, avatar, go, fail, toast, modal, modalHead, busy, upload, pickFile, confirmBox, setTheme, setSession, signOut, formData, safeUrl, VERIFIED, $, $$ } from '../core.js';
import { eventCard } from './events.js';
import { sendModal, reportModal, moreMenu, needLogin } from './shared.js';

export async function profileView(el, { handle }) {
  let p;
  try { p = await api('/api/users/' + encodeURIComponent(handle)); }
  catch (e) { el.innerHTML = `<div class="wrap empty"><div class="h-2">No one here</div><p>${esc(e.message)}</p></div>`; return; }
  const u = p.user, rel = p.relation, me = u.me;
  let events = { going: [], hosting: [] };
  if (me) events = await api('/api/events/mine').catch(() => events);
  const posts = await api('/api/posts?' + qs({ scope: 'user', handle: u.handle, limit: 10 })).then(r => r.posts).catch(() => []);

  el.innerHTML = `<div class="wrap">
    <div class="prof">${avatar(u, 'lg')}
      <div class="meta"><div class="kicker" style="margin-bottom:12px">@${esc(u.handle)}${u.city ? ' · ' + esc(u.city) : ''}${u.official ? ' · Official' : ''}</div>
        <h1 class="h-1" style="display:flex;align-items:center;gap:12px">${esc(u.displayName || u.handle)}${u.verified ? VERIFIED.replace('class="verified"', 'class="verified" style="width:22px;height:22px"') : ''}</h1>
        ${u.bio ? `<p class="lead" style="margin-top:12px;max-width:560px">${esc(u.bio)}</p>` : ''}
        <div class="stats"><div><b class="num">${p.counts.friends}</b>Friends</div><div><b class="num">${p.counts.events}</b>Events</div><div><b class="num">${p.counts.posts}</b>Posts</div></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${me ? `<a class="btn" href="#/settings">${icon('settings')}Settings</a><a class="btn ghost" href="#/friends">${icon('users')}Friends</a>`
        : `<button class="btn ${rel?.friends ? 'on' : rel?.following ? 'ghost' : 'solid'}" id="fr">${rel?.friends ? 'Friends' : rel?.following ? 'Requested' : rel?.followsMe ? 'Accept' : 'Add friend'}</button>
           <button class="btn ghost" id="dm">${icon('chat')}Message</button><button class="btn ghost" id="pay">${icon('glass')}Send</button><button class="icon-btn" id="more" aria-label="More">${icon('more')}</button>`}</div>
    </div>
    ${me && events.going.length ? `<div class="sec"><div class="sec-h"><div class="h-3">You’re going</div></div><div class="grid-feature" style="grid-template-columns:repeat(4,1fr)">${events.going.slice(0, 8).map(e => eventCard(e)).join('')}</div></div>` : ''}
    ${me && events.hosting.length ? `<div class="sec" style="padding-top:0"><div class="sec-h"><div class="h-3">Hosting</div><a class="link" href="#/scan">Door${icon('arrow')}</a></div>${events.hosting.map(e => `<a class="arow" href="#/e/${esc(e.id)}" style="grid-template-columns:120px 1fr auto"><span class="t">${esc(fDay(e.startsAt, e.tz))}</span><span><span class="ti">${esc(e.title)}</span><span class="sub"><span>${esc(e.status)}</span><span>${e.going} going</span></span></span><span class="price">${esc(e.priceText)}</span></a>`).join('')}</div>` : ''}
    <div class="sec" style="padding-top:${me && (events.going.length || events.hosting.length) ? 0 : 40}px"><div class="sec-h"><div class="h-3">Posts</div></div>
      <div class="feed" style="max-width:none">${posts.length ? posts.map(x => `<div class="post"><div class="kicker" style="margin-bottom:10px">${ago(x.at)}${x.city ? ' · ' + esc(x.city) : ''}</div>${x.headline ? `<div class="headline">${esc(x.headline)}</div>` : ''}<div class="body">${esc(x.text)}</div>${x.image ? `<div class="pimg"><img src="${safeUrl(x.image)}" alt="" loading="lazy"></div>` : ''}</div>`).join('') : '<div class="empty">No posts yet.</div>'}</div></div>
  </div>`;

  if (!me) {
    const need = () => (state.user ? true : (needLogin('friends'), false));
    $('#fr', el).onclick = ev => need() && busy(ev.currentTarget, async () => {
      try {
        if (rel?.following) { if (await confirmBox(rel.friends ? 'Remove friend?' : 'Cancel request?', `@${u.handle} won’t see your friends-only pins and posts.`, 'Remove')) await api('/api/friends/' + u.handle, { method: 'DELETE' }); }
        else { const r = await api('/api/friends/' + u.handle, { method: 'POST' }); toast(r.friends ? `You and @${u.handle} are friends.` : 'Request sent.'); }
        profileView(el, { handle });
      } catch (e) { fail(e); }
    });
    $('#dm', el).onclick = async () => { if (!need()) return; try { const r = await api('/api/chats', { method: 'POST', body: { members: [u.handle] } }); go('/messages/' + r.chatId); } catch (e) { fail(e); } };
    $('#pay', el).onclick = () => need() && sendModal({ toHandle: u.handle });
    $('#more', el).onclick = ev => moreMenu(ev.currentTarget, [
      ...(rel?.friends ? [{ icon: 'star', label: rel.close ? 'Remove from close friends' : 'Add to close friends', fn: async () => { await api('/api/close-friends/' + u.handle, { method: rel.close ? 'DELETE' : 'POST' }).catch(fail); profileView(el, { handle }); } }] : []),
      { icon: 'x', label: rel?.blocked ? 'Unblock' : 'Block', fn: async () => { if (!need()) return; if (rel?.blocked || (await confirmBox('Block @' + u.handle + '?', 'You won’t see each other’s posts, messages, pins or payments.', 'Block'))) { await api('/api/blocks/' + u.handle, { method: rel?.blocked ? 'DELETE' : 'POST' }).catch(fail); toast(rel?.blocked ? 'Unblocked.' : 'Blocked.'); profileView(el, { handle }); } } },
      { icon: 'flag', label: 'Report', fn: () => (need() && reportModal('user', u.handle)) },
    ]);
  }
}

export async function friendsView(el) {
  if (!state.user) return needLogin('friends');
  let data;
  const load = async () => { data = await api('/api/friends'); };
  try { await load(); } catch (e) { el.innerHTML = `<div class="wrap empty">${esc(e.message)}</div>`; return; }
  const row = (u, actions) => `<div class="list-row"><a href="#/u/${esc(u.handle)}" class="${u.online ? 'online' : ''}">${avatar(u, 'md')}</a><div class="t"><b>${esc(u.displayName || '@' + u.handle)}</b><span>@${esc(u.handle)}${u.city ? ' · ' + esc(u.city) : ''}${u.online ? ' · online' : ''}</span></div>${actions}</div>`;
  const draw = () => {
    el.innerHTML = `<div class="wrap"><div class="page-h"><div class="kicker">People</div><h1 class="h-1">Friends</h1></div>
      <div class="split" style="padding:32px 0 80px"><div>
        ${data.incoming.length ? `<div class="label muted" style="margin-bottom:12px">Requests</div>${data.incoming.map(u => row(u, `<button class="btn sm solid" data-acc="${esc(u.handle)}">Accept</button>`)).join('')}<div style="height:32px"></div>` : ''}
        <div class="label muted" style="margin-bottom:12px">Friends · ${data.friends.length}</div>
        ${data.friends.length ? data.friends.map(u => row(u, `${u.close ? '<span class="kicker">Close</span>' : ''}<button class="btn sm ghost" data-msg="${esc(u.handle)}">${icon('chat')}</button>`)).join('') : '<p class="muted">Search for people you go out with.</p>'}
        ${data.outgoing.length ? `<div class="label muted" style="margin:32px 0 12px">Sent</div>${data.outgoing.map(u => row(u, `<button class="btn sm ghost" data-rm="${esc(u.handle)}">Cancel</button>`)).join('')}` : ''}
      </div><aside><div class="label muted" style="margin-bottom:12px">Find people</div>
        <div class="search" style="border:1px solid var(--line-2);height:48px;padding:0 14px">${icon('search')}<input id="fq" placeholder="Search by handle or name"></div><div id="fr" style="margin-top:8px"></div>
        <button class="btn block ghost" style="margin-top:20px" id="inv">${icon('share')}Invite a friend</button></aside></div></div>`;
    $$('[data-acc]', el).forEach(b => (b.onclick = async () => { await api('/api/friends/' + b.dataset.acc, { method: 'POST' }).catch(fail); await load(); draw(); }));
    $$('[data-rm]', el).forEach(b => (b.onclick = async () => { await api('/api/friends/' + b.dataset.rm, { method: 'DELETE' }).catch(fail); await load(); draw(); }));
    $$('[data-msg]', el).forEach(b => (b.onclick = async () => { const r = await api('/api/chats', { method: 'POST', body: { members: [b.dataset.msg] } }).catch(fail); if (r) go('/messages/' + r.chatId); }));
    let t;
    $('#fq', el).oninput = e => {
      clearTimeout(t);
      const q = e.target.value.trim();
      if (!q) { $('#fr', el).innerHTML = ''; return; }
      t = setTimeout(async () => {
        try {
          const { users } = await api('/api/users/search?' + qs({ q }));
          $('#fr', el).innerHTML = users.map(u => row(u, `<button class="btn sm" data-add="${esc(u.handle)}">Add</button>`)).join('') || '<p class="muted" style="padding:12px 0">No one found.</p>';
          $$('[data-add]', el).forEach(b => (b.onclick = async () => { try { const r = await api('/api/friends/' + b.dataset.add, { method: 'POST' }); b.textContent = r.friends ? 'Friends' : 'Sent'; b.disabled = true; } catch (er) { fail(er); } }));
        } catch (er) { fail(er); }
      }, 250);
    };
    $('#inv', el).onclick = () => navigator.share ? navigator.share({ title: 'NOKTURA', text: `Add me on NOKTURA: @${state.user.handle}`, url: location.origin + '/#/u/' + state.user.handle }).catch(() => {}) : navigator.clipboard.writeText(location.origin + '/#/u/' + state.user.handle).then(() => toast('Profile link copied.'));
  };
  draw();
}

export async function settingsView(el) {
  if (!state.user) return needLogin('settings');
  const u = state.user;
  let avatarUpload;
  const blocked = await api('/api/blocks').then(r => r.blocked).catch(() => []);
  el.innerHTML = `<div class="wrap"><div class="page-h"><div class="kicker">@${esc(u.handle)}</div><h1 class="h-1">Settings</h1></div><div class="settings">
    <section><div class="h-3">Profile</div>
      <form id="pf"><div style="display:flex;gap:16px;align-items:center;margin-bottom:18px"><span id="avp">${avatar(u, 'lg')}</span><button type="button" class="btn sm ghost" id="avb">${icon('image')}Photo</button></div>
        <label class="field"><span>Display name</span><input class="input" name="displayName" maxlength="40" value="${esc(u.displayName)}"></label>
        <label class="field"><span>Bio</span><textarea class="textarea" name="bio" maxlength="280" style="min-height:80px">${esc(u.bio)}</textarea></label>
        <label class="field"><span>Initials (shown without a photo)</span><input class="input" name="avatar" maxlength="2" value="${esc(u.avatar)}"></label>
        <button class="btn solid" id="save">Save profile</button></form></section>
    <section><div class="h-3">Appearance</div><div class="seg" style="max-width:320px"><button data-th="dark" class="${state.theme === 'dark' ? 'on' : ''}">${icon('moon')} Dark</button><button data-th="light" class="${state.theme === 'light' ? 'on' : ''}">${icon('sun')} Light</button></div></section>
    <section><div class="h-3">Password</div><form id="pw"><label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
      <label class="field"><span>New password</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required></label><button class="btn">Change password</button></form></section>
    <section><div class="h-3">Sessions</div><p class="muted" style="margin-bottom:16px">Signs you out on every phone and computer, including this one.</p><button class="btn ghost" id="outAll">${icon('logout')}Sign out everywhere</button>
      <button class="btn ghost" id="out" style="margin-left:8px">Sign out</button></section>
    <section><div class="h-3">Blocked</div>${blocked.length ? blocked.map(b => `<div class="list-row"><div class="t"><b>@${esc(b.handle)}</b></div><button class="btn sm ghost" data-ub="${esc(b.handle)}">Unblock</button></div>`).join('') : '<p class="muted">No one.</p>'}</section>
    <section><div class="h-3">Your data</div><p class="muted" style="margin-bottom:16px">Download everything NOKTURA stores about you, or delete your account.</p>
      <button class="btn ghost" id="exp">Download my data</button> <button class="btn ghost" id="del" style="margin-left:8px">Delete account</button></section>
    <section style="border:0"><div class="muted" style="font-size:13px;display:flex;gap:18px;flex-wrap:wrap"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds</a><a href="/guidelines">Community guidelines</a>${u.role === 'admin' ? '<a href="#/admin">Moderation</a>' : ''}</div></section>
  </div></div>`;
  $('#avb', el).onclick = async () => { const f = await pickFile(); if (!f) return; try { const r = await upload(f, 'avatar'); avatarUpload = r.id; $('#avp', el).innerHTML = `<span class="av lg"><img src="${safeUrl(r.url)}" alt=""></span>`; } catch (e) { fail(e); } };
  $('#save', el).onclick = ev => { ev.preventDefault(); busy(ev.currentTarget, async () => { try { const r = await api('/api/me', { method: 'PATCH', body: { ...formData($('#pf', el)), ...(avatarUpload ? { avatarUpload } : {}) } }); state.user = r.user; toast('Saved.'); } catch (e) { fail(e); } }); };
  $$('[data-th]', el).forEach(b => (b.onclick = () => { setTheme(b.dataset.th); $$('[data-th]', el).forEach(x => x.classList.toggle('on', x === b)); }));
  $('#pw', el).onsubmit = async ev => { ev.preventDefault(); try { const r = await api('/api/auth/password', { method: 'POST', body: formData(ev.target) }); setSession(r.token, state.user); ev.target.reset(); toast('Password changed. Other devices were signed out.'); } catch (e) { fail(e); } };
  $('#outAll', el).onclick = async () => { if (!(await confirmBox('Sign out everywhere?', 'You’ll need to log in again on every device.', 'Sign out'))) return; try { await api('/api/auth/logout-all', { method: 'POST' }); signOut(); go('/'); } catch (e) { fail(e); } };
  $('#out', el).onclick = () => { signOut(); go('/'); };
  $$('[data-ub]', el).forEach(b => (b.onclick = async () => { await api('/api/blocks/' + b.dataset.ub, { method: 'DELETE' }).catch(fail); settingsView(el); }));
  $('#exp', el).onclick = async () => {
    try {
      const res = await fetch('/api/me/export', { headers: { Authorization: 'Bearer ' + state.token } });
      if (!res.ok) throw new Error((await res.json()).error);
      const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `noktura-${u.handle}.json`; a.click();
    } catch (e) { fail(e); }
  };
  $('#del', el).onclick = () => {
    const m = modal(`${modalHead('Delete account', 'This can’t be undone')}<form class="modal-b" id="df">
      <p class="muted" style="margin-bottom:18px">Your profile, posts, pins, messages and listings are deleted. Payment records are kept as the law requires, without your profile.</p>
      <label class="field"><span>Password</span><input class="input" type="password" name="password" required autocomplete="current-password"></label>
      <label class="check"><input type="checkbox" name="forfeit"> I understand any NKT left in my wallet is given up</label></form>
      <div class="modal-f"><button class="btn ghost" data-close>Keep account</button><button class="btn solid" id="go">Delete forever</button></div>`);
    $('#go', m.el).onclick = ev => busy(ev.currentTarget, async () => {
      const f = $('#df', m.el);
      try { await api('/api/me', { method: 'DELETE', body: { password: f.password.value, forfeitBalance: f.forfeit.checked } }); m.close(); signOut(); toast('Account deleted.'); go('/'); }
      catch (e) { fail(e); }
    });
  };
}

export async function adminView(el) {
  if (state.user?.role !== 'admin') { el.innerHTML = '<div class="wrap empty">Admins only.</div>'; return; }
  const draw = async () => {
    const { reports } = await api('/api/admin/reports');
    el.innerHTML = `<div class="wrap"><div class="page-h"><div class="kicker">Admin</div><h1 class="h-1">Reports</h1></div><div class="sec">${reports.length ? reports.map(r => `<div class="req"><div><b>${esc(r.reason)}</b><div class="muted" style="font-size:13px">${esc(r.targetType)} · ${esc(r.targetId)} · by @${esc(r.reporter || '?')} · ${ago(r.at)}</div>${r.details ? `<p style="margin-top:8px">${esc(r.details)}</p>` : ''}</div>
      <div style="display:flex;gap:6px"><button class="btn sm ghost" data-r="${esc(r.id)}" data-a="dismiss">Dismiss</button><button class="btn sm solid" data-r="${esc(r.id)}" data-a="remove">Remove</button></div></div>`).join('') : '<div class="empty">Queue is clear.</div>'}</div></div>`;
    $$('[data-r]', el).forEach(b => (b.onclick = async () => { await api('/api/admin/reports/' + b.dataset.r, { method: 'POST', body: { action: b.dataset.a } }).catch(fail); draw(); }));
  };
  draw().catch(fail);
}
