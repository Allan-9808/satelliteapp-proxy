'use strict';
const express = require('express');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT               = process.env.PORT || 10000;
const USGS_API           = 'https://m2m.cr.usgs.gov/api/api/json/stable';
const APP_USERNAME       = process.env.APP_USERNAME;
const APP_PASSWORD       = process.env.APP_PASSWORD;
const JWT_SECRET         = process.env.JWT_SECRET || 'SatelliteApp2026SecretKey';
const SENTINEL_ID        = process.env.SENTINEL_CLIENT_ID;
const SENTINEL_SEC       = process.env.SENTINEL_CLIENT_SECRET;
const USGS_USERNAME      = process.env.USGS_USERNAME;
const USGS_TOKEN         = process.env.USGS_TOKEN;

let usgsApiKey = null, usgsApiKeyExpiry = null;
let sentinelToken = null, sentinelTokenExpiry = null;
let usgsQueueChain = Promise.resolve();

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchTimeout(url, opts, ms = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function queueUsgs(fn) {
  const p = usgsQueueChain.then(() => fn()).catch(e => { throw e; });
  usgsQueueChain = p.catch(() => {});
  return p;
}

// DYNAMIC PIXEL DIMENSIONS
// Sentinel-2 L2A max = 1500 m/px. We use 1400 for safety margin.
// 1 deg lat ≈ 111,320m. 1 deg lon ≈ 111,320 × cos(lat) m.
function calcDims(bbox, maxPx = 512, maxRes = 1400) {
  const midLat = (bbox.lat1 + bbox.lat2) / 2;
  const wM = Math.abs(bbox.lon2 - bbox.lon1) * 111320 * Math.cos(midLat * Math.PI / 180);
  const hM = Math.abs(bbox.lat2 - bbox.lat1) * 111320;
  const w  = Math.min(maxPx, Math.max(32, Math.ceil(wM / maxRes) + 2));
  const h  = Math.min(maxPx, Math.max(32, Math.ceil(hM / maxRes) + 2));
  console.log(`[DIMS] ${(wM/1000).toFixed(0)}km×${(hM/1000).toFixed(0)}km → ${w}×${h}px (${(wM/w).toFixed(0)}m/px)`);
  return { w, h };
}

async function getUsgsKey() {
  if (usgsApiKey && Date.now() < usgsApiKeyExpiry) return usgsApiKey;
  console.log('[USGS] Refreshing API key...');
  const r = await fetchTimeout(`${USGS_API}/login-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USGS_USERNAME, token: USGS_TOKEN })
  }, 30000);
  let d; try { d = JSON.parse(await r.text()); } catch(e) { throw new Error('USGS non-JSON'); }
  if (d.errorCode) throw new Error(d.errorCode + ': ' + d.errorMessage);
  usgsApiKey = d.data;
  usgsApiKeyExpiry = Date.now() + 90 * 60 * 1000;
  await sleep(2000);
  return usgsApiKey;
}

async function getSentinelToken() {
  if (!SENTINEL_ID || !SENTINEL_SEC) throw new Error('Sentinel Hub credentials not set on Render.com');
  if (sentinelToken && Date.now() < sentinelTokenExpiry) return sentinelToken;
  const r = await fetch('https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SENTINEL_ID, client_secret: SENTINEL_SEC })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Sentinel Hub auth failed: ' + JSON.stringify(d).slice(0, 200));
  sentinelToken = d.access_token;
  sentinelTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  console.log('[SENTINEL] Token obtained');
  return sentinelToken;
}

function requireJwt(req, res) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) { res.status(401).json({ error: 'No token' }); return null; }
  try { return jwt.verify(h.split(' ')[1], JWT_SECRET); }
  catch(e) { res.status(401).json({ error: 'Invalid token' }); return null; }
}

// PROCESS API evalscript (renders colored PNG, RGBA output so no-data = transparent)
function getMapEvalscript(idx) {
  const C = {
    NDVI:  { b:['B04','B08'],             c:'let v=(s.B08-s.B04)/(s.B08+s.B04+1e-6);',                                                                    br:'[-0.2,0,0.2,0.4,0.6,0.8]',  cl:'[[.75,.75,.75],[.86,.86,.86],[1,1,.88],[.56,.82,.31],[.18,.65,.18],[0,.4,0]]' },
    NDWI:  { b:['B03','B08'],             c:'let v=(s.B03-s.B08)/(s.B03+s.B08+1e-6);',                                                                    br:'[-.6,-.3,0,.2,.4,.6]',       cl:'[[.94,.97,1],[.75,.89,.97],[.5,.74,.9],[.22,.55,.8],[.06,.35,.67],[0,.19,.52]]' },
    MNDWI: { b:['B03','B11'],             c:'let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);',                                                                    br:'[-.6,-.3,0,.2,.4,.6]',       cl:'[[.94,.97,1],[.75,.89,.97],[.5,.74,.9],[.22,.55,.8],[.06,.35,.67],[0,.19,.52]]' },
    NDBI:  { b:['B08','B11'],             c:'let v=(s.B11-s.B08)/(s.B11+s.B08+1e-6);',                                                                    br:'[-.5,-.2,0,.2,.4,.6]',       cl:'[[.13,.55,.13],[.56,.73,.56],[.96,.96,.86],[.85,.75,.5],[.7,.5,.2],[.55,.25,.08]]' },
    EVI:   { b:['B02','B04','B08'],       c:'let v=2.5*(s.B08-s.B04)/(s.B08+6*s.B04-7.5*s.B02+1+1e-6);',                                                 br:'[-.2,0,.2,.4,.6,.9]',        cl:'[[.75,.75,.75],[.86,.86,.86],[1,1,.88],[.56,.82,.31],[.18,.65,.18],[0,.4,0]]' },
    SAVI:  { b:['B04','B08'],             c:'let v=1.5*(s.B08-s.B04)/(s.B08+s.B04+0.5+1e-6);',                                                            br:'[-.2,0,.2,.4,.6,.9]',        cl:'[[.75,.75,.75],[.86,.86,.86],[1,1,.88],[.56,.82,.31],[.18,.65,.18],[0,.4,0]]' },
    GNDVI: { b:['B03','B08'],             c:'let v=(s.B08-s.B03)/(s.B08+s.B03+1e-6);',                                                                    br:'[-.2,0,.2,.4,.6,.8]',        cl:'[[.75,.75,.75],[.86,.86,.86],[1,1,.88],[.56,.82,.31],[.18,.65,.18],[0,.4,0]]' },
    NDMI:  { b:['B08','B11'],             c:'let v=(s.B08-s.B11)/(s.B08+s.B11+1e-6);',                                                                    br:'[-.8,-.4,0,.2,.4,.8]',       cl:'[[.92,.76,.45],[.98,.94,.82],[.92,.97,1],[.55,.82,.97],[.14,.59,.9],[0,.25,.62]]' },
    NDBaI: { b:['B11','B12'],             c:'let v=(s.B11-s.B12)/(s.B11+s.B12+1e-6);',                                                                    br:'[-.6,-.3,0,.2,.4,.6]',       cl:'[[.13,.55,.13],[.64,.84,.64],[.97,.97,.88],[.94,.82,.55],[.76,.54,.22],[.55,.27,.07]]' },
    BSI:   { b:['B02','B04','B08','B11'], c:'let v=((s.B11+s.B04)-(s.B08+s.B02))/((s.B11+s.B04)+(s.B08+s.B02)+1e-6);',                                  br:'[-.6,-.3,0,.1,.3,.5]',       cl:'[[.13,.55,.13],[.64,.84,.64],[.96,.96,.86],[.94,.82,.55],[.76,.54,.22],[.55,.27,.07]]' },
    NDRE:  { b:['B04','B05'],             c:'let v=(s.B05-s.B04)/(s.B05+s.B04+1e-6);',                                                                    br:'[-.2,0,.2,.4,.6,.8]',        cl:'[[.75,.75,.75],[.86,.86,.86],[1,1,.88],[.56,.82,.31],[.18,.65,.18],[0,.4,0]]' },
    NDSI:  { b:['B03','B11'],             c:'let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);',                                                                    br:'[-.6,-.3,0,.2,.4,.8]',       cl:'[[.65,.33,.16],[.86,.63,.4],[.98,.92,.84],[.8,.93,.97],[.55,.85,.97],[.95,.97,1]]' },
    OSAVI: { b:['B04','B08'],             c:'let v=(s.B08-s.B04)/(s.B08+s.B04+0.16);',                                                                    br:'[-.2,0,.2,.4,.6,.9]',        cl:'[[.75,.75,.75],[.86,.86,.86],[1,1,.88],[.56,.82,.31],[.18,.65,.18],[0,.4,0]]' },
    MSAVI: { b:['B04','B08'],             c:'let x=2*s.B08+1;let v=(x-Math.sqrt(Math.max(0,x*x-8*(s.B08-s.B04))))/2;',                                   br:'[-.2,0,.2,.4,.6,.9]',        cl:'[[.75,.75,.75],[.86,.86,.86],[1,1,.88],[.56,.82,.31],[.18,.65,.18],[0,.4,0]]' },
    CMRI:  { b:['B03','B04','B08','B11'], c:'let nd=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mw=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=nd-mw;',            br:'[-1.5,-.5,0,.5,1,1.5]',      cl:'[[0,.19,.52],[.22,.55,.8],[.9,.9,.65],[.46,.72,.26],[.08,.53,.08],[0,.3,0]]' },
    MMRI:  { b:['B03','B04','B08','B11'], c:'let nd=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mw=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=Math.abs(mw)/(Math.abs(mw)+Math.abs(nd)+1e-6);', br:'[0,.2,.4,.6,.8,1]', cl:'[[.94,.97,1],[.58,.8,.92],[.16,.58,.73],[.04,.39,.27],[.02,.27,.16],[0,.15,.08]]' },
    MVI:   { b:['B03','B08','B11'],       c:'let d=s.B11-s.B03;let v=Math.abs(d)<1e-6?0:(s.B08-s.B03)/d;v=Math.max(0,Math.min(10,v));',                  br:'[0,1,2,4,6,10]',             cl:'[[.98,.92,.84],[.8,.91,.66],[.46,.72,.26],[.16,.55,.16],[.04,.38,.12],[0,.2,.05]]' },
  };
  const cfg = C[idx] || C['NDVI'];
  const bi = cfg.b.map(x => `"${x}"`).join(',');
  return `//VERSION=3
function setup(){return{input:[{bands:[${bi},"dataMask"],units:"REFLECTANCE"}],output:{bands:4,sampleType:"AUTO"}}}
function evaluatePixel(s){
  if(!s.dataMask)return[.16,.16,.20,0];
  ${cfg.c}
  if(isNaN(v)||!isFinite(v))return[.16,.16,.20,0];
  let rgb=colorBlend(v,${cfg.br},${cfg.cl});
  return[...rgb,1];
}`;
}

// STATISTICS API evalscript (returns float + dataMask for mean/min/max computation)
function getStatsEvalscript(idx) {
  const C = {
    NDVI:  { b:['B04','B08'],             s:'let v=(s.B08-s.B04)/(s.B08+s.B04+1e-6);' },
    NDWI:  { b:['B03','B08'],             s:'let v=(s.B03-s.B08)/(s.B03+s.B08+1e-6);' },
    MNDWI: { b:['B03','B11'],             s:'let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);' },
    NDBI:  { b:['B08','B11'],             s:'let v=(s.B11-s.B08)/(s.B11+s.B08+1e-6);' },
    EVI:   { b:['B02','B04','B08'],       s:'let v=2.5*(s.B08-s.B04)/(s.B08+6*s.B04-7.5*s.B02+1+1e-6);v=Math.max(-1,Math.min(2,v));' },
    SAVI:  { b:['B04','B08'],             s:'let v=1.5*(s.B08-s.B04)/(s.B08+s.B04+0.5+1e-6);' },
    GNDVI: { b:['B03','B08'],             s:'let v=(s.B08-s.B03)/(s.B08+s.B03+1e-6);' },
    NDMI:  { b:['B08','B11'],             s:'let v=(s.B08-s.B11)/(s.B08+s.B11+1e-6);' },
    BSI:   { b:['B02','B04','B08','B11'], s:'let v=((s.B11+s.B04)-(s.B08+s.B02))/((s.B11+s.B04)+(s.B08+s.B02)+1e-6);' },
    NDSI:  { b:['B03','B11'],             s:'let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);' },
    OSAVI: { b:['B04','B08'],             s:'let v=(s.B08-s.B04)/(s.B08+s.B04+0.16);' },
    MSAVI: { b:['B04','B08'],             s:'let x=2*s.B08+1;let v=(x-Math.sqrt(Math.max(0,x*x-8*(s.B08-s.B04))))/2;' },
    NDBaI: { b:['B11','B12'],             s:'let v=(s.B11-s.B12)/(s.B11+s.B12+1e-6);' },
    NDRE:  { b:['B04','B05'],             s:'let v=(s.B05-s.B04)/(s.B05+s.B04+1e-6);' },
    CMRI:  { b:['B03','B04','B08','B11'], s:'let nd=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mw=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=nd-mw;' },
    MMRI:  { b:['B03','B04','B08','B11'], s:'let nd=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mw=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=Math.abs(mw)/(Math.abs(mw)+Math.abs(nd)+1e-6);' },
    MVI:   { b:['B03','B08','B11'],       s:'let d=s.B11-s.B03;let v=Math.abs(d)<1e-6?0:(s.B08-s.B03)/d;v=Math.max(0,Math.min(20,v));' },
  };
  const cfg = C[idx]; if (!cfg) return null;
  const bi = cfg.b.map(x => `"${x}"`).join(',');
  return `//VERSION=3
function setup(){return{input:[{bands:[${bi},"dataMask"],units:"REFLECTANCE"}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){
  if(!s.dataMask)return{data:[0],dataMask:[0]};
  ${cfg.s}
  if(isNaN(v)||!isFinite(v))return{data:[0],dataMask:[0]};
  return{data:[v],dataMask:[1]};
}`;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status:'ok', service:'SatelliteApp Proxy v4', queueEnabled:true, sentinelHub:!!(SENTINEL_ID&&SENTINEL_SEC) }));

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.trim() !== (APP_USERNAME||'').trim() || password.trim() !== (APP_PASSWORD||'').trim()) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token: jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' }), username });
});

app.post('/usgs/:endpoint', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
  const ep = req.params.endpoint;
  try {
    const data = await queueUsgs(async () => {
      const key = await getUsgsKey();
      const call = k => fetchTimeout(`${USGS_API}/${ep}`, {
        method:'POST', headers:{'Content-Type':'application/json','X-Auth-Token':k}, body:JSON.stringify(req.body)
      }, 45000);
      let r = await call(key), d = JSON.parse(await r.text());
      if (d.errorCode==='CONCURRENT_REQUEST_LIMIT'||(d.errorMessage||'').includes('multiple requests')) {
        console.log('[USGS] CONCURRENT → waiting 6s, retrying');
        await sleep(6000); r = await call(key); d = JSON.parse(await r.text());
      }
      if (d.errorCode==='UNAUTHORIZED_USER'||d.errorCode==='AUTH_INVALID') {
        usgsApiKey=null; const nk=await getUsgsKey(); r=await call(nk); d=JSON.parse(await r.text());
      }
      return d;
    });
    res.json(data);
  } catch(e) {
    if (e.name==='AbortError') return res.status(504).json({ error: 'USGS timed out. Please try again in 30 seconds.' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/sentinel/map', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { bbox, indexName, date } = req.body;
  if (!bbox || !indexName) return res.status(400).json({ error: 'bbox and indexName required' });
  if (indexName === 'UTFVI') return res.status(400).json({ error: 'UTFVI needs Landsat thermal band (B10). Sentinel-2 has no thermal sensor. Please use NDBaI or NDBI instead.' });

  const { w, h } = calcDims(bbox);
  const d = new Date(date || new Date().toISOString().split('T')[0]);
  const from = new Date(d); from.setDate(d.getDate() - 25);
  const to   = new Date(d); to.setDate(d.getDate() + 25);
  const evalscript = getMapEvalscript(indexName); // PLAIN TEXT — not base64, not data URI

  const payload = {
    input: {
      bounds: { bbox:[bbox.lon1,bbox.lat1,bbox.lon2,bbox.lat2], properties:{crs:'http://www.opengis.net/def/crs/EPSG/0/4326'} },
      data: [{ type:'sentinel-2-l2a', dataFilter:{ timeRange:{ from:from.toISOString().split('T')[0]+'T00:00:00Z', to:to.toISOString().split('T')[0]+'T23:59:59Z' }, maxCloudCoverage:65, mosaickingOrder:'leastCC' } }]
    },
    output: { width:w, height:h, responses:[{identifier:'default',format:{type:'image/png'}}] },
    evalscript
  };

  try {
    const token = await getSentinelToken();
    const imgRes = await fetch('https://services.sentinel-hub.com/api/v1/process', {
      method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(payload)
    });
    if (!imgRes.ok) { const e = await imgRes.text(); return res.status(imgRes.status).json({ error: 'Sentinel map failed: ' + e.slice(0,300) }); }
    const base64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
    res.json({ image:base64, mimeType:'image/png', width:w, height:h });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/sentinel/statistics', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { bbox, aoiGeometry, indexName, startDate, endDate, interval } = req.body;
  if (!bbox||!indexName||!startDate||!endDate) return res.status(400).json({ error: 'bbox, indexName, startDate, endDate are required' });
  if (indexName==='UTFVI') return res.status(400).json({ error: 'UTFVI needs Landsat thermal band. Sentinel-2 has no thermal sensor. Use NDBaI or NDBI instead.' });

  const evalscript = getStatsEvalscript(indexName); // PLAIN TEXT
  if (!evalscript) return res.status(400).json({ error: 'Unknown index: ' + indexName });

  const { w, h } = calcDims(bbox);
  const bounds = aoiGeometry
    ? { geometry:aoiGeometry, properties:{crs:'http://www.opengis.net/def/crs/EPSG/0/4326'} }
    : { bbox:[bbox.lon1,bbox.lat1,bbox.lon2,bbox.lat2], properties:{crs:'http://www.opengis.net/def/crs/EPSG/0/4326'} };

  const payload = {
    input: {
      bounds,
      data: [{ type:'sentinel-2-l2a', dataFilter:{ timeRange:{ from:startDate+'T00:00:00Z', to:endDate+'T23:59:59Z' }, maxCloudCoverage:70 } }]
    },
    aggregation: {
      timeRange: { from:startDate+'T00:00:00Z', to:endDate+'T23:59:59Z' },
      aggregationInterval: { of: interval || 'P1M' },
      width:w, height:h,
      evalscript
    },
    calculations: { default: { histograms:{}, statistics:{} } }
  };

  try {
    const token = await getSentinelToken();
    const r = await fetch('https://services.sentinel-hub.com/api/v1/statistics', {
      method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(payload)
    });
    let data; try { data = JSON.parse(await r.text()); } catch(e) { return res.status(500).json({ error:'Sentinel non-JSON response' }); }
    if (!r.ok) return res.status(r.status).json({ error:'Sentinel Stats error: ' + JSON.stringify(data).slice(0,300) });

    const points = (data.data||[]).map(iv => {
      const st = iv?.outputs?.data?.bands?.B0?.stats;
      if (!st || st.sampleCount === 0) return null;
      const valid = st.sampleCount - st.noDataCount;
      if (valid < 5) return null;
      return { date:iv.interval?.from?.split('T')[0]||'', mean:+st.mean.toFixed(4), min:+st.min.toFixed(4), max:+st.max.toFixed(4), stDev:+st.stDev.toFixed(4), count:valid };
    }).filter(Boolean);

    res.json({ success:true, indexName, points });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.listen(PORT, () => {
  console.log(`SatelliteApp Proxy v4 on port ${PORT}`);
  console.log(`USGS queue: ENABLED - concurrent errors prevented`);
  console.log(`Sentinel Hub configured: ${!!(SENTINEL_ID && SENTINEL_SEC)}`);
});
