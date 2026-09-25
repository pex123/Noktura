"""Builds hatchable/ bundle from public/index.html (run build_frontend.py first).

Hatchable reserves /api/auth/* and has no Socket.IO server, so the page loads
/rt.js (a Socket.IO-compatible shim over Hatchable realtime) and calls
/api/account/* instead. The UI markup/CSS is unchanged. The page is shipped
gzip+base64 inside lib/page.js and served by pages/index.js.
"""
from pathlib import Path
import base64, gzip

root = Path(__file__).resolve().parent.parent
html = (root / 'public' / 'index.html').read_text(encoding='utf-8')
html = html.replace('<script src="/socket.io/socket.io.js"></script>\n<script src="/config.js"></script>',
                    '<script src="/__hatchable/events.js"></script>\n<script src="/rt.js"></script>')
assert '/rt.js' in html
html = html.replace("'/api/auth/signup'", "'/api/account/signup'").replace("'/api/auth/login'", "'/api/account/login'")
assert '/api/auth/' not in html
out = root / 'hatchable'
out.mkdir(exist_ok=True)
data = base64.b64encode(gzip.compress(html.encode('utf-8'), 9)).decode()
(out / 'page.b64').write_text(data)
print('page.b64', len(data), 'chars')
