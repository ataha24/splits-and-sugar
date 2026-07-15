let stravaToken = null;
let activities = [];
let selectedActivity = null;
let glucoseRows = null; // [{t: Date, val: number}]
let glucoseUnit = 'mg/dL';
let lastReport = null; // set by buildReport; used by the share-image export

const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const MI = 1609.34;
const PAD_MS = 45 * 60 * 1000; // report window: 45 min either side of the run

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Strava's start_date_local carries a "Z" suffix but is local wall time, not
// UTC. Strip any zone marker so it parses in the browser's local time and
// lines up with the Dexcom CSV timestamps (also local wall time).
function parseLocalDate(s){
  return new Date(String(s).replace(/(Z|[+-]\d\d:?\d\d)$/, ''));
}
function toLocalISO(d){
  const p = n => String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}

function setStep(n, state){ // state: 'active' | 'complete'
  const el = $('num-'+n);
  el.classList.remove('active','complete');
  el.classList.add(state);
}

// ---------- formatting ----------
function fmtPace(mps){
  if(!mps || mps <= 0) return '—';
  const secPerMile = MI / mps;
  const m = Math.floor(secPerMile/60), s = Math.round(secPerMile%60);
  return m + ':' + String(s).padStart(2,'0') + '/mi';
}
function fmtDur(sec){
  sec = Math.round(sec);
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return (h ? h + ':' + String(m).padStart(2,'0') : m) + ':' + String(s).padStart(2,'0');
}
function fmtClock(d){
  return d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
}
function fmtG(v){
  return glucoseUnit === 'mmol/L' ? (Math.round(v*10)/10).toFixed(1) : String(Math.round(v));
}

// ---------- STEP 1: Strava ----------
async function loadActivities(token){
  const res = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=20', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  if(!res.ok){
    let detail = '';
    try{ detail = JSON.stringify(await res.json()); }catch(_){}
    if(res.status === 401 && detail.includes('permission')){
      throw new Error('That token can\'t read activities — the token shown on strava.com/settings/api only has basic scope. Use "Connect with Strava" above instead.');
    }
    throw new Error(res.status === 401
      ? 'Token rejected — it may have expired (Strava tokens last ~6 hours). Connect again to get a fresh one.'
      : 'Strava returned an error (' + res.status + ').');
  }
  const data = await res.json();
  activities = data.filter(a => a.type === 'Run' || a.type === 'TrailRun');
  if(activities.length === 0){
    throw new Error('No recent runs found on that account.');
  }
  stravaToken = token;
  const forget = hasSession
    ? '<div class="forget">Staying connected on this browser — <a href="#" id="btn-forget">disconnect</a></div>'
    : '';
  $('strava-status').innerHTML = '<div class="ok">Connected — pick the run below.</div>' + forget;
  on('btn-forget', 'click', (e) => {
    e.preventDefault();
    fetch('/api/logout', {method: 'POST'});
    e.target.closest('.forget').textContent = 'Disconnected — this browser won\'t reconnect automatically next visit.';
  });
  renderActivityList();
  $('card-strava').classList.add('done');
  setStep(1,'complete');
}

// OAuth: one shared Strava app. The page redirects to Strava for approval;
// the code-for-token exchange happens server-side (/api/token), where the
// app's client secret lives. The page only ever holds the short-lived access
// token in memory — the long-lived refresh token stays in an httpOnly cookie
// that page JavaScript can never read.
let hasSession = false; // connected via the cookie session (vs a pasted token / DIY app)

function authorizeUrl(clientId){
  return 'https://www.strava.com/oauth/authorize'
    + '?client_id=' + encodeURIComponent(clientId)
    + '&redirect_uri=' + encodeURIComponent(location.origin + location.pathname)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent('read,activity:read_all')
    + '&approval_prompt=auto';
}

on('btn-oauth', 'click', async () => {
  const statusEl = $('strava-status');
  statusEl.innerHTML = '';
  try{
    const res = await fetch('/api/config');
    const cfg = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(cfg.error || 'The server isn\'t reachable — try again in a moment.');
    location.href = authorizeUrl(cfg.client_id);
  }catch(err){
    statusEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
  }
});

// DIY option: users who'd rather not route through the shared app can use
// their own personal Strava API app. The code-for-token exchange then happens
// entirely in the browser (Strava's token endpoint allows CORS) and nothing
// outlives the visit — credentials survive only the OAuth redirect, in
// sessionStorage, and are wiped the moment the page returns.
const DIY_ID_KEY = 'ss_diy_id', DIY_SECRET_KEY = 'ss_diy_secret';

on('btn-diy', 'click', () => {
  const id = $('client-id').value.trim();
  const secret = $('client-secret').value.trim();
  if(!id || !secret){
    $('strava-status').innerHTML = '<div class="error">Enter both the Client ID and Client Secret first (see the steps above).</div>';
    return;
  }
  sessionStorage.setItem(DIY_ID_KEY, id);
  sessionStorage.setItem(DIY_SECRET_KEY, secret);
  location.href = authorizeUrl(id);
});

async function handleOAuthReturn(){
  const params = new URLSearchParams(location.search);
  const statusEl = $('strava-status');
  const diyId = sessionStorage.getItem(DIY_ID_KEY);
  const diySecret = sessionStorage.getItem(DIY_SECRET_KEY);
  sessionStorage.removeItem(DIY_ID_KEY);
  sessionStorage.removeItem(DIY_SECRET_KEY);
  history.replaceState(null, '', location.pathname); // scrub the code from the URL
  if(diyId) $('client-id').value = diyId;
  if(diySecret) $('client-secret').value = diySecret;

  if(params.get('error')){
    statusEl.innerHTML = '<div class="error">Strava access was declined — hit connect again and tap Authorize.</div>';
    return;
  }
  if(!(params.get('scope') || '').includes('activity:read')){
    statusEl.innerHTML = '<div class="error">Activity access was unticked on the Strava screen — connect again and leave both boxes checked.</div>';
    return;
  }
  statusEl.innerHTML = '<div class="ok">Authorized — finishing sign-in…</div>';
  try{
    if(diyId && diySecret){
      // DIY app: exchange in the browser, straight against Strava
      const res = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({client_id: diyId, client_secret: diySecret, code: params.get('code'), grant_type: 'authorization_code'})
      });
      if(!res.ok) throw new Error('Strava rejected the sign-in (' + res.status + ') — double-check the Client Secret and connect again.');
      const tok = await res.json();
      await loadActivities(tok.access_token);
    }else{
      const res = await fetch('/api/token', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({code: params.get('code')})
      });
      const tok = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(tok.error || 'Sign-in failed — try connecting again.');
      hasSession = true;
      await loadActivities(tok.access_token);
    }
  }catch(err){
    statusEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
  }
}

// show this site's domain in the DIY setup instructions
if($('cb-domain')) $('cb-domain').textContent = location.hostname || 'localhost';

// Return visit: if the httpOnly cookie holds a connection, swap it for a
// fresh access token silently — no redirect, no typing.
async function reconnectSaved(){
  try{
    const res = await fetch('/api/refresh', {method: 'POST'});
    if(!res.ok) return; // no saved connection — leave the connect button as-is
    const tok = await res.json();
    hasSession = true;
    await loadActivities(tok.access_token);
  }catch(_){ /* offline or API unavailable — leave the connect button as-is */ }
}

(async function initStrava(){
  if(!$('btn-oauth')) return; // not on the main page
  localStorage.removeItem('ss_saved_auth'); // credentials saved by a previous version of the app
  const params = new URLSearchParams(location.search);
  if(params.get('code') || params.get('error')) await handleOAuthReturn();
  else await reconnectSaved();
})();

on('btn-connect-strava', 'click', async () => {
  const token = $('strava-token').value.trim();
  const statusEl = $('strava-status');
  statusEl.innerHTML = '';
  if(!token){
    statusEl.innerHTML = '<div class="error">Paste a token first.</div>';
    return;
  }
  $('btn-connect-strava').disabled = true;
  $('btn-connect-strava').textContent = 'Loading…';
  try{
    await loadActivities(token);
  }catch(err){
    statusEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
  }finally{
    $('btn-connect-strava').disabled = false;
    $('btn-connect-strava').textContent = 'Use this token';
  }
});

function renderActivityList(){
  const list = $('activity-list');
  list.innerHTML = '';
  activities.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'activity';
    const dist = (a.distance/MI).toFixed(2);
    const date = parseLocalDate(a.start_date_local).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'});
    div.innerHTML = `<div>
        <div class="act-name">${esc(a.name)}</div>
        <div class="act-meta">${date} · ${dist} mi · ${fmtPace(a.average_speed)}</div>
      </div>`;
    div.addEventListener('click', () => {
      document.querySelectorAll('.activity').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      selectedActivity = a;
      checkReady();
    });
    list.appendChild(div);
  });
}

