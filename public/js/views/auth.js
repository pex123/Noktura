import { state, api, esc, icon, LOGO, go, setSession, setCity, busy, formData, $, $$ } from '../core.js';

const WHY = {
  tickets: 'Log in to buy tickets.', rsvp: 'Log in so friends see where you’re going.', chat: 'Log in to message people.', wallet: 'Log in to use your wallet.',
  friends: 'Log in to add friends.', post: 'Log in to post.', host: 'Log in to post an event.', pin: 'Log in to drop pins.', live: 'Log in to share your location with friends.',
  like: 'Log in to like posts.', report: 'Log in to report.', sell: 'Log in to sell on the market.', buy: 'Log in to buy.', earn: 'Log in to earn NKT.', door: 'Log in to scan tickets.',
};

export async function authView(el, mode, q) {
  if (state.user) { go(q.next || '/'); return; }
  const next = q.next || '/';
  let avatar = 'A';
  el.innerHTML = `<div class="auth">
    <div class="auth-art">${LOGO.replace('<svg', '<svg class="mark"')}
      <div class="kicker" style="margin-bottom:20px">NOKTURA</div>
      <div class="h-mega" style="font-size:clamp(56px,7vw,112px)">Tonight in<br>${esc(state.city.name)}</div>
      <p class="lead" style="margin-top:24px;max-width:440px">Events, tickets, friends and payments. Belgrade, Novi Sad and more than sixty cities.</p>
    </div>
    <div class="auth-form">
      <form id="af" novalidate>
        <div class="kicker" style="margin-bottom:14px">${mode === 'login' ? 'Welcome back' : 'Create your account'}</div>
        <h1 class="h-2" style="margin-bottom:28px">${mode === 'login' ? 'Log in' : 'Join NOKTURA'}</h1>
        ${q.why && WHY[q.why] ? `<div class="err" style="margin-bottom:20px">${esc(WHY[q.why])}</div>` : ''}
        <div id="ae"></div>
        <label class="field"><span>Handle</span><input class="input" name="handle" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="yourname" required maxlength="20"></label>
        <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="8"></label>
        ${mode === 'join' ? `
          <label class="field"><span>City</span><input class="input" name="city" value="${esc(state.city.name)}" maxlength="60"></label>
          <div class="field"><span>Initials</span><div class="av-grid">${['A', 'B', 'D', 'K', 'M', 'N', 'S', 'V', 'Z', 'Ž', 'Đ', 'Ć'].map((l, i) => `<button type="button" data-av="${l}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div></div>
          <label class="check"><input type="checkbox" name="over18" required> I am 18 or older</label>
          <label class="check"><input type="checkbox" name="acceptTerms" required> I agree to the <a href="/terms" target="_blank">Terms</a>, <a href="/privacy" target="_blank">Privacy Policy</a> and <a href="/guidelines" target="_blank">Community Guidelines</a></label>` : ''}
        <button class="btn solid lg block" style="margin-top:12px" id="go">${mode === 'login' ? 'Log in' : 'Create account'}${icon('arrow')}</button>
        <p class="muted" style="margin-top:22px;font-size:14px;text-align:center">${mode === 'login' ? `New here? <a class="link" href="#/join?next=${encodeURIComponent(next)}">Create an account</a>` : `Already have one? <a class="link" href="#/login?next=${encodeURIComponent(next)}">Log in</a>`}</p>
      </form>
    </div></div>`;
  const f = $('#af', el);
  f.handle.oninput = () => { f.handle.value = f.handle.value.replace(/[^a-zA-Z0-9_]/g, ''); };
  $$('[data-av]', el).forEach(b => (b.onclick = () => { avatar = b.dataset.av; $$('[data-av]', el).forEach(x => x.classList.toggle('on', x === b)); }));
  f.onsubmit = ev => {
    ev.preventDefault();
    const err = $('#ae', el);
    err.innerHTML = '';
    busy($('#go', el), async () => {
      const d = formData(f);
      try {
        const r = mode === 'login'
          ? await api('/api/auth/login', { method: 'POST', body: { handle: d.handle, password: d.password } })
          : await api('/api/auth/signup', { method: 'POST', body: { handle: d.handle, password: d.password, city: d.city, avatar, over18: f.over18.checked, acceptTerms: f.acceptTerms.checked, ...(d.city === state.city.name ? { cityLat: state.city.lat, cityLng: state.city.lng } : {}) } });
        setSession(r.token, r.user);
        if (r.user.city && r.user.cityLat != null && r.user.city !== state.city.name) setCity({ name: r.user.city, lat: r.user.cityLat, lng: r.user.cityLng, tz: state.city.tz });
        go(next);
      } catch (e) { err.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    });
  };
  f.onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); f.requestSubmit(); } };
}
