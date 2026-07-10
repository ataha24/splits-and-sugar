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
  $('strava-status').innerHTML = '<div class="ok">Connected — pick the run below.</div>';
  renderActivityList();
  $('card-strava').classList.add('done');
  setStep(1,'complete');
}

// OAuth: the page redirects to Strava for approval and exchanges the returned
// code for a token right in the browser (the token endpoint allows CORS).
// Client ID/secret survive the redirect in sessionStorage only, and are
// removed the moment the page returns; the token itself lives in memory.
const OAUTH_ID_KEY = 'ss_client_id', OAUTH_SECRET_KEY = 'ss_client_secret';

on('btn-oauth', 'click', () => {
  const id = $('client-id').value.trim();
  const secret = $('client-secret').value.trim();
  if(!id || !secret){
    $('strava-status').innerHTML = '<div class="error">Enter both the Client ID and Client Secret first (see the setup steps above).</div>';
    return;
  }
  sessionStorage.setItem(OAUTH_ID_KEY, id);
  sessionStorage.setItem(OAUTH_SECRET_KEY, secret);
  location.href = 'https://www.strava.com/oauth/authorize'
    + '?client_id=' + encodeURIComponent(id)
    + '&redirect_uri=' + encodeURIComponent(location.origin + location.pathname)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent('read,activity:read_all')
    + '&approval_prompt=auto';
});

async function handleOAuthReturn(){
  if(!$('btn-oauth')) return; // not on the main page
  const params = new URLSearchParams(location.search);
  if(!params.get('code') && !params.get('error')) return;
  const statusEl = $('strava-status');
  const id = sessionStorage.getItem(OAUTH_ID_KEY);
  const secret = sessionStorage.getItem(OAUTH_SECRET_KEY);
  sessionStorage.removeItem(OAUTH_ID_KEY);
  sessionStorage.removeItem(OAUTH_SECRET_KEY);
  history.replaceState(null, '', location.pathname); // scrub the code from the URL
  if(id) $('client-id').value = id;
  if(secret) $('client-secret').value = secret;

  if(params.get('error')){
    statusEl.innerHTML = '<div class="error">Strava access was declined — hit connect again and tap Authorize.</div>';
    return;
  }
  if(!id || !secret){
    statusEl.innerHTML = '<div class="error">The app credentials didn\'t survive the redirect — enter them and connect again.</div>';
    return;
  }
  if(!(params.get('scope') || '').includes('activity:read')){
    statusEl.innerHTML = '<div class="error">Activity access was unticked on the Strava screen — connect again and leave both boxes checked.</div>';
    return;
  }
  statusEl.innerHTML = '<div class="ok">Authorized — finishing sign-in…</div>';
  try{
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({client_id: id, client_secret: secret, code: params.get('code'), grant_type: 'authorization_code'})
    });
    if(!res.ok) throw new Error('Strava rejected the sign-in (' + res.status + ') — double-check the Client Secret and connect again.');
    const tok = await res.json();
    await loadActivities(tok.access_token);
  }catch(err){
    statusEl.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
  }
}
handleOAuthReturn();

// show this site's domain in the setup instructions
if($('cb-domain')) $('cb-domain').textContent = location.hostname || 'localhost';

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
  const file = e.target.files[0];
  if(!file) return;
  $('drop-label').textContent = file.name;
  const reader = new FileReader();
  reader.onload = (evt) => {
    try{
      const parsed = parseDexcomCSV(evt.target.result);
      if(parsed.rows.length === 0){
        $('glucose-status').innerHTML = '<div class="error">Couldn\'t find glucose readings in that file — is it the Clarity export?</div>';
        return;
      }
      glucoseRows = parsed.rows;
      glucoseUnit = parsed.unit;
      $('glucose-status').innerHTML = '<div class="ok">Loaded ' + glucoseRows.length + ' glucose readings (' + glucoseUnit + ').</div>';
      $('card-glucose').classList.add('done');
      setStep(2,'complete');
      checkReady();
    }catch(err){
      $('glucose-status').innerHTML = '<div class="error">Couldn\'t read that CSV: ' + esc(err.message) + '</div>';
    }
  };
  reader.readAsText(file);
});

function parseDexcomCSV(text){
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  let headerIdx = -1, headers = [];
  for(let i=0;i<lines.length;i++){
    if(lines[i].toLowerCase().includes('glucose value') && lines[i].toLowerCase().includes('timestamp')){
      headerIdx = i;
      headers = splitCsvLine(lines[i]);
      break;
    }
  }
  if(headerIdx === -1) throw new Error('no header row with Timestamp / Glucose Value found');

  const tsCol = headers.findIndex(h => h.toLowerCase().includes('timestamp'));
  const valColIdx = headers.findIndex(h => h.toLowerCase().includes('glucose value'));
  const unit = headers[valColIdx].toLowerCase().includes('mmol') ? 'mmol/L' : 'mg/dL';

  const rows = [];
  for(let i=headerIdx+1;i<lines.length;i++){
    const cols = splitCsvLine(lines[i]);
    if(cols.length <= Math.max(tsCol,valColIdx)) continue;
    const rawVal = (cols[valColIdx]||'').trim();
    const rawTs = (cols[tsCol]||'').trim();
    if(!rawVal || !rawTs) continue;
    const val = parseFloat(rawVal);
    if(isNaN(val)) continue;
    const t = new Date(rawTs.replace(' ','T'));
    if(isNaN(t.getTime())) continue;
    rows.push({t, val});
  }
  rows.sort((a,b) => a.t - b.t);
  return {rows, unit};
}