// ---------- STEP 2: Glucose CSV ----------
on('drop-zone', 'click', () => $('csv-input').click());
on('csv-input', 'change', (e) => {
  if(e.target.files[0]) handleCsvFile(e.target.files[0]);
});
const dropZone = $('drop-zone');
if(dropZone){
  ['dragenter','dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if(file) handleCsvFile(file);
  });
}
// Paste support: rows copied from any spreadsheet (or a CSV opened in a text
// editor) can be pasted anywhere on the page. Unparseable pastes are ignored
// so ordinary copy-paste elsewhere on the page never nags.
document.addEventListener('paste', (e) => {
  if(!$('drop-zone')) return; // not on the main page
  const tag = (e.target.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea') return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || !text.includes('\n')) return;
  try{
    const parsed = parseGlucoseCSV(text);
    glucoseRows = parsed.rows;
    glucoseUnit = parsed.unit;
    $('drop-label').textContent = 'Pasted data';
    $('glucose-status').innerHTML = '<div class="ok">Loaded ' + glucoseRows.length + ' glucose readings (' + glucoseUnit + ', pasted ' + parsed.source + ').</div>';
    $('card-glucose').classList.add('done');
    setStep(2,'complete');
    checkReady();
  }catch(_){ /* not glucose data — leave the page alone */ }
});

function handleCsvFile(file){
  $('drop-label').textContent = file.name;
  const reader = new FileReader();
  reader.onload = (evt) => {
    try{
      const parsed = parseGlucoseCSV(evt.target.result);
      glucoseRows = parsed.rows;
      glucoseUnit = parsed.unit;
      $('glucose-status').innerHTML = '<div class="ok">Loaded ' + glucoseRows.length + ' glucose readings (' + glucoseUnit + ', ' + parsed.source + ').</div>';
      $('card-glucose').classList.add('done');
      setStep(2,'complete');
      checkReady();
    }catch(err){
      $('glucose-status').innerHTML = '<div class="error">Couldn\'t read that CSV: ' + esc(err.message) + '</div>';
    }
  };
  reader.readAsText(file);
}

// Reads any supported CGM export: LibreView (FreeStyle Libre) and Dexcom
// Clarity are recognized explicitly; anything else falls through to a generic
// reader that hunts for a timestamp column and a glucose column.
function parseGlucoseCSV(text){
  const libre = parseLibreCSV(text);
  if(libre && libre.rows.length) return libre;
  let dex = null;
  try{ dex = parseDexcomCSV(text); }catch(_){}
  if(dex && dex.rows.length) return dex;
  const gen = parseGenericCSV(text);
  if(gen && gen.rows.length) return gen;
  throw new Error('couldn\'t recognize this as a CGM export — supported: Dexcom Clarity, LibreView (FreeStyle Libre), or any CSV with a timestamp column and a glucose column');
}

// "10-01-2026 12:04 PM" (LibreView), "10/01/2026 08:15", or ISO. Some exports
// put day before month — detectDayFirst() settles it from the data itself.
function parseFlexTimestamp(s, dayFirst){
  s = String(s || '').trim();
  const ymd = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i);
  if(ymd){
    const t = new Date(+ymd[1], +ymd[2] - 1, +ymd[3], +ymd[4], +ymd[5], +(ymd[6] || 0));
    return isNaN(t.getTime()) ? null : t;
  }
  const m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i);
  if(!m) return null;
  let h = +m[4];
  const ap = (m[7] || '').toUpperCase();
  if(ap === 'PM' && h < 12) h += 12;
  if(ap === 'AM' && h === 12) h = 0;
  const day = dayFirst ? +m[1] : +m[2], mon = dayFirst ? +m[2] : +m[1];
  const t = new Date(+m[3], mon - 1, day, h, +m[5], +(m[6] || 0));
  return isNaN(t.getTime()) ? null : t;
}

function detectDayFirst(samples){
  for(const s of samples){
    const m = String(s || '').trim().match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.]\d{4}/);
    if(!m) continue;
    if(+m[1] > 12) return true;
    if(+m[2] > 12) return false;
  }
  return false; // ambiguous — assume month-first, which matches AM/PM-style exports
}

// LibreView export: metadata line, then a header row with "Device Timestamp",
// "Record Type" (0 = automatic reading, 1 = manual scan) and "Historic
// Glucose" / "Scan Glucose" value columns.
function parseLibreCSV(text){
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  let headerIdx = -1, headers = [];
  for(let i = 0; i < Math.min(lines.length, 6); i++){
    if(lines[i].toLowerCase().includes('historic glucose')){
      headerIdx = i;
      headers = splitCsvLine(lines[i]).map(h => h.toLowerCase());
      break;
    }
  }
  if(headerIdx === -1) return null;
  const tsCol = headers.findIndex(h => h.includes('timestamp'));
  const typeCol = headers.findIndex(h => h.includes('record type'));
  const histCol = headers.findIndex(h => h.includes('historic glucose'));
  const scanCol = headers.findIndex(h => h.includes('scan glucose'));
  if(tsCol === -1 || histCol === -1) return null;
  const unit = headers[histCol].includes('mmol') ? 'mmol/L' : 'mg/dL';
  const dayFirst = detectDayFirst(lines.slice(headerIdx + 1, headerIdx + 40).map(l => splitCsvLine(l)[tsCol]));
  const rows = [];
  for(let i = headerIdx + 1; i < lines.length; i++){
    const cols = splitCsvLine(lines[i]);
    if(cols.length <= Math.max(tsCol, histCol)) continue;
    const type = typeCol !== -1 ? (cols[typeCol] || '').trim() : '0';
    const rawVal = type === '1' && scanCol !== -1 ? cols[scanCol] : type === '0' ? cols[histCol] : '';
    const val = parseFloat((rawVal || '').trim());
    if(isNaN(val)) continue;
    const t = parseFlexTimestamp(cols[tsCol], dayFirst);
    if(!t) continue;
    rows.push({t, val});
  }
  rows.sort((a, b) => a.t - b.t);
  return {rows, unit, source: 'LibreView'};
}

// Last resort for other meters (Medtronic CareLink etc.): find a header row
// with a glucose-ish column, then a timestamp column — or separate date and
// time columns — in the data below it.
function parseGenericCSV(text){
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const gRe = /glucose|blood sugar|sensor ?bg|\bsg\b|\bbg\b/i;
  for(let i = 0; i < Math.min(lines.length, 30); i++){
    const cells = splitCsvLine(lines[i]);
    const gCol = cells.findIndex(c => gRe.test(c));
    if(gCol === -1 || cells.length < 2) continue;
    const attempt = parseGenericFrom(lines, i, cells.map(h => h.toLowerCase()), gCol);
    if(attempt && attempt.rows.length) return attempt;
  }
  return null;
}

function parseGenericFrom(lines, headerIdx, headers, gCol){
  const sample = lines.slice(headerIdx + 1, headerIdx + 40).map(l => splitCsvLine(l));
  const firstValue = (c) => {
    for(const row of sample){
      const v = (row[c] || '').trim();
      if(v) return v;
    }
    return '';
  };
  let tsCol = -1, dateCol = -1, timeCol = -1;
  for(let c = 0; c < headers.length && tsCol === -1; c++){
    const v = firstValue(c);
    if(/^\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}[T ]\d{1,2}:\d{2}/.test(v) || /^\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4}[ ,]+\d{1,2}:\d{2}/.test(v)) tsCol = c;
  }
  if(tsCol === -1){
    for(let c = 0; c < headers.length; c++){
      const v = firstValue(c);
      if(dateCol === -1 && /^(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})$/.test(v)) dateCol = c;
      else if(timeCol === -1 && /^\d{1,2}:\d{2}(:\d{2})?\s*([AP]M)?$/i.test(v)) timeCol = c;
    }
    if(dateCol === -1 || timeCol === -1) return null;
  }
  const tsOf = (cols) => tsCol !== -1 ? cols[tsCol] : ((cols[dateCol] || '') + ' ' + (cols[timeCol] || ''));
  const dayFirst = detectDayFirst(sample.map(tsOf));
  const rows = [];
  let maxVal = 0;
  for(let i = headerIdx + 1; i < lines.length; i++){
    const cols = splitCsvLine(lines[i]);
    const val = parseFloat((cols[gCol] || '').trim());
    if(isNaN(val) || val <= 0) continue;
    const t = parseFlexTimestamp(tsOf(cols), dayFirst);
    if(!t) continue;
    rows.push({t, val});
    maxVal = Math.max(maxVal, val);
  }
  if(rows.length === 0) return null;
  const unit = headers[gCol].includes('mmol') || maxVal < 35 ? 'mmol/L' : 'mg/dL';
  rows.sort((a, b) => a.t - b.t);
  return {rows, unit, source: 'generic CSV'};
}

