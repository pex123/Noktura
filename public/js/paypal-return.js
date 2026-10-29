// Tells the NOKTURA tab that opened PayPal how the approval went, then closes.
(function () {
  var q = new URLSearchParams(location.search);
  var cancelled = q.has('cancelled');
  var token = q.get('token');
  if (cancelled) {
    document.getElementById('t').textContent = 'Payment cancelled';
    document.getElementById('c').textContent = 'No money was taken. Go back to NOKTURA to try again.';
  }
  try { if (window.opener) window.opener.postMessage({ type: 'noktura:paypal', status: cancelled ? 'cancelled' : 'approved', orderId: token }, location.origin); } catch (e) { /* opener gone */ }
  document.getElementById('close').onclick = function () { window.close(); };
  if (window.opener && !cancelled) setTimeout(function () { window.close(); }, 1200);
})();
