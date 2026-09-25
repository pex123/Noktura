"""Builds public/ from the design source without touching the source files.

    python scripts/build_frontend.py ["path/to/Noktura web/New version"]

The UI (markup + CSS) is copied byte-for-byte. Only two script blocks change:
  1. The offline demo shim (fake fetch + fake Socket.IO) is replaced by the real
     Socket.IO client and /config.js served by the backend.
  2. The inline preview layer (premium.js: local-only pins/check-ins) is replaced
     by public/app-live.js, which keeps the same presentation but talks to the API.
"""
from pathlib import Path
import shutil, sys

root = Path(__file__).resolve().parent.parent
default_src = Path.home() / 'Downloads' / 'Noktura web' / 'New version'
src = Path(sys.argv[1]) if len(sys.argv) > 1 else default_src
html = (src / 'index.html').read_text(encoding='utf-8')

SHIM_START = '<!-- Offline preview: Socket.IO is provided by the demo adapter below. -->'
start = html.index(SHIM_START)
end = html.index('</script>', start) + len('</script>')
live_head = (
    '<script src="/socket.io/socket.io.js"></script>\n'
    '<script src="/config.js"></script>\n'
    '<script>/* "Log out" navigates to ?onboarding=1 — clear the session there. */'
    "if(new URLSearchParams(location.search).has('onboarding')){try{localStorage.removeItem('axis_auth_token')}catch(e){}"
    "history.replaceState(null,'',location.pathname)}</script>"
)
html = html[:start] + live_head + html[end:]

PREVIEW = '<script src="assets/leaflet.js"></script><script src="assets/jsQR.js"></script><script>'
p_start = html.index(PREVIEW)
p_end = html.index('</script></body>', p_start) + len('</script>')
inline = html[p_start + len(PREVIEW):p_end - len('</script>')]
if inline.strip() != (src / 'premium.js').read_text(encoding='utf-8').strip():
    print('WARNING: inline preview script differs from premium.js — review public/app-live.js for new changes.')
html = html[:p_start] + '<script src="assets/leaflet.js"></script><script src="assets/jsQR.js"></script><script src="app-live.js"></script>' + html[p_end:]

out = root / 'public'
out.mkdir(exist_ok=True)
(out / 'index.html').write_text(html, encoding='utf-8')
shutil.copytree(src / 'assets', out / 'assets', dirs_exist_ok=True)
print('Built', out / 'index.html', f'({len(html):,} characters)')