function parseDexcomCSV(text){
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  // Clarity localizes headers to the account language ("Zeitstempel",
  // "Glukosewert"...), but the unit string (mg/dL / mmol/L) is not translated —
  // so accept a header row by English names OR by the unit string.
  let headerIdx = -1, headers = [];
  for(let i=0;i<lines.length;i++){
    const lower = lines[i].toLowerCase();
    if((lower.includes('glucose value') && lower.includes('timestamp')) || lower.includes('mg/dl') || lower.includes('mmol/l')){
      headerIdx = i;
      headers = splitCsvLine(lines[i]).map(h => h.toLowerCase());
      break;
    }
  }
  if(headerIdx === -1) throw new Error('no header row with Timestamp / Glucose Value found — is this the Clarity CSV export?');

  // column order is locale-stable, so the first unit-bearing column is the
  // glucose value even when the fallback also matches "Rate of Change (mg/dL/min)"
  let valColIdx = headers.findIndex(h => h.includes('glucose value'));
  if(valColIdx === -1) valColIdx = headers.findIndex(h => h.includes('mg/dl') || h.includes('mmol'));
  const unit = headers[valColIdx].includes('mmol') ? 'mmol/L' : 'mg/dL';
  const evCol = headers.findIndex(h => h.includes('event type'));

  let tsCol = headers.findIndex(h => h.includes('timestamp'));
  if(tsCol === -1){
    // localized header: find the column whose data looks like an ISO timestamp
    const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    for(let i = headerIdx+1; i < Math.min(headerIdx+40, lines.length) && tsCol === -1; i++){
      const cols = splitCsvLine(lines[i]);
      tsCol = cols.findIndex(cell => isoRe.test(cell.trim()));
    }
  }
  if(tsCol === -1) throw new Error('couldn\'t find a timestamp column in that CSV');

  // Dexcom sensors clamp to 40–400 mg/dL (2.2–22.2 mmol/L); out-of-range
  // readings export as the words "Low"/"High"
  const sensorFloor = unit === 'mmol/L' ? 2.2 : 40;
  const sensorCeil = unit === 'mmol/L' ? 22.2 : 400;

  const rows = [];
  for(let i=headerIdx+1;i<lines.length;i++){
    const cols = splitCsvLine(lines[i]);
    if(cols.length <= Math.max(tsCol,valColIdx)) continue;
    if(evCol !== -1 && (cols[evCol]||'').trim().toLowerCase() === 'calibration') continue; // fingersticks, not sensor readings
    const rawVal = (cols[valColIdx]||'').trim();
    const rawTs = (cols[tsCol]||'').trim();
    if(!rawVal || !rawTs) continue;
    const lowerVal = rawVal.toLowerCase();
    const val = lowerVal === 'low' ? sensorFloor : lowerVal === 'high' ? sensorCeil : parseFloat(rawVal);
    if(isNaN(val)) continue;
    const t = new Date(rawTs.replace(' ','T'));
    if(isNaN(t.getTime())) continue;
    rows.push({t, val});
  }
  rows.sort((a,b) => a.t - b.t);
  // a real Clarity export has an Event Type column; without it this is more
  // likely the hand-filled template or another app using the same headers
  return {rows, unit, source: evCol !== -1 ? 'Dexcom Clarity' : 'CSV'};
}

function splitCsvLine(line){
  // simple split good enough for CGM exports (no embedded delimiters in
  // relevant fields); tabs cover data pasted straight from a spreadsheet
  return line.split(line.includes('\t') ? '\t' : ',').map(s => s.replace(/^"|"$/g,''));
}

function checkReady(){
  $('btn-generate').disabled = !(selectedActivity && glucoseRows);
}

// ---------- DEMO DATA ----------
function loadDemoData(){
  const now = new Date();
  const start = new Date(now.getTime() - 110*60*1000);
  const distanceM = 8046; // ~5 mi
  const elapsedSec = 45*60;

  const paces = [1609/(9.2*60), 1609/(8.9*60), 1609/(9.5*60), 1609/(8.6*60), 1609/(9.0*60)];
  selectedActivity = {
    _demo: true,
    name: 'Sunset Loop (demo)',
    type: 'Run',
    start_date_local: toLocalISO(start),
    elapsed_time: elapsedSec,
    moving_time: elapsedSec - 90,
    distance: distanceM,
    average_speed: distanceM / elapsedSec,
    total_elevation_gain: 14,
    average_heartrate: 158,
    calories: 420,
    splits_standard: paces.map((sp, i) => ({
      split: i+1,
      distance: i < 4 ? MI : distanceM - 4*MI,
      moving_time: (i < 4 ? MI : distanceM - 4*MI) / sp,
      average_speed: sp,
      elevation_difference: [1.2, -1.8, 3.7, -2.4, 0.6][i],
      average_heartrate: [148, 154, 161, 165, 159][i]
    }))
  };
  // demo route: a heart, obviously
  const heartPts = [];
  for(let t = 0; t <= Math.PI*2 + 0.01; t += Math.PI/48){
    heartPts.push([16*Math.pow(Math.sin(t), 3), -(13*Math.cos(t) - 5*Math.cos(2*t) - 2*Math.cos(3*t) - Math.cos(4*t))]);
  }
  selectedActivity._demoRoute = normalizeRoute(heartPts);

  // synthetic glucose curve: gentle pre-run rise, dip mid-run, recovery after
  const rows = [];
  const rangeStart = new Date(start.getTime() - 50*60*1000);
  const rangeEnd = new Date(start.getTime() + elapsedSec*1000 + 50*60*1000);
  let t = new Date(rangeStart);
  while(t <= rangeEnd){
    const minutesIn = (t - start)/60000;
    let val;
    if(minutesIn < 0){
      val = 100 + (minutesIn+50)*0.28; // slow pre-run climb
    } else if(minutesIn <= elapsedSec/60){
      val = 114 - minutesIn*0.75 + Math.sin(minutesIn/6)*4; // decline during run w/ wobble
    } else {
      const afterMin = minutesIn - elapsedSec/60;
      val = 80 + afterMin*0.55; // recovery after
    }
    val += (Math.random()-0.5)*3;
    rows.push({t: new Date(t), val: Math.round(val)});
    t = new Date(t.getTime() + 5*60*1000);
  }
  glucoseRows = rows;
  glucoseUnit = 'mg/dL';
}

// For pages that render the demo report directly (e.g. sample.html). The real
// button flow merges fetched detail into the activity, but fetchActivityDetail
// returns null for demo data, so buildReport(selectedActivity) is equivalent.
function generateDemoReport(){
  loadDemoData();
  buildReport(selectedActivity);
}

// ---------- GENERATE ----------
on('btn-generate', 'click', async () => {
  const btn = $('btn-generate');
  btn.disabled = true;
  btn.textContent = 'Building…';
  const detail = await fetchActivityDetail();
  buildReport(detail ? {...selectedActivity, ...detail} : selectedActivity);
  btn.disabled = false;
  btn.textContent = 'Generate report';
  $('report').scrollIntoView({behavior:'smooth', block:'start'});
});

// Detailed activity adds mile splits, calories, heart rate. Same read scope as
// the activity list; if it fails for any reason the report renders without them.
async function fetchActivityDetail(){
  if(selectedActivity._demo) return null;
  if(!stravaToken || !selectedActivity.id) return null;
  try{
    const res = await fetch('https://www.strava.com/api/v3/activities/' + selectedActivity.id, {
      headers: { 'Authorization': 'Bearer ' + stravaToken }
    });
    if(!res.ok) return null;
    return await res.json();
  }catch(_){
    return null;
  }
}

// ---------- glucose analysis ----------
function targetRange(){
  return glucoseUnit === 'mmol/L' ? [3.9, 10.0] : [70, 180];
}

function analyzeGlucose(rows, start, end){
  const [lo, hi] = targetRange();
  const win = rows.filter(r => r.t >= new Date(start.getTime()-PAD_MS) && r.t <= new Date(end.getTime()+PAD_MS));
  if(win.length === 0) return null;
  const pre = win.filter(r => r.t < start);
  const during = win.filter(r => r.t >= start && r.t <= end);
  const post = win.filter(r => r.t > end);
  const core = during.length ? during : win;
  const vals = core.map(r => r.val);
  const avg = vals.reduce((s,v)=>s+v,0)/vals.length;
  let minRow = core[0], maxRow = core[0];
  core.forEach(r => { if(r.val < minRow.val) minRow = r; if(r.val > maxRow.val) maxRow = r; });
  const inRange = vals.filter(v => v >= lo && v <= hi).length;
  const nLow = vals.filter(v => v < lo).length;
  return {
    win, pre, during, post, lo, hi,
    avg, minRow, maxRow,
    startVal: core[0].val,
    endVal: core[core.length-1].val,
    delta: core[core.length-1].val - core[0].val,
    tir: Math.round(100 * inRange / vals.length),
    tirLow: Math.round(100 * nLow / vals.length),
    tirHigh: Math.round(100 * (vals.length - inRange - nLow) / vals.length),
    swing: maxRow.val - minRow.val,
    minAtMin: Math.round((minRow.t - start)/60000)
  };
}

