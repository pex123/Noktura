import { state, api, qs, esc, icon, ago, fDay, fTime, linkify, safeUrl, avatar, fail, toast, busy, upload, pickFile, confirmBox, share, on, currentQuery, modal, modalHead, VERIFIED, CATEGORY_LABEL, $, $$, h } from '../core.js';
import { eventImg } from './events.js';
import { promoteModal, reportModal, moreMenu, needLogin } from './shared.js';

function pickEvent() {
  return new Promise(resolve => {
    const m = modal(`${modalHead('Tag an event', state.city.name)}<div class="modal-b"><div class="search" style="border:1px solid var(--line-2);height:48px;padding:0 14px">${icon('search')}<input id="eq" placeholder="Artist, venue or title"></div><div class="city-list" id="er"></div></div>`, { onClose: () => resolve(null) });
    const list = $('#er', m.el);
    let t, results = [];
    const run = async term => {
      try {
        const r = await api('/api/events?' + qs({ lat: state.city.lat, lng: state.city.lng, q: term, limit: 20, featured: '0' }));
        results = r.events;
        list.innerHTML = results.map((e, i) => `<button data-i="${i}">${esc(e.title)}<span>${esc(fDay(e.startsAt, e.tz))}</span></button>`).join('') || '<div class="empty">No matches.</div>';
        $$('[data-i]', list).forEach(b => (b.onclick = () => { const e = results[+b.dataset.i]; resolve(e); m.close(); }));
      } catch (e) { fail(e); }
    };
    $('#eq', m.el).oninput = e => { clearTimeout(t); t = setTimeout(() => run(e.target.value.trim()), 250); };
    run('');
  });
}