function splitCsvLine(line){
  // simple CSV split good enough for Clarity exports (no embedded commas in relevant fields)
  return line.split(',').map(s => s.replace(/^"|"$/g,''));
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

  const statTiles = [
    {label:'Distance', val: distMi.toFixed(2), unit:' mi', color:'var(--strava-ink)'},
    {label:'Time', val: fmtDur(durationSec), unit:'', color:'var(--strava-ink)'},
    {label:'Avg pace', val: pace.replace('/mi',''), unit:' /mi', color:'var(--strava-ink)'},
    a.total_elevation_gain > 0 ? {label:'Elev gain', val: Math.round(a.total_elevation_gain*3.281), unit:' ft', color:'var(--strava-ink)'} : null,
    a.average_heartrate ? {label:'Avg HR', val: Math.round(a.average_heartrate), unit:' bpm', color:'var(--strava-ink)'} : null,
    {label:'Avg glucose', val: fmtG(g.avg), unit:' '+glucoseUnit, color:'var(--glucose-ink)'},
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

  lastReport = {a, g, start, end, dateStr, distMi, pace, caption, badges};
  attachChartInteraction(g, start, end);

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
  const {a, g, start, end, dateStr, distMi, pace, caption, badges} = lastReport;
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

  let y = 128;
  x.fillStyle = '#45e0c4';
  x.font = '600 25px "JetBrains Mono", monospace';
  x.fillText('S P L I T S  &  S U G A R', P, y);

  x.fillStyle = '#f2f0ea';
  x.font = '700 66px Oswald, sans-serif';
  const titleLines = wrapLines(x, a.name, W - 2*P, 2);
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

  // stats: two rows of three
  const stats = [
    ['DISTANCE', distMi.toFixed(2), ' mi', '#ff5a2e'],
    ['AVG PACE', pace.replace('/mi',''), ' /mi', '#ff5a2e'],
    ['TIME', fmtDur(a.moving_time || a.elapsed_time), '', '#ff5a2e'],
    ['AVG GLUCOSE', fmtG(g.avg), ' ' + glucoseUnit, '#45e0c4'],
    ['IN RANGE', String(g.tir), ' %', '#45e0c4'],
    ['START → FINISH', (g.delta > 0 ? '+' : '') + fmtG(g.delta), ' ' + glucoseUnit, '#45e0c4']
  ];
  const colW = (W - 2*P) / 3, rowH = 148;
  stats.forEach(([label, val, unit, color], i) => {
    const sx = P + (i % 3) * colW, sy = y + Math.floor(i / 3) * rowH;
    x.fillStyle = color; x.fillRect(sx, sy - 16, 16, 16);
    x.fillStyle = '#6b7686';
    x.font = '500 21px "JetBrains Mono", monospace';
    x.fillText(label, sx + 26, sy);
    x.fillStyle = '#f2f0ea';
    x.font = '700 54px Inter, sans-serif';
    x.fillText(val, sx, sy + 62);
    const vw = x.measureText(val).width;
    if(unit){
      x.fillStyle = '#9aa4b4';
      x.font = '500 26px Inter, sans-serif';
      x.fillText(unit, sx + vw + 6, sy + 62);
    }
  });
  y += 2 * rowH + 30;

  // chart
  const cy0 = y + 36, cy1 = cy0 + 330, cx0 = P, cx1 = W - P;
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

  // area + line
  x.beginPath();
  rows.forEach((r, i) => { const px = cxOf(r.t.getTime()), py = cyOf(r.val); i === 0 ? x.moveTo(px, py) : x.lineTo(px, py); });
  x.lineTo(cxOf(t1), cy1); x.lineTo(cxOf(t0), cy1); x.closePath();
  x.fillStyle = 'rgba(29,168,143,0.12)'; x.fill();
  x.beginPath();
  rows.forEach((r, i) => { const px = cxOf(r.t.getTime()), py = cyOf(r.val); i === 0 ? x.moveTo(px, py) : x.lineTo(px, py); });
  x.strokeStyle = '#1da88f'; x.lineWidth = 5; x.lineJoin = 'round'; x.lineCap = 'round'; x.stroke();

  // low point
  const lx = cxOf(g.minRow.t.getTime()), lyv = cyOf(g.minRow.val);
  x.fillStyle = '#10141b'; x.beginPath(); x.arc(lx, lyv, 12, 0, Math.PI*2); x.fill();
  x.fillStyle = '#1da88f'; x.beginPath(); x.arc(lx, lyv, 8, 0, Math.PI*2); x.fill();
  x.fillStyle = '#9aa4b4';
  x.font = '500 24px "JetBrains Mono", monospace';
  const lowLabel = 'low ' + fmtG(g.minRow.val);
  const labelAbove = lyv > cy1 - 44;
  x.fillText(lowLabel, Math.min(Math.max(lx - x.measureText(lowLabel).width/2, cx0), cx1 - x.measureText(lowLabel).width), labelAbove ? lyv - 24 : lyv + 44);

  // caption (lines capped so a tall title + badges can't push past the footer)
  let capY = cy1 + 84;
  const maxCapLines = Math.max(1, Math.min(3, Math.floor((H - 130 - capY)/48) + 1));
  x.fillStyle = '#f2f0ea';
  x.font = 'italic 500 33px Inter, sans-serif';
  wrapLines(x, '“' + caption + '”', W - 2*P, maxCapLines).forEach(l => { x.fillText(l, P, capY); capY += 48; });

  // footer
  x.fillStyle = '#6b7686';
  x.font = '500 23px "JetBrains Mono", monospace';
  x.textAlign = 'center';
  const site = (location.host || 'splits & sugar') + location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');
  x.fillText('built with <3 by AT  ·  ' + site, W/2, H - 52);
  x.textAlign = 'left';

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
      <path d="${area}" fill="#1da88f" opacity="0.09"/>
      <path d="${path}" fill="none" stroke="#1da88f" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
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