// ---------- REPORT ----------
function buildReport(a){
  const start = parseLocalDate(a.start_date_local);
  const durationSec = a.moving_time || a.elapsed_time;
  const end = new Date(start.getTime() + a.elapsed_time*1000);
  const g = analyzeGlucose(glucoseRows, start, end);

  if(!g){
    $('report').innerHTML = '<div class="card"><div class="error">No glucose readings overlap this run\'s time window — check the CSV covers the right day.</div></div>';
    return;
  }

  const distMi = a.distance/MI;
  const pace = fmtPace(a.average_speed);
  const dateStr = start.toLocaleDateString(undefined,{weekday:'long', month:'short', day:'numeric'});
  const deltaSign = g.delta > 0 ? '+' : '';
  const deltaTh = glucoseUnit === 'mmol/L' ? 0.83 : 15;
  const trendWord = g.delta > deltaTh ? 'climbed' : g.delta < -deltaTh ? 'dropped' : 'stayed steady';

  const splits = (a.splits_standard || []).filter(s => s.moving_time > 0 && s.distance > 200);
  // tag each split with its time window and the avg glucose inside it
  // (moving_time cumulated from the start — a close-enough approximation
  // unless the run had long pauses)
  let tCursor = start.getTime();
  splits.forEach(s => {
    s._t0 = tCursor;
    s._t1 = tCursor + s.moving_time*1000;
    const inWin = g.win.filter(r => r.t >= s._t0 && r.t <= s._t1);
    s._g = inWin.length ? inWin.reduce((sum,r) => sum+r.val, 0)/inWin.length : null;
    tCursor = s._t1;
  });

  const story = generateStory(a, g, start, end);
  const blurb = generateBlurb(g, distMi, pace, trendWord);
  const caption = generateCaption(g, distMi, pace, trendWord);
  const insights = generateInsights(g, splits, start, end);
  const badges = generateBadges(g, splits, start);
  const route = routePoints(a);
  const routeTile = route ? `
    <div class="stat">
      <div class="stat-label"><span class="stat-mark" style="background:var(--strava-ink)"></span>Route</div>
      <svg class="route-svg" viewBox="0 0 100 64" aria-hidden="true">
        <defs><linearGradient id="route-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#45e0c4"/><stop offset="1" stop-color="#ff5a2e"/>
        </linearGradient></defs>
        <polyline points="${routeFitPoints(route, 100, 64, 5).map(p => p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ')}"
          fill="none" stroke="url(#route-grad)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
    </div>` : '';

  const statTiles = [
    {label:'Distance', val: distMi.toFixed(2), unit:' mi', color:'var(--strava-ink)'},
    {label:'Time', val: fmtDur(durationSec), unit:'', color:'var(--strava-ink)'},
    {label:'Avg pace', val: pace.replace('/mi',''), unit:' /mi', color:'var(--strava-ink)'},
    a.total_elevation_gain > 0 ? {label:'Elev gain', val: Math.round(a.total_elevation_gain*3.281), unit:' ft', color:'var(--strava-ink)'} : null,
    a.average_heartrate ? {label:'Avg HR', val: Math.round(a.average_heartrate), unit:' bpm', color:'var(--strava-ink)'} : null,
    {label:'Avg glucose', val: fmtG(g.avg), unit:' '+glucoseUnit, color:'var(--glucose-ink)'},
    {label:'Range', val: fmtG(g.minRow.val)+'–'+fmtG(g.maxRow.val), unit:' '+glucoseUnit, sub:'low–high during run', color:'var(--glucose-ink)'},
    {label:'In range', val: g.tir, unit:' %', sub:'target '+fmtG(g.lo)+'–'+fmtG(g.hi), color:'var(--glucose-ink)'},
    {label:'Start → finish', val: deltaSign + fmtG(g.delta), unit:' '+glucoseUnit, sub: fmtG(g.startVal)+' → '+fmtG(g.endVal), color:'var(--glucose-ink)'}
  ].filter(Boolean);

  $('report').innerHTML = `
    <div class="report-hero reveal">
      <div class="hero-top">
        <div class="hero-name">${esc(a.name)}</div>
        <div class="hero-date">${dateStr}<br>${fmtClock(start)} – ${fmtClock(end)}</div>
      </div>
      ${badges.length ? `<div class="badges">${badges.map(b => `<span class="badge ${b.c}">${b.t}</span>`).join('')}</div>` : ''}

      <div class="stat-grid">
        ${statTiles.map(t => `
          <div class="stat">
            <div class="stat-label"><span class="stat-mark" style="background:${t.color}"></span>${t.label}</div>
            <div class="stat-val">${t.val}<small>${t.unit}</small></div>
            ${t.sub ? `<div class="stat-sub">${t.sub}</div>` : ''}
          </div>`).join('')}
        ${routeTile}
      </div>

      <div class="section-title">Glucose · ${glucoseUnit}</div>
      ${buildTirBar(g)}
      ${buildGlucoseChart(g, start, end)}
      <div class="chart-key">
        <span><span class="key-line"></span>glucose</span>
        <span><span class="key-band"></span>run window</span>
        <span><span class="key-target"></span>target ${fmtG(g.lo)}–${fmtG(g.hi)}</span>
      </div>

      ${splits.length >= 2 ? `
        <div class="section-title">Mile splits</div>
        <div class="splits">${buildSplits(splits)}</div>
        <div class="chart-key" style="margin-top:10px;">
          <span><span class="key-band" style="background:rgba(217,69,24,.42);border-color:rgba(217,69,24,.7);"></span>bar length = speed</span>
          <span style="color:var(--glucose)">right column = avg glucose (${glucoseUnit})</span>
        </div>` : ''}

      ${insights.length ? `
        <div class="section-title">Worth noticing</div>
        <div class="story">${insights.map(i => `
          <div class="insight"><span class="insight-icon">${i.icon}</span><div class="story-text">${i.text}</div></div>`).join('')}
        </div>` : ''}

      <div class="section-title">The story</div>
      <div class="story">${story}</div>

      <div class="blurb">${blurb}</div>

      <div class="caption-box">
        <div class="caption-text">"${esc(caption)}"</div>
        <button class="copy-btn" id="copy-caption">Copy</button>
      </div>

      <div class="row" style="margin-top:12px;">
        <button class="btn-strava" id="btn-share-img">Download share image</button>
        <span class="share-hint">1080×1350 — sized for a Strava activity photo; the caption above makes a nice description.</span>
      </div>

      ${buildTableView(g, splits, start, end)}
    </div>
  `;

  lastReport = {a, g, start, end, dateStr, distMi, pace, caption, badges, splits, route};
  attachChartInteraction(g, start, end);

  // the glucose line draws itself in
  const gline = $('gline');
  if(gline && matchMedia('(prefers-reduced-motion: no-preference)').matches){
    const len = gline.getTotalLength();
    gline.animate(
      [{strokeDasharray: len, strokeDashoffset: len}, {strokeDasharray: len, strokeDashoffset: 0}],
      {duration: 1400, easing: 'ease-out'}
    );
  }

  // hovering a mile split highlights that mile's window on the glucose chart
  document.querySelectorAll('.split-row').forEach((row, i) => {
    const s = splits[i];
    if(!s || !s._t0) return;
    row.addEventListener('mouseenter', () => {
      const hl = $('split-hl');
      if(!hl) return;
      const hx0 = Math.max(chartGeom.xOf(s._t0), CH.padL);
      const hx1 = Math.min(chartGeom.xOf(s._t1), CH.W - CH.padR);
      hl.setAttribute('x', hx0.toFixed(1));
      hl.setAttribute('width', Math.max(hx1 - hx0, 2).toFixed(1));
      hl.setAttribute('opacity', '0.18');
    });
    row.addEventListener('mouseleave', () => {
      const hl = $('split-hl');
      if(hl) hl.setAttribute('opacity', '0');
    });
  });

  $('copy-caption').addEventListener('click', () => {
    navigator.clipboard.writeText(caption);
    $('copy-caption').textContent = 'Copied!';
    setTimeout(()=> $('copy-caption').textContent = 'Copy', 1500);
  });

  $('btn-share-img').addEventListener('click', downloadShareImage);
}

// ---------- share image (1080x1350 canvas, Strava photo ratio) ----------
function wrapLines(ctx, text, maxW, maxLines){
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for(const w of words){
    const test = line ? line + ' ' + w : w;
    if(ctx.measureText(test).width > maxW && line){
      lines.push(line);
      line = w;
      if(lines.length === maxLines){ line = ''; lines[maxLines-1] += '…'; break; }
    } else {
      line = test;
    }
  }
  if(line && lines.length < maxLines) lines.push(line);
  return lines;
}

function roundedRectPath(ctx, rx, ry, rw, rh, rr){
  ctx.beginPath();
  ctx.moveTo(rx + rr, ry);
  ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, rr);
  ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, rr);
  ctx.arcTo(rx, ry + rh, rx, ry, rr);
  ctx.arcTo(rx, ry, rx + rw, ry, rr);
  ctx.closePath();
}