export async function feedView(el) {
  const q = currentQuery();
  let scope = q.scope || 'city', nextBefore = null, posts = [], loading = false;
  let draft = { image: null, imageUrl: '', event: null, anon: false };

  el.innerHTML = `<div class="wrap"><div class="feed">
    <div class="page-h" style="border:0;padding-bottom:0"><div class="kicker">${esc(state.city.name)} · feed</div><h1 class="h-1">Feed</h1></div>
    <div class="tabs" style="margin-top:28px"><button data-s="city" class="${scope === 'city' ? 'on' : ''}">${esc(state.city.name)}</button><button data-s="friends" class="${scope === 'friends' ? 'on' : ''}">Friends</button><button data-s="all" class="${scope === 'all' ? 'on' : ''}">Everywhere</button></div>
    <div id="compose"></div>
    <div id="list"><div class="empty">Loading…</div></div>
    <div style="text-align:center;padding:32px 0" id="more" hidden><button class="btn">Older posts</button></div>
  </div></div>`;

  function drawCompose() {
    const c = $('#compose', el);
    if (!state.user) { c.innerHTML = `<div class="compose" style="padding:24px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap"><span class="lead">Join to post, comment and see where your friends are going.</span><a class="btn solid" href="#/join">Join</a></div>`; return; }
    c.innerHTML = `<div class="compose">
      <textarea id="ta" placeholder="${draft.anon ? 'Posting anonymously…' : 'What’s happening tonight?'}" maxlength="2000"></textarea>
      <div class="compose-prev" id="prev"></div>
      <div class="compose-bar">
        <button class="icon-btn" id="img" aria-label="Add photo" title="Photo">${icon('image')}</button>
        <button class="icon-btn" id="tag" aria-label="Tag an event" title="Tag an event">${icon('ticket')}</button>
        <button class="icon-btn ${draft.anon ? 'on' : ''}" id="anon" aria-label="Post anonymously" title="Anonymous">${icon('user')}</button>
        <span class="kicker" style="margin-left:8px">${draft.anon ? 'Anonymous' : '@' + esc(state.user.handle)}</span>
        <button class="btn sm solid" id="post" style="margin-left:auto">Post</button>
      </div></div>`;
    drawPrev();
    $('#img', c).onclick = async () => {
      const f = await pickFile();
      if (!f) return;
      try { const r = await upload(f, 'post'); draft.image = r.id; draft.imageUrl = r.url; drawPrev(); } catch (e) { fail(e); }
    };
    $('#tag', c).onclick = () => tagEvent();
    $('#anon', c).onclick = () => { draft.anon = !draft.anon; const t = $('#ta', c).value; drawCompose(); $('#ta', el).value = t; };
    $('#post', c).onclick = ev => busy(ev.currentTarget, async () => {
      const text = $('#ta', c).value.trim();
      try {
        await api('/api/posts', { method: 'POST', body: { text, anon: draft.anon, imageUpload: draft.image, eventId: draft.event?.id, city: state.city.name } });
        draft = { image: null, imageUrl: '', event: null, anon: false };
        drawCompose(); load(false);
      } catch (e) { fail(e); }
    });
  }
  function drawPrev() {
    const p = $('#prev', el);
    if (!p) return;
    p.innerHTML = `${draft.imageUrl ? `<span class="att"><img src="${safeUrl(draft.imageUrl)}" alt=""><button data-x="img" aria-label="Remove photo">${icon('x')}</button></span>` : ''}${draft.event ? `<span class="att">${icon('ticket', 'style="width:14px;height:14px"')}${esc(draft.event.title)}<button data-x="ev" aria-label="Remove event">${icon('x')}</button></span>` : ''}`;
    $$('[data-x]', p).forEach(b => (b.onclick = () => { if (b.dataset.x === 'img') { draft.image = null; draft.imageUrl = ''; } else draft.event = null; drawPrev(); }));
  }
  async function tagEvent(preId) {
    if (preId) { try { draft.event = (await api('/api/events/' + preId)).event; drawPrev(); } catch { /* ignore */ } return; }
    const ev = await pickEvent();
    if (ev) { draft.event = ev; drawPrev(); }
  }

  function postHtml(p) {
    const a = p.author;
    return `<article class="post ${p.kind === 'editorial' ? 'editorial' : ''}" data-id="${esc(p.id)}">
      <div class="post-h">${a.handle === 'anon' ? '<span class="av">?</span>' : `<a href="#/u/${esc(a.handle)}">${avatar(a)}</a>`}
        <div class="who"><b>${a.handle === 'anon' ? 'Anonymous' : `<a href="#/u/${esc(a.handle)}">${esc(a.displayName || '@' + a.handle)}</a>`}${a.verified ? VERIFIED : ''}</b><span>${a.handle !== 'anon' && a.displayName ? '@' + esc(a.handle) + ' · ' : ''}${ago(p.at)}${p.city ? ' · ' + esc(p.city) : ''}${p.promoted ? ' · Promoted' : ''}</span></div>
        <button class="icon-btn" data-more aria-label="More">${icon('more')}</button></div>
      ${p.headline ? `<h2 class="headline">${esc(p.headline)}</h2>` : ''}
      ${p.text ? `<div class="body">${linkify(p.text)}</div>` : ''}
      ${p.image ? `<div class="pimg"><img src="${safeUrl(p.image)}" alt="" loading="lazy"></div>` : ''}
      ${p.event ? `<a class="pev" href="#/e/${esc(p.event.id)}"><span class="thumb">${eventImg(p.event)}</span><div><span class="kicker">${esc(fDay(p.event.startsAt, p.event.tz))} · ${esc(fTime(p.event.startsAt, p.event.tz))} · ${esc(CATEGORY_LABEL[p.event.category] || '')}</span><span class="h-4">${esc(p.event.title)}</span><span class="muted" style="font-size:13px">${esc(p.event.venue || p.event.city)}${p.event.priceText ? ' · ' + esc(p.event.priceText) : ''}</span></div></a>` : ''}
      ${p.link ? `<a class="plink" href="${safeUrl(p.link.url)}" target="_blank" rel="noopener nofollow">${esc(p.link.title)}${icon('ext', 'style="width:14px;height:14px"')}</a>` : ''}
      <div class="post-a">
        <button data-like class="${p.liked ? 'on' : ''}" aria-label="Like">${icon('heart')}<span>${p.likeCount || ''}</span></button>
        <button data-cm aria-label="Comments">${icon('comment')}<span>${p.commentCount || ''}</span></button>
        <button data-share aria-label="Share">${icon('share')}<span>${p.shareCount || ''}</span></button>
      </div>
      <div class="comments" hidden></div>
    </article>`;
  }

  function wire(node, p) {
    $('[data-like]', node).onclick = async ev => {
      if (!state.user) return needLogin('like');
      const b = ev.currentTarget;
      try { const r = await api(`/api/posts/${p.id}/like`, { method: 'POST' }); p.liked = r.liked; p.likeCount = r.likeCount; b.classList.toggle('on', r.liked); b.querySelector('span').textContent = r.likeCount || ''; } catch (e) { fail(e); }
    };
    $('[data-cm]', node).onclick = () => toggleComments(node, p);
    $('[data-share]', node).onclick = async () => {
      if (await share({ title: p.headline || 'NOKTURA', text: (p.text || '').slice(0, 120), url: location.origin + '/#/feed' })) api(`/api/posts/${p.id}/share`, { method: 'POST' }).catch(() => {});
    };
    $('[data-more]', node).onclick = ev => moreMenu(ev.currentTarget, p.mine ? [
      { icon: 'promote', label: 'Promote', fn: () => promoteModal('post', p.id, () => load(false)) },
      { icon: 'trash', label: 'Delete post', fn: async () => { if (await confirmBox('Delete this post?', 'It will be removed for everyone, with its comments.', 'Delete')) { try { await api('/api/posts/' + p.id, { method: 'DELETE' }); node.remove(); toast('Post deleted.'); } catch (e) { fail(e); } } } },
    ] : [
      { icon: 'flag', label: 'Report post', fn: () => (state.user ? reportModal('post', p.id) : needLogin('report')) },
      ...(p.author.handle !== 'anon' && p.author.handle !== 'noktura' && state.user ? [{ icon: 'x', label: 'Block @' + p.author.handle, fn: async () => { if (await confirmBox('Block @' + p.author.handle + '?', 'You won’t see each other’s posts, messages or pins.', 'Block')) { try { await api('/api/blocks/' + p.author.handle, { method: 'POST' }); toast('Blocked.'); load(false); } catch (e) { fail(e); } } } }] : []),
    ]);
  }

  async function toggleComments(node, p) {
    const box = $('.comments', node);
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="comment muted">Loading…</div>';
    const drawC = async () => {
      const { comments } = await api(`/api/posts/${p.id}/comments`);
      box.innerHTML = comments.map(c => `<div class="comment"><a href="#/u/${esc(c.from)}">${avatar(c, 'sm')}</a><div><b>@${esc(c.from)}</b>${linkify(c.text)}<div class="kicker" style="margin-top:4px">${ago(c.at)}</div></div>${c.canDelete ? `<button class="x" data-del="${esc(c.id)}">Delete</button>` : `<button class="x" data-rep="${esc(c.id)}">Report</button>`}</div>`).join('')
        + (state.user ? `<form class="comment" data-f style="gap:8px"><input class="input" name="t" placeholder="Add a comment" maxlength="1000" style="height:40px"><button class="btn sm">Send</button></form>` : '');
      $$('[data-del]', box).forEach(b => (b.onclick = async () => { await api('/api/comments/' + b.dataset.del, { method: 'DELETE' }).catch(fail); p.commentCount--; drawC(); }));
      $$('[data-rep]', box).forEach(b => (b.onclick = () => (state.user ? reportModal('comment', b.dataset.rep) : needLogin('report'))));
      const f = $('[data-f]', box);
      if (f) f.onsubmit = async ev => {
        ev.preventDefault();
        const t = f.t.value.trim();
        if (!t) return;
        try { await api(`/api/posts/${p.id}/comments`, { method: 'POST', body: { text: t } }); p.commentCount++; $('[data-cm] span', node).textContent = p.commentCount; drawC(); } catch (e) { fail(e); }
      };
    };
    drawC().catch(fail);
  }

  async function load(more) {
    if (loading) return;
    loading = true;
    try {
      const r = await api('/api/posts?' + qs({ scope, city: state.city.name, before: more ? nextBefore : '' }));
      posts = more ? posts.concat(r.posts) : r.posts;
      nextBefore = r.nextBefore;
      const list = $('#list', el);
      if (!more) list.innerHTML = '';
      if (!posts.length) list.innerHTML = `<div class="empty"><div class="h-3">${scope === 'friends' ? 'Quiet in your circle' : 'Nothing here yet'}</div><p>${scope === 'friends' ? 'Add friends to see what they’re up to.' : 'Be the first to post in ' + esc(state.city.name) + '.'}</p>${scope === 'friends' ? '<a class="btn" href="#/friends">Find friends</a>' : ''}</div>`;
      for (const p of more ? r.posts : posts) { const node = h(postHtml(p)); wire(node, p); list.appendChild(node); }
      $('#more', el).hidden = !nextBefore;
    } catch (e) {
      if (e.status === 401) { $('#list', el).innerHTML = '<div class="empty"><div class="h-3">Log in to see friends</div><a class="btn solid" href="#/join">Join</a></div>'; }
      else fail(e);
    } finally { loading = false; }
  }

  $$('[data-s]', el).forEach(b => (b.onclick = () => { scope = b.dataset.s; $$('[data-s]', el).forEach(x => x.classList.toggle('on', x === b)); load(false); }));
  $('#more button', el).onclick = () => load(true);
  drawCompose();
  if (q.event && state.user) tagEvent(q.event);
  await load(false);
  let pending = 0;
  const offs = [
    on('rt:new_post', d => { if (scope === 'all' || d.city === state.city.name) { pending++; if (pending === 1) toast('New posts', 'ok', { label: 'Show', fn: () => { pending = 0; load(false); window.scrollTo({ top: 0, behavior: 'smooth' }); } }); } }),
    on('rt:post_deleted', d => $(`[data-id="${CSS.escape(d.id)}"]`, el)?.remove()),
  ];
  return () => offs.forEach(f => f());
}
