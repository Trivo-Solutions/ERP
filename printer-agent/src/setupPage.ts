// A tiny, dependency-free setup page served by the agent itself (http://127.0.0.1:<port>/setup).
// This is the whole point of the redesign: instead of a human editing a .env file by hand, the
// agent asks the browser to open this page on first run, the browser lists printers Windows
// already knows about, and picking one is a single click that never touches the filesystem.
export function renderSetupPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SEA ERP Print Agent — Setup</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 20px; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
  .status { font-size: 14px; margin-bottom: 8px; }
  .status.ok { color: #1a7f37; }
  .status.warn { color: #b45309; }
  label.opt { display: block; padding: 8px 0; border-bottom: 1px solid #eee; cursor: pointer; }
  label.opt:last-child { border-bottom: none; }
  input[type=text] { width: 100%; padding: 8px; box-sizing: border-box; margin-top: 6px; }
  button { background: #1565c0; color: #fff; border: none; border-radius: 6px; padding: 10px 18px; font-size: 14px; cursor: pointer; }
  button:disabled { background: #999; cursor: default; }
  button.secondary { background: #eee; color: #1a1a1a; }
  .msg { font-size: 13px; margin-top: 10px; }
  .msg.err { color: #b3261e; }
  .msg.ok { color: #1a7f37; }
  small { color: #666; }
</style>
</head>
<body>
  <h1>SEA ERP Print Agent — Setup</h1>
  <div class="card">
    <div id="statusLine" class="status">Checking status…</div>
  </div>

  <div class="card">
    <p><strong>1. Pick your label printer.</strong> This list comes straight from Windows — install
    the printer's driver first if it isn't here yet, then reload this page.</p>
    <div id="printerList">Loading…</div>
    <label class="opt">
      <input type="radio" name="printer" value="__manual__" id="manualRadio" />
      Not listed — type the exact name
      <input type="text" id="manualName" placeholder="e.g. TSC TTP-244 Pro" />
    </label>
    <button id="saveBtn">Save printer</button>
    <div id="saveMsg" class="msg"></div>
  </div>

  <div class="card">
    <p><strong>Receipt printer (estimates, 80 mm).</strong> Pick the Epson TM-m30III here. It is
    separate from the label printer above — saving one never changes the other.</p>
    <select id="receiptSelect" style="width:100%;padding:8px;"></select>
    <div style="margin-top:10px;display:flex;gap:8px;">
      <button id="receiptSave">Save receipt printer</button>
      <button id="receiptTest" class="secondary">Print test receipt</button>
    </div>
    <div id="receiptMsg" class="msg"></div>
  </div>

  <div class="card">
    <p><strong>2. Start automatically when this PC turns on</strong> (recommended for a counter PC)
    — no more double-clicking the exe every morning.</p>
    <label class="opt">
      <input type="checkbox" id="autostartBox" /> Start SEA ERP Print Agent at login
    </label>
    <div id="autostartMsg" class="msg"></div>
  </div>

  <p><small>You can come back to this page any time at <code id="thisUrl"></code> to change the
  printer or this setting.</small></p>

<script>
document.getElementById('thisUrl').textContent = window.location.href;

async function loadStatus() {
  const el = document.getElementById('statusLine');
  try {
    const res = await fetch('/status');
    const s = await res.json();
    if (s.configured) {
      el.className = 'status ' + (s.online ? 'ok' : 'warn');
      el.textContent = (s.online ? '✓ Ready — ' : '⚠ ') + s.printerName + ' — ' + s.statusText;
    } else {
      el.className = 'status warn';
      el.textContent = 'Not set up yet — pick a printer below.';
    }
  } catch {
    el.textContent = 'Unable to reach the agent itself (unexpected on this page).';
  }
}

async function loadPrinters() {
  const list = document.getElementById('printerList');
  let current = null;
  try {
    const s = await (await fetch('/status')).json();
    current = s.printerName || null;
  } catch {}
  try {
    const res = await fetch('/setup/printers');
    const { printers } = await res.json();
    if (!printers.length) {
      list.innerHTML = '<em>No printers found. Install the printer driver, then reload this page.</em>';
      return;
    }
    list.innerHTML = '';
    printers.forEach((name, i) => {
      const label = document.createElement('label');
      label.className = 'opt';
      const checked = name === current;
      label.innerHTML = '<input type="radio" name="printer" value="' + escapeHtml(name) + '"' + (checked ? ' checked' : '') + ' /> ' + escapeHtml(name);
      list.appendChild(label);
    });
    if (current && !printers.includes(current)) {
      document.getElementById('manualRadio').checked = true;
      document.getElementById('manualName').value = current;
    }
  } catch {
    list.innerHTML = '<em>Could not list printers.</em>';
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const manual = document.getElementById('manualRadio').checked;
  const printerName = manual
    ? document.getElementById('manualName').value.trim()
    : (document.querySelector('input[name=printer]:checked') || {}).value;
  const msg = document.getElementById('saveMsg');
  if (!printerName || printerName === '__manual__') {
    msg.className = 'msg err';
    msg.textContent = 'Pick a printer or type its name first.';
    return;
  }
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  try {
    const res = await fetch('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerName }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || 'Save failed');
    msg.className = 'msg ok';
    msg.textContent = 'Saved. You can close this tab and go back to the ERP.';
    loadStatus();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message || String(e);
  }
});

async function loadAutostart() {
  try {
    const { enabled, supported } = await (await fetch('/setup/autostart')).json();
    const box = document.getElementById('autostartBox');
    box.checked = enabled;
    if (!supported) {
      box.disabled = true;
      document.getElementById('autostartMsg').textContent = 'Only available in the downloaded .exe (not this dev run).';
    }
  } catch {}
}

document.getElementById('autostartBox').addEventListener('change', async (e) => {
  const msg = document.getElementById('autostartMsg');
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  try {
    const res = await fetch('/setup/autostart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: e.target.checked }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || 'Failed');
    msg.className = 'msg ok';
    msg.textContent = e.target.checked ? 'Will start automatically at login.' : 'Autostart turned off.';
  } catch (err) {
    e.target.checked = !e.target.checked;
    msg.className = 'msg err';
    msg.textContent = err.message || String(err);
  }
});

loadStatus();
loadPrinters();
loadAutostart();
async function loadReceipt() {
  const sel = document.getElementById('receiptSelect');
  let current = null;
  try { current = (await (await fetch('/receipt/status')).json()).printerName || null; } catch {}
  try {
    const { printers } = await (await fetch('/setup/printers')).json();
    const names = current && !printers.includes(current) ? [current, ...printers] : printers;
    sel.innerHTML = '<option value="">— not set —</option>' + names.map((n) =>
      '<option value="' + escapeHtml(n) + '"' + (n === current ? ' selected' : '') + '>' + escapeHtml(n) + '</option>').join('');
  } catch { sel.innerHTML = '<option value="">Could not list printers</option>'; }
}
async function receiptCall(path, body) {
  const msg = document.getElementById('receiptMsg');
  msg.className = 'msg'; msg.textContent = 'Working…';
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || 'Failed');
    msg.className = 'msg ok';
    msg.textContent = path === '/receipt/test' ? 'Test sent to the printer queue — check the paper.' : 'Saved.';
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message || String(e); }
}
document.getElementById('receiptSave').addEventListener('click', () => {
  const v = document.getElementById('receiptSelect').value;
  if (!v) { const m = document.getElementById('receiptMsg'); m.className = 'msg err'; m.textContent = 'Pick the receipt printer first.'; return; }
  receiptCall('/receipt/config', { printerName: v });
});
document.getElementById('receiptTest').addEventListener('click', () => receiptCall('/receipt/test'));
loadReceipt();

</script>
</body>
</html>`;
}