function renderShareCanvas(){
  const {a, g, start, end, dateStr, distMi, pace, badges, splits, route} = lastReport;
  const W = 1080, H = 1350, P = 84;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');

  const bg = x.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#171d27'); bg.addColorStop(1, '#10141b');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  const acc = x.createLinearGradient(0, 0, W, 0);
  acc.addColorStop(0, '#45e0c4'); acc.addColorStop(1, '#ff5a2e');
  x.fillStyle = acc; x.fillRect(0, 0, W, 10);

  // route silhouette, glowing, top-right (title wraps around it)
  if(route){
    const box = 250, rxb = W - P - box, ryb = 110;
    const pts = routeFitPoints(route, box, box, 14).map(([px, py]) => [rxb + px, ryb + py]);
    const rg = x.createLinearGradient(rxb, ryb, rxb + box, ryb + box);
    rg.addColorStop(0, '#45e0c4'); rg.addColorStop(1, '#ff5a2e');
    x.strokeStyle = rg; x.lineWidth = 5; x.lineJoin = 'round'; x.lineCap = 'round';
    x.shadowColor = 'rgba(69,224,196,.55)'; x.shadowBlur = 22;
    x.beginPath();
    pts.forEach(([px, py], i) => i === 0 ? x.moveTo(px, py) : x.lineTo(px, py));
    x.stroke();
    x.shadowBlur = 0;
  }

  let y = 128;
  x.fillStyle = '#45e0c4';
  x.font = '600 25px "JetBrains Mono", monospace';
  x.fillText('S P L I T S  &  S U G A R', P, y);

  x.fillStyle = '#f2f0ea';
  x.font = '700 66px Oswald, sans-serif';
  const titleMaxW = route ? W - 2*P - 290 : W - 2*P;
  const titleLines = wrapLines(x, a.name, titleMaxW, 2);
  y += 84;
  titleLines.forEach(l => { x.fillText(l, P, y); y += 76; });

  x.fillStyle = '#9aa4b4';
  x.font = '400 27px "JetBrains Mono", monospace';
  x.fillText(dateStr + '  ·  ' + fmtClock(start) + ' – ' + fmtClock(end), P, y);
  y += 60;

  if(badges && badges.length){
    x.font = '600 21px "JetBrains Mono", monospace';
    let bx = P;
    badges.forEach(b => {
      const label = b.t.toUpperCase();
      const tw = x.measureText(label).width;
      x.strokeStyle = b.c === 'orange' ? 'rgba(255,90,46,.7)' : 'rgba(69,224,196,.6)';
      x.lineWidth = 2;
      roundedRectPath(x, bx, y - 30, tw + 36, 44, 22);
      x.stroke();
      x.fillStyle = b.c === 'orange' ? '#ff5a2e' : '#45e0c4';
      x.fillText(label, bx + 18, y);
      bx += tw + 50;
    });
    y += 62;
  } else {
    y += 6;
  }

  // stats: an orange run row (3 cells) and a teal glucose row (4 cells);
  // the glucose unit lives in the chart header, so the teal values stay bare
  const rowDefs = [
    {color:'#ff5a2e', valPx: 54, cols: [
      ['DISTANCE', distMi.toFixed(2), ' mi'],
      ['AVG PACE', pace.replace('/mi',''), ' /mi'],
      ['TIME', fmtDur(a.moving_time || a.elapsed_time), '']
    ]},
    {color:'#45e0c4', valPx: 46, cols: [
      ['AVG GLUCOSE', fmtG(g.avg), ''],
      ['RANGE', fmtG(g.minRow.val) + '–' + fmtG(g.maxRow.val), ''],
      ['IN RANGE', null, ''], // rendered as the ring gauge
      ['START → FINISH', (g.delta > 0 ? '+' : '') + fmtG(g.delta), '']
    ]}
  ];
  const rowH = 148;
  rowDefs.forEach((row, ri) => {
    const colW = (W - 2*P) / row.cols.length;
    row.cols.forEach(([label, val, unit], ci) => {
      const sx = P + ci * colW, sy = y + ri * rowH;
      x.fillStyle = row.color; x.fillRect(sx, sy - 16, 16, 16);
      x.fillStyle = '#6b7686';
      x.font = '500 21px "JetBrains Mono", monospace';
      x.fillText(label, sx + 26, sy);
      if(val === null){
        // in-range ring gauge
        const rcx = sx + 52, rcy = sy + 60, rr = 40;
        x.strokeStyle = 'rgba(29,168,143,.22)'; x.lineWidth = 10;
        x.beginPath(); x.arc(rcx, rcy, rr, 0, Math.PI*2); x.stroke();
        x.strokeStyle = '#45e0c4'; x.lineCap = 'round';
        x.shadowColor = 'rgba(69,224,196,.6)'; x.shadowBlur = 12;
        x.beginPath(); x.arc(rcx, rcy, rr, -Math.PI/2, -Math.PI/2 + Math.PI*2*(g.tir/100));
        x.stroke();
        x.shadowBlur = 0;
        x.fillStyle = '#f2f0ea';
        x.font = '700 26px Inter, sans-serif';
        const pt = g.tir + '%';
        x.fillText(pt, rcx - x.measureText(pt).width/2, rcy + 9);
        return;
      }
      x.fillStyle = '#f2f0ea';
      x.font = '700 ' + row.valPx + 'px Inter, sans-serif';
      x.fillText(val, sx, sy + 62);
      const vw = x.measureText(val).width;
      if(unit){
        x.fillStyle = '#9aa4b4';
        x.font = '500 26px Inter, sans-serif';
        x.fillText(unit, sx + vw + 6, sy + 62);
      }
    });
  });
  y += 2 * rowH + 30;

  // chart — fills the canvas down to the splits strip (or the bottom margin)
  const stripSplits = splits && splits.length >= 2 && splits.length <= 14 ? splits : null;
  const cy0 = y + 36, cy1 = stripSplits ? H - 264 : H - 96, cx0 = P, cx1 = W - P;
  x.fillStyle = '#6b7686';
  x.font = '500 22px "JetBrains Mono", monospace';
  x.fillText('GLUCOSE · ' + glucoseUnit.toUpperCase(), cx0, y);
  const tgt = 'TARGET ' + fmtG(g.lo) + '–' + fmtG(g.hi);
  x.fillText(tgt, cx1 - x.measureText(tgt).width, y);

  const rows = g.win;
  const t0 = rows[0].t.getTime(), t1 = rows[rows.length-1].t.getTime();
  const span = Math.max(t1 - t0, 1);
  const vPad = glucoseUnit === 'mmol/L' ? 0.8 : 12;
  const vMin = Math.min(...rows.map(r=>r.val)) - vPad;
  const vMax = Math.max(...rows.map(r=>r.val)) + vPad;
  const cxOf = t => cx0 + (t - t0)/span * (cx1 - cx0);
  const cyOf = v => cy1 - (v - vMin)/(vMax - vMin) * (cy1 - cy0);

  // run window band
  const rx0 = Math.max(cxOf(start.getTime()), cx0), rx1 = Math.min(cxOf(end.getTime()), cx1);
  x.fillStyle = 'rgba(217,69,24,0.12)';
  x.fillRect(rx0, cy0, Math.max(rx1 - rx0, 2), cy1 - cy0);
  x.strokeStyle = 'rgba(255,90,46,0.8)'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(rx0, cy0); x.lineTo(rx0, cy1); x.moveTo(rx1, cy0); x.lineTo(rx1, cy1); x.stroke();
  x.fillStyle = '#9aa4b4';
  x.font = '500 22px "JetBrains Mono", monospace';
  x.fillText('start', rx0 + 10, cy0 + 30);
  x.fillText('finish', rx1 - x.measureText('finish').width - 10, cy0 + 30);

  // target range lines
  x.strokeStyle = '#6b7686'; x.lineWidth = 2; x.setLineDash([8, 8]);
  [g.lo, g.hi].forEach(v => {
    if(v > vMin && v < vMax){
      const ly = cyOf(v);
      x.beginPath(); x.moveTo(cx0, ly); x.lineTo(cx1, ly); x.stroke();
    }
  });
  x.setLineDash([]);

  // area (fades downward) + neon line
  const areaGrad = x.createLinearGradient(0, cy0, 0, cy1);
  areaGrad.addColorStop(0, 'rgba(69,224,196,.28)');
  areaGrad.addColorStop(1, 'rgba(69,224,196,0)');
  x.beginPath();
  rows.forEach((r, i) => { const px = cxOf(r.t.getTime()), py = cyOf(r.val); i === 0 ? x.moveTo(px, py) : x.lineTo(px, py); });
  x.lineTo(cxOf(t1), cy1); x.lineTo(cxOf(t0), cy1); x.closePath();
  x.fillStyle = areaGrad; x.fill();
  x.beginPath();
  rows.forEach((r, i) => { const px = cxOf(r.t.getTime()), py = cyOf(r.val); i === 0 ? x.moveTo(px, py) : x.lineTo(px, py); });
  x.strokeStyle = '#45e0c4'; x.lineWidth = 5; x.lineJoin = 'round'; x.lineCap = 'round';
  x.shadowColor = 'rgba(69,224,196,.75)'; x.shadowBlur = 18;
  x.stroke();
  x.shadowBlur = 0;

  // low point
  const lx = cxOf(g.minRow.t.getTime()), lyv = cyOf(g.minRow.val);
  x.fillStyle = '#10141b'; x.beginPath(); x.arc(lx, lyv, 12, 0, Math.PI*2); x.fill();
  x.fillStyle = '#45e0c4';
  x.shadowColor = 'rgba(69,224,196,.9)'; x.shadowBlur = 14;
  x.beginPath(); x.arc(lx, lyv, 8, 0, Math.PI*2); x.fill();
  x.shadowBlur = 0;
  x.fillStyle = '#9aa4b4';
  x.font = '500 24px "JetBrains Mono", monospace';
  const lowLabel = 'low ' + fmtG(g.minRow.val);
  const labelAbove = lyv > cy1 - 44;
  x.fillText(lowLabel, Math.min(Math.max(lx - x.measureText(lowLabel).width/2, cx0), cx1 - x.measureText(lowLabel).width), labelAbove ? lyv - 24 : lyv + 44);

  // mile-splits strip along the bottom: pace + avg glucose per mile, fastest lit up
  if(stripSplits){
    const n = stripSplits.length;
    const gap = 8, segW = (cx1 - cx0 - gap*(n-1))/n, segY = H - 192;
    const maxSp = Math.max(...stripSplits.map(s => s.average_speed));
    x.fillStyle = '#6b7686';
    x.font = '500 22px "JetBrains Mono", monospace';
    x.fillText('MILE SPLITS', cx0, segY - 24);
    const key = 'PACE · AVG GLUCOSE (' + glucoseUnit.toUpperCase() + ')';
    x.fillText(key, cx1 - x.measureText(key).width, segY - 24);
    stripSplits.forEach((s, i) => {
      const sx = cx0 + i*(segW + gap);
      const fastest = s.average_speed === maxSp;
      if(fastest){ x.shadowColor = 'rgba(255,90,46,.8)'; x.shadowBlur = 16; }
      x.fillStyle = fastest ? '#ff5a2e' : 'rgba(217,69,24,.4)';
      roundedRectPath(x, sx, segY, segW, 16, 8);
      x.fill();
      x.shadowBlur = 0;
      x.fillStyle = fastest ? '#f2f0ea' : '#9aa4b4';
      x.font = (fastest ? '600' : '500') + ' 23px "JetBrains Mono", monospace';
      const pl = fmtPace(s.average_speed).replace('/mi','');
      x.fillText(pl, sx + segW/2 - x.measureText(pl).width/2, segY + 50);
      x.fillStyle = '#45e0c4';
      x.font = '500 23px "JetBrains Mono", monospace';
      const gl = s._g != null ? fmtG(s._g) : '—';
      x.fillText(gl, sx + segW/2 - x.measureText(gl).width/2, segY + 86);
    });
  }

  return c;
}

async function downloadShareImage(){
  if(!lastReport) return;
  const btn = $('btn-share-img');
  btn.disabled = true; btn.textContent = 'Rendering…';
  try{
    await document.fonts.ready;
    const canvas = renderShareCanvas();
    await new Promise(resolve => canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement('a');
      aEl.href = url;
      aEl.download = 'splits-and-sugar.png';
      aEl.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      resolve();
    }, 'image/png'));
  }finally{
    btn.disabled = false; btn.textContent = 'Download share image';
  }
}

// ---------- route silhouette ----------
// Standard encoded-polyline decoder (Strava's map.summary_polyline).
function decodePolyline(str){
  let idx = 0, lat = 0, lng = 0;
  const pts = [];
  while(idx < str.length){
    for(const which of [0, 1]){
      let shift = 0, result = 0, b;
      do{
        b = str.charCodeAt(idx++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      }while(b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if(which === 0) lat += d; else lng += d;
    }
    pts.push([lat * 1e-5, lng * 1e-5]);
  }
  return pts;
}

// shift to origin and scale so the largest dimension is 1 (aspect preserved)
function normalizeRoute(pts){
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
  const s = 1 / Math.max(w, h, 1e-9);
  return {pts: pts.map(p => [(p[0]-x0)*s, (p[1]-y0)*s]), w: w*s, h: h*s};
}

function routePoints(a){
  if(a._demoRoute) return a._demoRoute;
  const enc = a.map && (a.map.summary_polyline || a.map.polyline);
  if(!enc) return null;
  const ll = decodePolyline(enc);
  if(ll.length < 2) return null;
  // equirectangular projection: x = lng·cos(midLat), y = −lat (screen y grows down)
  const midLat = (ll.reduce((s,p) => s + p[0], 0)/ll.length) * Math.PI/180;
  return normalizeRoute(ll.map(([la, ln]) => [ln * Math.cos(midLat), -la]));
}

// fit the normalized route into a w×h box (centered), return "x,y x,y …"
function routeFitPoints(route, w, h, pad){
  const availW = w - 2*pad, availH = h - 2*pad;
  const s = Math.min(availW/route.w, availH/route.h);
  const ox = pad + (availW - route.w*s)/2, oy = pad + (availH - route.h*s)/2;
  return route.pts.map(([px, py]) => [ox + px*s, oy + py*s]);
}

// ---------- time-in-range bar ----------
function buildTirBar(g){
  const segs = [
    {key:'low',  pct: g.tirLow,  label:'below'},
    {key:'in',   pct: g.tir,     label:'in range'},
    {key:'high', pct: g.tirHigh, label:'above'}
  ].filter(s => s.pct > 0);
  return `
  <div class="tir-bar" aria-hidden="true">
    ${segs.map(s => `<div class="tir-seg ${s.key}" style="flex:${s.pct}"></div>`).join('')}
  </div>
  <div class="tir-labels">
    ${segs.map(s => `<span><span class="tir-dot ${s.key}"></span>${s.label} ${s.pct}%</span>`).join('')}
  </div>`;
}

// ---------- insights & badges ----------
// Data-driven observations, worded as patterns to notice — not advice.
function generateInsights(g, splits, start, end){
  const mmol = glucoseUnit === 'mmol/L';
  const out = [];
  const dur = g.during;

  // steepest sustained drop: most negative slope over any ~10–20 min stretch
  let drop = null;
  for(let i = 0; i < dur.length; i++){
    for(let j = i+1; j < dur.length; j++){
      const dt = (dur[j].t - dur[i].t)/60000;
      if(dt < 9) continue;
      if(dt > 21) break;
      const rate = (dur[j].val - dur[i].val)/dt;
      if(!drop || rate < drop.rate){
        drop = {rate, at: Math.round(((dur[i].t.getTime() + dur[j].t.getTime())/2 - start.getTime())/60000)};
      }
    }
  }

  if(g.tir === 100 && dur.length >= 3){
    out.push({icon:'🖼️', text:'Every single reading stayed in range — frame this one.'});
  }
  if(g.minRow.val < g.lo){
    const rec = g.post.find(r => r.val >= g.lo);
    out.push({icon:'🩹', text: rec
      ? `Glucose slipped below range around minute ${Math.max(g.minAtMin,0)} but was back inside within ${Math.max(Math.round((rec.t - end)/60000),1)} minutes of stopping — a tidy comeback.`
      : `Glucose slipped below range around minute ${Math.max(g.minAtMin,0)} and hadn't recovered by the end of the window — worth keeping fast carbs closer next time.`});
  }
  const dropTh = mmol ? 0.055 : 1.0;
  if(drop && drop.rate <= -dropTh){
    const perMin = Math.abs(mmol ? drop.rate.toFixed(2) : drop.rate.toFixed(1));
    out.push({icon:'📉', text:`The steepest slide was ~<b>${perMin} ${glucoseUnit} per minute</b> around minute ${drop.at}. If that pattern repeats, taking fuel about 15 minutes before that point is the classic counter-move.`});
  }
  const fullSplits = splits.filter(s => s.distance >= MI*0.95);
  if(fullSplits.length >= 2){
    const slowest = fullSplits.reduce((worst, s) => s.average_speed < worst.average_speed ? s : worst);
    const minT = g.minRow.t.getTime();
    if(minT >= slowest._t0 - 3*60000 && minT <= slowest._t1 + 3*60000){
      const idx = splits.indexOf(slowest) + 1;
      out.push({icon:'🐢', text:`The slowest mile (${idx}, ${fmtPace(slowest.average_speed)}) lined up with the glucose low — legs listen to sugar.`});
    }
  }
  if(fullSplits.length >= 4){
    const half = Math.floor(fullSplits.length/2);
    const avgSp = arr => arr.reduce((s,x) => s + x.average_speed, 0)/arr.length;
    const secFaster = MI/avgSp(fullSplits.slice(0, half)) - MI/avgSp(fullSplits.slice(-half));
    if(secFaster > 5){
      out.push({icon:'⚡', text:`Negative split — the back half averaged <b>${Math.round(secFaster)} seconds per mile faster</b> than the front. Strong finish.`});
    }
  }
  if(g.post.length >= 2){
    const pd = g.post[g.post.length-1].val - g.post[0].val;
    const pmin = Math.round((g.post[g.post.length-1].t - end)/60000);
    if(pd > (mmol ? 1.7 : 30)){
      out.push({icon:'🔁', text:`Glucose rebounded <b>+${fmtG(pd)} ${glucoseUnit}</b> in the ${pmin} minutes after stopping — the classic post-run bounce, a pattern worth watching across runs.`});
    }
  }
  if(out.length < 4 && g.pre.length >= 2){
    const preDelta = g.pre[g.pre.length-1].val - g.pre[0].val;
    if(Math.abs(preDelta) <= (mmol ? 0.55 : 10) && g.pre[g.pre.length-1].val >= g.lo){
      out.push({icon:'🎯', text:'A flat, in-range warm-up — arriving at the start line steady is half the battle.'});
    }
  }
  return out.slice(0, 4);
}

function generateBadges(g, splits, start){
  const mmol = glucoseUnit === 'mmol/L';
  const b = [];
  if(g.tir === 100 && g.during.length >= 3) b.push({t:'100% in range', c:'teal'});
  if(g.swing < (mmol ? 1.4 : 25) && g.during.length >= 3) b.push({t:'flatline legend', c:'teal'});
  if(g.minRow.val < g.lo && g.endVal >= g.lo) b.push({t:'comeback', c:'teal'});
  const fullSplits = splits.filter(s => s.distance >= MI*0.95);
  if(fullSplits.length >= 4){
    const half = Math.floor(fullSplits.length/2);
    const avgSp = arr => arr.reduce((s,x) => s + x.average_speed, 0)/arr.length;
    if(MI/avgSp(fullSplits.slice(0, half)) - MI/avgSp(fullSplits.slice(-half)) > 5) b.push({t:'negative split', c:'orange'});
  }
  const h = start.getHours();
  if(h < 7) b.push({t:'sunrise run', c:'orange'});
  else if(h >= 21) b.push({t:'night owl', c:'orange'});
  return b.slice(0, 3);
}

// ---------- narrative ----------
function trendPhrase(delta){
  const th = glucoseUnit === 'mmol/L' ? 0.6 : 10;
  if(delta > th) return 'climbing';
  if(delta < -th) return 'drifting down';
  return 'holding steady';
}
function trendPast(delta){
  const th = glucoseUnit === 'mmol/L' ? 0.6 : 10;
  if(delta > th) return 'climbed';
  if(delta < -th) return 'drifted down';
  return 'held steady';
}

function generateStory(a, g, start, end){
  const blocks = [];
  if(g.pre.length >= 2){
    const preDelta = g.pre[g.pre.length-1].val - g.pre[0].val;
    const preMin = Math.round((start - g.pre[0].t)/60000);
    blocks.push({when:'Before', text:
      `Toeing the start line, glucose was <b>${fmtG(g.pre[g.pre.length-1].val)} ${glucoseUnit}</b>, ${trendPhrase(preDelta)} through the ${preMin} minutes before.`});
  }
  if(g.during.length >= 1){
    const lowBit = g.minRow.val < g.lo
      ? `It dipped below range to <b>${fmtG(g.minRow.val)}</b> around minute ${Math.max(g.minAtMin,0)} — worth a glance at fueling next time.`
      : `The low point was <b>${fmtG(g.minRow.val)}</b> around minute ${Math.max(g.minAtMin,0)}, still inside the target range.`;
    blocks.push({when:'During', text:
      `Across the run itself glucose ${trendPast(g.delta)}, with <b>${g.tir}%</b> of readings in range. ${lowBit}`});
  }
  if(g.post.length >= 2){
    const postDelta = g.post[g.post.length-1].val - g.post[0].val;
    const postMin = Math.round((g.post[g.post.length-1].t - end)/60000);
    blocks.push({when:'After', text:
      `In the ${postMin} minutes after the run, glucose was ${trendPhrase(postDelta)}, finishing the window at <b>${fmtG(g.post[g.post.length-1].val)} ${glucoseUnit}</b>.`});
  }
  if(a.average_heartrate){
    blocks.push({when:'Effort', text:
      `Average heart rate was <b>${Math.round(a.average_heartrate)} bpm</b>${a.total_elevation_gain > 0 ? ` over ${Math.round(a.total_elevation_gain*3.281)} ft of climbing` : ''}${a.calories ? `, burning roughly ${Math.round(a.calories)} calories` : ''}.`});
  }
  return blocks.map(b => `
    <div class="story-block">
      <div class="story-when">${b.when}</div>
      <div class="story-text">${b.text}</div>
    </div>`).join('');
}

function generateBlurb(g, distMi, pace, trendWord){
  const swingNote = g.swing < (glucoseUnit==='mmol/L'?1.7:30) ? 'nice and stable the whole way'
    : g.swing < (glucoseUnit==='mmol/L'?3.3:60) ? 'with some natural movement'
    : 'swinging around a fair bit';
  const th = glucoseUnit === 'mmol/L' ? 0.83 : 15;
  const emoji = g.delta > th ? '📈' : g.delta < -th ? '📉' : '➡️';
  return `${emoji} Over ${distMi.toFixed(1)} miles at ${pace}, glucose averaged ${fmtG(g.avg)} ${glucoseUnit} and ${trendWord} from start to finish, ${swingNote} — ${g.tir}% of the run in range.`;
}

function generateCaption(g, distMi, pace, trendWord){
  const templates = [
    `${distMi.toFixed(1)} miles at ${pace}, ${g.tir}% in range — running on more than just willpower today.`,
    `Legs at ${pace}, sugar ${trendWord} — a solid team effort out there.`,
    `${distMi.toFixed(1)} miles down, glucose ${fmtG(g.startVal)} → ${fmtG(g.endVal)} — the numbers behaved today.`,
    `Pancreas on manual mode, ${distMi.toFixed(1)} miles anyway. ${g.tir}% in range.`,
    `Fueled, paced, and ${g.tir}% in range — call it a win.`,
    `${pace} splits with a side of glucose graphs.`
  ];
  return templates[Math.floor(Math.random()*templates.length)];
}

// ---------- glucose chart ----------
const CH = { W: 720, H: 280, padL: 48, padR: 14, padT: 16, padB: 32 };
let chartGeom = null; // set at build time, used by the interaction layer

function niceTicks(lo, hi, n){
  const span = (hi - lo) || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(span/n)));
  const norm = span/n/mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const ticks = [];
  for(let v = Math.ceil(lo/step)*step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

function buildGlucoseChart(g, start, end){
  const {W, H, padL, padR, padT, padB} = CH;
  const rows = g.win;
  const t0 = rows[0].t.getTime(), t1 = rows[rows.length-1].t.getTime();
  const span = Math.max(t1 - t0, 1);
  const vPad = glucoseUnit === 'mmol/L' ? 0.8 : 12;
  const vMin = Math.min(...rows.map(r=>r.val)) - vPad;
  const vMax = Math.max(...rows.map(r=>r.val)) + vPad;

  const xOf = t => padL + (t - t0)/span * (W - padL - padR);
  const yOf = v => H - padB - (v - vMin)/(vMax - vMin) * (H - padT - padB);
  chartGeom = {t0, t1, xOf, yOf};

  const runX0 = Math.max(xOf(start.getTime()), padL);
  const runX1 = Math.min(xOf(end.getTime()), W - padR);

  let path = '';
  rows.forEach((r,i) => {
    path += (i===0 ? 'M' : 'L') + xOf(r.t.getTime()).toFixed(1) + ',' + yOf(r.val).toFixed(1) + ' ';
  });
  const area = path + 'L' + xOf(t1).toFixed(1) + ',' + (H-padB) + ' L' + xOf(t0).toFixed(1) + ',' + (H-padB) + ' Z';

  // y ticks: clean numbers, hairline solid grid
  const yTicks = niceTicks(vMin, vMax, 4);
  let grid = '', yLabels = '';
  yTicks.forEach(v => {
    const y = yOf(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#222a37" stroke-width="1"/>`;
    yLabels += `<text x="${padL-8}" y="${y}" dy="3.5" fill="#6b7686" font-size="10.5" text-anchor="end" font-family="JetBrains Mono, monospace">${glucoseUnit==='mmol/L' ? v : Math.round(v)}</text>`;
  });

  // x ticks: clock times on clean boundaries
  const spanMin = span/60000;
  const stepMin = spanMin > 180 ? 60 : spanMin > 90 ? 30 : spanMin > 45 ? 15 : 10;
  let xLabels = '';
  let tick = new Date(t0);
  tick.setSeconds(0,0);
  tick.setMinutes(Math.ceil(tick.getMinutes()/stepMin)*stepMin);
  while(tick.getTime() <= t1){
    xLabels += `<text x="${xOf(tick.getTime()).toFixed(1)}" y="${H-padB+16}" fill="#6b7686" font-size="10.5" text-anchor="middle" font-family="JetBrains Mono, monospace">${fmtClock(tick)}</text>`;
    tick = new Date(tick.getTime() + stepMin*60000);
  }

  // target range: dashed threshold lines (only where they fall inside the plot)
  let target = '';
  [g.lo, g.hi].forEach(v => {
    if(v > vMin && v < vMax){
      const y = yOf(v).toFixed(1);
      target += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#6b7686" stroke-width="1.5" stroke-dasharray="4,4" opacity=".55"/>`;
    }
  });

  // low-point marker: dot with surface ring + selective direct label
  const minX = xOf(g.minRow.t.getTime()), minY = yOf(g.minRow.val);
  const labelAbove = minY > H - padB - 26;
  const lowMark = `
    <circle cx="${minX.toFixed(1)}" cy="${minY.toFixed(1)}" r="6" fill="#10141b"/>
    <circle cx="${minX.toFixed(1)}" cy="${minY.toFixed(1)}" r="4" fill="#1da88f"/>
    <text x="${minX.toFixed(1)}" y="${(labelAbove ? minY - 12 : minY + 20).toFixed(1)}" fill="#9aa4b4" font-size="10.5" text-anchor="middle" font-family="JetBrains Mono, monospace">low ${fmtG(g.minRow.val)}</text>`;

  return `
  <div class="chart-wrap" id="chart-wrap" tabindex="0" role="img"
       aria-label="Glucose over time around the run. Low of ${fmtG(g.minRow.val)} ${glucoseUnit}. Full data in the table below. Use arrow keys to step through readings.">
    <svg id="gchart" viewBox="0 0 ${W} ${H}">
      ${grid}
      <rect x="${runX0.toFixed(1)}" y="${padT}" width="${Math.max(runX1-runX0,2).toFixed(1)}" height="${H-padT-padB}" fill="#d94518" opacity="0.09"/>
      <line x1="${runX0.toFixed(1)}" y1="${padT}" x2="${runX0.toFixed(1)}" y2="${H-padB}" stroke="#d94518" stroke-width="1"/>
      <line x1="${runX1.toFixed(1)}" y1="${padT}" x2="${runX1.toFixed(1)}" y2="${H-padB}" stroke="#d94518" stroke-width="1"/>
      <text x="${(runX0+5).toFixed(1)}" y="${padT+12}" fill="#9aa4b4" font-size="10" font-family="JetBrains Mono, monospace">start</text>
      <text x="${(runX1-5).toFixed(1)}" y="${padT+12}" fill="#9aa4b4" font-size="10" text-anchor="end" font-family="JetBrains Mono, monospace">finish</text>
      ${target}
      <rect id="split-hl" y="${padT}" height="${H-padT-padB}" x="0" width="0" fill="#ff5a2e" opacity="0" style="transition:opacity .2s ease" pointer-events="none"/>
      <path d="${area}" fill="#1da88f" opacity="0.09"/>
      <path id="gline" d="${path}" fill="none" stroke="#1da88f" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${lowMark}
      ${yLabels}
      ${xLabels}
      <g id="cross" style="display:none">
        <line id="cross-line" y1="${padT}" y2="${H-padB}" stroke="#9aa4b4" stroke-width="1"/>
        <circle id="cross-ring" r="6" fill="#10141b"/>
        <circle id="cross-dot" r="4" fill="#1da88f"/>
      </g>
    </svg>
    <div class="tooltip" id="gtip">
      <div class="tt-val" id="tt-val"></div>
      <div class="tt-time" id="tt-time"></div>
      <div class="tt-phase" id="tt-phase"></div>
    </div>
  </div>`;
}

function attachChartInteraction(g, start, end){
  const wrap = $('chart-wrap'), svg = $('gchart'), tip = $('gtip'), cross = $('cross');
  const rows = g.win;
  let idx = -1;

  function show(i){
    idx = Math.max(0, Math.min(rows.length-1, i));
    const r = rows[idx];
    const x = chartGeom.xOf(r.t.getTime()), y = chartGeom.yOf(r.val);
    cross.style.display = '';
    $('cross-line').setAttribute('x1', x); $('cross-line').setAttribute('x2', x);
    $('cross-ring').setAttribute('cx', x); $('cross-ring').setAttribute('cy', y);
    $('cross-dot').setAttribute('cx', x);  $('cross-dot').setAttribute('cy', y);

    // tooltip content via textContent — CSV/API strings are untrusted
    $('tt-val').textContent = '';
    $('tt-val').appendChild(document.createTextNode(fmtG(r.val) + ' '));
    const u = document.createElement('small'); u.textContent = glucoseUnit;
    $('tt-val').appendChild(u);
    $('tt-time').textContent = fmtClock(r.t);
    $('tt-phase').textContent = r.t < start ? 'before the run' : r.t > end ? 'after the run' : 'during the run';

    const rect = svg.getBoundingClientRect();
    const px = x/CH.W * rect.width, py = y/CH.H * rect.height;
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    let left = px + 14;
    if(left + tw > rect.width) left = px - tw - 14;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = Math.max(0, py - 64) + 'px';
  }
  function hide(){ idx = -1; cross.style.display = 'none'; tip.style.display = 'none'; }

  // crosshair snaps to the nearest reading — readers aim at a time, not a 2px line
  svg.addEventListener('pointermove', e => {
    const rect = svg.getBoundingClientRect();
    const vx = (e.clientX - rect.left)/rect.width * CH.W;
    const t = chartGeom.t0 + (vx - CH.padL)/(CH.W - CH.padL - CH.padR) * (chartGeom.t1 - chartGeom.t0);
    let best = 0, bestD = Infinity;
    rows.forEach((r,i) => { const d = Math.abs(r.t.getTime() - t); if(d < bestD){ bestD = d; best = i; } });
    show(best);
  });
  svg.addEventListener('pointerleave', hide);
  wrap.addEventListener('keydown', e => {
    if(e.key === 'ArrowRight'){ show(idx < 0 ? 0 : idx+1); e.preventDefault(); }
    else if(e.key === 'ArrowLeft'){ show(idx < 0 ? rows.length-1 : idx-1); e.preventDefault(); }
    else if(e.key === 'Escape'){ hide(); }
  });
  wrap.addEventListener('blur', hide);
}

// ---------- splits ----------
function buildSplits(splits){
  const speeds = splits.map(s => s.average_speed);
  const maxSp = Math.max(...speeds);
  const fastest = speeds.indexOf(maxSp);
  return splits.map((s, i) => {
    const pct = Math.max(4, (s.average_speed / maxSp) * 100);
    const partial = s.distance < MI * 0.95;
    const label = partial ? (s.distance/MI).toFixed(1) + ' mi' : (i+1) + ' mi';
    return `
    <div class="split-row${i === fastest ? ' fastest' : ''}">
      <div class="split-mi">${label}</div>
      <div class="split-track"><div class="split-bar" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="split-pace">${fmtPace(s.average_speed).replace('/mi','')}${i === fastest ? '<span class="split-tag">fastest</span>' : ''}</div>
      <div class="split-g">${s._g != null ? fmtG(s._g) : '—'}</div>
    </div>`;
  }).join('');
}

// ---------- table view (accessibility twin of the charts) ----------
function buildTableView(g, splits, start, end){
  const gRows = g.win.map(r =>
    `<tr><td>${fmtClock(r.t)}</td><td>${fmtG(r.val)}</td><td>${r.t < start ? 'before' : r.t > end ? 'after' : 'run'}</td></tr>`).join('');
  const sRows = splits.map((s,i) =>
    `<tr><td>${i+1}</td><td>${fmtPace(s.average_speed)}</td><td>${s._g != null ? fmtG(s._g) : '—'}</td><td>${s.elevation_difference != null ? Math.round(s.elevation_difference*3.281) + ' ft' : '—'}</td><td>${s.average_heartrate ? Math.round(s.average_heartrate) + ' bpm' : '—'}</td></tr>`).join('');
  return `
  <details class="tableview">
    <summary>View the data as a table</summary>
    <div class="tbl-scroll">
      <table class="data">
        <caption>Glucose readings (${glucoseUnit})</caption>
        <thead><tr><th>Time</th><th>Glucose</th><th>Phase</th></tr></thead>
        <tbody>${gRows}</tbody>
      </table>
    </div>
    ${splits.length ? `
    <div class="tbl-scroll">
      <table class="data">
        <caption>Mile splits</caption>
        <thead><tr><th>Mile</th><th>Pace</th><th>Avg glucose</th><th>Elev Δ</th><th>HR</th></tr></thead>
        <tbody>${sRows}</tbody>
      </table>
    </div>` : ''}
  </details>`;
}
