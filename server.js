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

// ──────────────────────────────────────────────────────────────────────────────
// DYNAMIC BAND MAPPING — Sentinel-2 ↔ Landsat 8/9
// ──────────────────────────────────────────────────────────────────────────────
const BAND_MAP = {
  'sentinel-2': {
    BLUE: 'B02', GREEN: 'B03', RED: 'B04',
    RED_EDGE_1: 'B05', RED_EDGE_2: 'B06', RED_EDGE_3: 'B07',
    NIR: 'B08', SWIR1: 'B11', SWIR2: 'B12',
    hubType: 'sentinel-2-l2a',
    hasRedEdge: true,
    label: 'Sentinel-2'
  },
  'landsat': {
    BLUE: 'B02', GREEN: 'B03', RED: 'B04',
    RED_EDGE_1: null, RED_EDGE_2: null, RED_EDGE_3: null,
    NIR: 'B05', SWIR1: 'B06', SWIR2: 'B07',
    hubType: 'landsat-ot-l2',
    hasRedEdge: false,
    label: 'Landsat 8/9'
  }
};

// Indices that REQUIRE Red-Edge bands — cannot run on Landsat
const RED_EDGE_INDICES = ['MARINE', 'REMI', 'NDRE'];

function resolveDataset(dsParam) {
  if (!dsParam) return BAND_MAP['sentinel-2'];
  const key = dsParam.toLowerCase();
  if (key.includes('landsat')) return BAND_MAP['landsat'];
  return BAND_MAP['sentinel-2'];
}

// ──────────────────────────────────────────────────────────────────────────────
// DYNAMIC PIXEL DIMENSIONS
// ──────────────────────────────────────────────────────────────────────────────
function calcDims(bbox, maxPx = 512, maxRes = 1400) {
  const midLat = (bbox.lat1 + bbox.lat2) / 2;
  const wM = Math.abs(bbox.lon2 - bbox.lon1) * 111320 * Math.cos(midLat * Math.PI / 180);
  const hM = Math.abs(bbox.lat2 - bbox.lat1) * 111320;
  const w  = Math.min(maxPx, Math.max(32, Math.ceil(wM / maxRes) + 2));
  const h  = Math.min(maxPx, Math.max(32, Math.ceil(hM / maxRes) + 2));
  console.log(`[DIMS] ${(wM/1000).toFixed(0)}km×${(hM/1000).toFixed(0)}km → ${w}×${h}px (${(wM/w).toFixed(0)}m/px)`);
  return { w, h };
}

// ──────────────────────────────────────────────────────────────────────────────
// AUTH HELPERS
// ──────────────────────────────────────────────────────────────────────────────
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
  if (!SENTINEL_ID || !SENTINEL_SEC) throw new Error('Sentinel Hub credentials not configured. Please set SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET on the server.');
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

// ──────────────────────────────────────────────────────────────────────────────
// INDEX DEFINITIONS — Dynamic band mapping per dataset
// Each index returns { bands: [...], code: 'let v=...' } using actual band names
// ──────────────────────────────────────────────────────────────────────────────
function getIndexConfig(idx, ds) {
  const B = ds; // shorthand for band map
  const b = (name) => B[name]; // resolve band name

  const configs = {
    // ── VEGETATION ──────────────────────────────────────────────────────
    NDVI: {
      bands: [b('RED'), b('NIR')],
      code: `let v=(s.${b('NIR')}-s.${b('RED')})/(s.${b('NIR')}+s.${b('RED')}+1e-6);`
    },
    EVI: {
      bands: [b('BLUE'), b('RED'), b('NIR')],
      code: `let v=2.5*(s.${b('NIR')}-s.${b('RED')})/(s.${b('NIR')}+6*s.${b('RED')}-7.5*s.${b('BLUE')}+1+1e-6);`
    },
    SAVI: {
      bands: [b('RED'), b('NIR')],
      code: `let v=1.5*(s.${b('NIR')}-s.${b('RED')})/(s.${b('NIR')}+s.${b('RED')}+0.5+1e-6);`
    },
    GNDVI: {
      bands: [b('GREEN'), b('NIR')],
      code: `let v=(s.${b('NIR')}-s.${b('GREEN')})/(s.${b('NIR')}+s.${b('GREEN')}+1e-6);`
    },
    OSAVI: {
      bands: [b('RED'), b('NIR')],
      code: `let v=(s.${b('NIR')}-s.${b('RED')})/(s.${b('NIR')}+s.${b('RED')}+0.16);`
    },
    MSAVI: {
      bands: [b('RED'), b('NIR')],
      code: `let x=2*s.${b('NIR')}+1;let v=(x-Math.sqrt(Math.max(0,x*x-8*(s.${b('NIR')}-s.${b('RED')}))))/2;`
    },

    // ── RED-EDGE VEGETATION (Sentinel-2 only) ──────────────────────────
    NDRE: {
      bands: [b('RED'), b('RED_EDGE_1')],
      code: `let v=(s.${b('RED_EDGE_1')}-s.${b('RED')})/(s.${b('RED_EDGE_1')}+s.${b('RED')}+1e-6);`,
      requiresRedEdge: true
    },

    // ── WATER/MOISTURE ─────────────────────────────────────────────────
    NDWI: {
      bands: [b('GREEN'), b('NIR')],
      code: `let v=(s.${b('GREEN')}-s.${b('NIR')})/(s.${b('GREEN')}+s.${b('NIR')}+1e-6);`
    },
    MNDWI: {
      bands: [b('GREEN'), b('SWIR1')],
      code: `let v=(s.${b('GREEN')}-s.${b('SWIR1')})/(s.${b('GREEN')}+s.${b('SWIR1')}+1e-6);`
    },
    NDMI: {
      bands: [b('GREEN'), b('SWIR2')],
      code: `let v=(s.${b('SWIR2')}-s.${b('GREEN')})/(s.${b('SWIR2')}+s.${b('GREEN')}+1e-6);`
    },

    // ── URBAN/SOIL ─────────────────────────────────────────────────────
    NDBI: {
      bands: [b('NIR'), b('SWIR1')],
      code: `let v=(s.${b('SWIR1')}-s.${b('NIR')})/(s.${b('SWIR1')}+s.${b('NIR')}+1e-6);`
    },
    NDBaI: {
      bands: [b('SWIR1'), b('SWIR2')],
      code: `let v=(s.${b('SWIR1')}-s.${b('SWIR2')})/(s.${b('SWIR1')}+s.${b('SWIR2')}+1e-6);`
    },
    BSI: {
      bands: [b('BLUE'), b('RED'), b('NIR'), b('SWIR1')],
      code: `let v=((s.${b('SWIR1')}+s.${b('RED')})-(s.${b('NIR')}+s.${b('BLUE')}))/((s.${b('SWIR1')}+s.${b('RED')})+(s.${b('NIR')}+s.${b('BLUE')})+1e-6);`
    },

    // ── SNOW ───────────────────────────────────────────────────────────
    NDSI: {
      bands: [b('GREEN'), b('SWIR1')],
      code: `let v=(s.${b('GREEN')}-s.${b('SWIR1')})/(s.${b('GREEN')}+s.${b('SWIR1')}+1e-6);`
    },

    // ── MANGROVE ───────────────────────────────────────────────────────
    MVI: {
      bands: [b('GREEN'), b('NIR'), b('SWIR1')],
      code: `let d=s.${b('SWIR1')}-s.${b('GREEN')};let v=Math.abs(d)<1e-6?0:(s.${b('NIR')}-s.${b('GREEN')})/d;v=Math.max(0,Math.min(10,v));`
    },
    CMRI: {
      bands: [b('GREEN'), b('RED'), b('NIR'), b('SWIR1')],
      code: `let nd=(s.${b('NIR')}-s.${b('RED')})/(s.${b('NIR')}+s.${b('RED')}+1e-6);let nw=(s.${b('GREEN')}-s.${b('NIR')})/(s.${b('GREEN')}+s.${b('NIR')}+1e-6);let v=nd-nw;`
    },
    MMRI: {
      bands: [b('GREEN'), b('RED'), b('NIR'), b('SWIR1')],
      code: `let nd=(s.${b('NIR')}-s.${b('RED')})/(s.${b('NIR')}+s.${b('RED')}+1e-6);let mw=(s.${b('GREEN')}-s.${b('SWIR1')})/(s.${b('GREEN')}+s.${b('SWIR1')}+1e-6);let v=Math.abs(mw)/(Math.abs(mw)+Math.abs(nd)+1e-6);`
    },

    // ── REMI (Red-Edge, Sentinel-2 only) ───────────────────────────────
    REMI: {
      bands: [b('GREEN'), b('RED'), b('RED_EDGE_1'), b('SWIR1')],
      code: `let v=(s.${b('RED_EDGE_1')}-s.${b('RED')})/(s.${b('SWIR1')}-s.${b('GREEN')}+1e-6);`,
      requiresRedEdge: true
    },

    // ── MARINE (Red-Edge, Sentinel-2 only) ─────────────────────────────
    // MARINE = ((B6-B4)/(B11-B3)) * (1 + ((B7-B5)/(B7+B5)))
    MARINE: {
      bands: [b('GREEN'), b('RED'), b('RED_EDGE_1'), b('RED_EDGE_2'), b('RED_EDGE_3'), b('SWIR1')],
      code: `let t1=(s.${b('RED_EDGE_2')}-s.${b('RED')})/(s.${b('SWIR1')}-s.${b('GREEN')}+1e-6);let t2=1+((s.${b('RED_EDGE_3')}-s.${b('RED_EDGE_1')})/(s.${b('RED_EDGE_3')}+s.${b('RED_EDGE_1')}+1e-6));let v=t1*t2;`,
      requiresRedEdge: true
    },
  };

  return configs[idx] || null;
}

// ──────────────────────────────────────────────────────────────────────────────
// COLOR RAMP DEFINITIONS (dataset-independent)
// ──────────────────────────────────────────────────────────────────────────────
const COLOR_RAMPS = {
  // VEGETATION: Brown → Tan → Light Green → Dark Green
  NDVI:   { br:'[-0.2,0,0.2,0.4,0.6,0.8]',  cl:'[[.54,.27,.07],[.82,.71,.55],[.96,.96,.86],[.56,.79,.20],[.18,.55,.18],[0,.27,0]]' },
  EVI:    { br:'[-0.2,0,0.2,0.4,0.6,0.9]',  cl:'[[.54,.27,.07],[.82,.71,.55],[.96,.96,.86],[.56,.79,.20],[.18,.55,.18],[0,.27,0]]' },
  SAVI:   { br:'[-0.2,0,0.2,0.4,0.6,0.9]',  cl:'[[.54,.27,.07],[.82,.71,.55],[.96,.96,.86],[.56,.79,.20],[.18,.55,.18],[0,.27,0]]' },
  GNDVI:  { br:'[-0.2,0,0.2,0.4,0.6,0.8]',  cl:'[[.54,.27,.07],[.82,.71,.55],[.96,.96,.86],[.56,.79,.20],[.18,.55,.18],[0,.27,0]]' },
  NDRE:   { br:'[-0.2,0,0.2,0.4,0.6,0.8]',  cl:'[[.54,.27,.07],[.82,.71,.55],[.96,.96,.86],[.56,.79,.20],[.18,.55,.18],[0,.27,0]]' },
  OSAVI:  { br:'[-0.2,0,0.2,0.4,0.6,0.9]',  cl:'[[.54,.27,.07],[.82,.71,.55],[.96,.96,.86],[.56,.79,.20],[.18,.55,.18],[0,.27,0]]' },
  MSAVI:  { br:'[-0.2,0,0.2,0.4,0.6,0.9]',  cl:'[[.54,.27,.07],[.82,.71,.55],[.96,.96,.86],[.56,.79,.20],[.18,.55,.18],[0,.27,0]]' },
  // WATER: Tan → Light Blue → Dark Blue
  NDWI:   { br:'[-.6,-.3,0,.2,.4,.6]',       cl:'[[.94,.90,.79],[.75,.85,.93],[.50,.74,.90],[.22,.56,.80],[.06,.35,.67],[0,.19,.52]]' },
  MNDWI:  { br:'[-.6,-.3,0,.2,.4,.6]',       cl:'[[.94,.90,.79],[.75,.85,.93],[.50,.74,.90],[.22,.56,.80],[.06,.35,.67],[0,.19,.52]]' },
  NDMI:   { br:'[-.8,-.4,0,.2,.4,.8]',        cl:'[[.92,.76,.45],[.98,.94,.82],[.92,.97,1],[.55,.82,.97],[.14,.59,.9],[0,.25,.62]]' },
  // URBAN/SOIL: Grey → Tan → Orange → Red (NOT green)
  NDBI:   { br:'[-.5,-.2,0,.15,.3,.5]',       cl:'[[.50,.50,.50],[.63,.63,.63],[.78,.78,.63],[.83,.63,.31],[.72,.39,.16],[.55,.16,.05]]' },
  NDBaI:  { br:'[-.6,-.3,0,.2,.4,.6]',        cl:'[[.13,.55,.13],[.64,.84,.64],[.97,.97,.88],[.94,.82,.55],[.76,.54,.22],[.55,.27,.07]]' },
  BSI:    { br:'[-.6,-.3,0,.1,.3,.5]',         cl:'[[.13,.55,.13],[.64,.84,.64],[.96,.96,.86],[.94,.82,.55],[.76,.54,.22],[.55,.27,.07]]' },
  // SNOW
  NDSI:   { br:'[-.6,-.3,0,.2,.4,.8]',        cl:'[[.65,.33,.16],[.86,.63,.4],[.98,.92,.84],[.8,.93,.97],[.55,.85,.97],[.95,.97,1]]' },
  // MANGROVE
  MVI:    { br:'[0,1,2,4,6,10]',               cl:'[[.98,.92,.84],[.8,.91,.66],[.46,.72,.26],[.16,.55,.16],[.04,.38,.12],[0,.2,.05]]' },
  CMRI:   { br:'[-1.5,-.5,0,.5,1,1.5]',       cl:'[[0,.19,.52],[.22,.55,.8],[.9,.9,.65],[.46,.72,.26],[.08,.53,.08],[0,.3,0]]' },
  MMRI:   { br:'[0,.2,.4,.6,.8,1]',            cl:'[[.94,.97,1],[.58,.8,.92],[.16,.58,.73],[.04,.39,.27],[.02,.27,.16],[0,.15,.08]]' },
  // RED-EDGE SPECIAL
  REMI:   { br:'[-1,-.5,0,.5,1,2]',            cl:'[[.55,.27,.07],[.82,.71,.55],[.96,.96,.86],[.56,.79,.20],[.18,.55,.18],[0,.27,0]]' },
  MARINE: { br:'[-2,-1,0,1,2,4]',              cl:'[[.55,.16,.05],[.82,.55,.27],[.96,.92,.78],[.40,.72,.40],[.12,.50,.12],[0,.30,.08]]' },
};

// ──────────────────────────────────────────────────────────────────────────────
// EVALSCRIPT BUILDERS (dynamic per dataset)
// ──────────────────────────────────────────────────────────────────────────────

// Map evalscript: renders colored RGBA PNG
function getMapEvalscript(idx, ds) {
  const cfg = getIndexConfig(idx, ds);
  if (!cfg) return null;
  const ramp = COLOR_RAMPS[idx] || COLOR_RAMPS['NDVI'];
  const bands = [...new Set(cfg.bands.filter(Boolean))];
  const bi = bands.map(x => `"${x}"`).join(',');
  return `//VERSION=3
function setup(){return{input:[{bands:[${bi},"dataMask"],units:"REFLECTANCE"}],output:{bands:4,sampleType:"AUTO"}}}
function evaluatePixel(s){
  if(!s.dataMask)return[.16,.16,.20,0];
  ${cfg.code}
  if(isNaN(v)||!isFinite(v))return[.16,.16,.20,0];
  let rgb=colorBlend(v,${ramp.br},${ramp.cl});
  return[...rgb,1];
}`;
}

// Statistics evalscript: returns float + dataMask for mean/min/max
function getStatsEvalscript(idx, ds) {
  const cfg = getIndexConfig(idx, ds);
  if (!cfg) return null;
  const bands = [...new Set(cfg.bands.filter(Boolean))];
  const bi = bands.map(x => `"${x}"`).join(',');
  // Clamp extreme values for stability
  let clamp = '';
  if (idx === 'EVI') clamp = 'v=Math.max(-1,Math.min(2,v));';
  else if (idx === 'MVI') clamp = 'v=Math.max(0,Math.min(20,v));';
  else if (idx === 'MARINE') clamp = 'v=Math.max(-5,Math.min(10,v));';
  else if (idx === 'REMI') clamp = 'v=Math.max(-5,Math.min(5,v));';

  return `//VERSION=3
function setup(){return{input:[{bands:[${bi},"dataMask"],units:"REFLECTANCE"}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){
  if(!s.dataMask)return{data:[0],dataMask:[0]};
  ${cfg.code}
  ${clamp}
  if(isNaN(v)||!isFinite(v))return{data:[0],dataMask:[0]};
  return{data:[v],dataMask:[1]};
}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({
  status:'ok',
  service:'SatelliteApp Proxy v6 — Dynamic Band Mapping',
  queueEnabled:true,
  sentinelHub:!!(SENTINEL_ID&&SENTINEL_SEC),
  supportedDatasets: ['sentinel-2', 'landsat'],
  redEdgeIndices: RED_EDGE_INDICES
}));

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.trim() !== (APP_USERNAME||'').trim() || password.trim() !== (APP_PASSWORD||'').trim()) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token: jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' }), username });
});

// ─── USGS PROXY ──────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────────────────
// SENTINEL MAP — Renders colored index PNG, supports AOI polygon clipping
// Now with dynamic dataset switching (Sentinel-2 / Landsat)
// ──────────────────────────────────────────────────────────────────────────────
app.post('/sentinel/map', async (req, res) => {
  if (!requireJwt(req, res)) return;

  const { bbox, aoiGeometry, indexName, date, datasetType } = req.body;
  if (!bbox || !indexName) return res.status(400).json({ error: 'bbox and indexName required' });

  // Resolve dataset
  const ds = resolveDataset(datasetType);
  console.log(`[MAP] Index=${indexName}, Dataset=${ds.label}, Type=${ds.hubType}`);

  // UTFVI check
  if (indexName === 'UTFVI') return res.status(400).json({ error: 'UTFVI needs Landsat thermal band (B10). Sentinel-2 has no thermal sensor. Please use NDBaI or NDBI instead.' });

  // RED-EDGE SAFETY CHECK — Landsat cannot do MARINE, REMI, NDRE
  if (RED_EDGE_INDICES.includes(indexName) && !ds.hasRedEdge) {
    return res.status(400).json({
      error: `This index (${indexName}) requires Red-Edge bands, which are only available on Sentinel-2. Please switch to Sentinel-2 satellite data to use ${indexName}.`,
      redEdgeRequired: true
    });
  }

  const evalscript = getMapEvalscript(indexName, ds);
  if (!evalscript) return res.status(400).json({ error: 'Unknown index: ' + indexName });

  const { w, h } = calcDims(bbox);
  const d = new Date(date || new Date().toISOString().split('T')[0]);
  const from = new Date(d); from.setDate(d.getDate() - 25);
  const to   = new Date(d); to.setDate(d.getDate() + 25);

  const bounds = aoiGeometry
    ? { geometry: aoiGeometry, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } }
    : { bbox: [bbox.lon1,bbox.lat1,bbox.lon2,bbox.lat2], properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } };

  const payload = {
    input: {
      bounds,
      data: [{ type: ds.hubType, dataFilter:{ timeRange:{ from:from.toISOString().split('T')[0]+'T00:00:00Z', to:to.toISOString().split('T')[0]+'T23:59:59Z' }, maxCloudCoverage:65, mosaickingOrder:'leastCC' } }]
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
    res.json({ image:base64, mimeType:'image/png', width:w, height:h, dataset: ds.label });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────────
// SENTINEL STATISTICS — Returns numeric index values over time
// Now with dynamic dataset switching
// ──────────────────────────────────────────────────────────────────────────────
app.post('/sentinel/statistics', async (req, res) => {
  if (!requireJwt(req, res)) return;

  const { bbox, aoiGeometry, indexName, startDate, endDate, interval, datasetType } = req.body;
  if (!bbox||!indexName||!startDate||!endDate) return res.status(400).json({ error: 'bbox, indexName, startDate, endDate are required' });

  // Resolve dataset
  const ds = resolveDataset(datasetType);
  console.log(`[STATS] Index=${indexName}, Dataset=${ds.label}, Range=${startDate}→${endDate}`);

  // UTFVI check
  if (indexName==='UTFVI') return res.status(400).json({ error: 'UTFVI needs Landsat thermal band. Sentinel-2 has no thermal sensor. Use NDBaI or NDBI instead.' });

  // RED-EDGE SAFETY CHECK
  if (RED_EDGE_INDICES.includes(indexName) && !ds.hasRedEdge) {
    return res.status(400).json({
      error: `This index (${indexName}) requires Red-Edge bands, which are only available on Sentinel-2. Please switch to Sentinel-2 satellite data to use ${indexName}.`,
      redEdgeRequired: true
    });
  }

  const evalscript = getStatsEvalscript(indexName, ds);
  if (!evalscript) return res.status(400).json({ error: 'Unknown index: ' + indexName });

  const { w, h } = calcDims(bbox);
  const bounds = aoiGeometry
    ? { geometry:aoiGeometry, properties:{crs:'http://www.opengis.net/def/crs/EPSG/0/4326'} }
    : { bbox:[bbox.lon1,bbox.lat1,bbox.lon2,bbox.lat2], properties:{crs:'http://www.opengis.net/def/crs/EPSG/0/4326'} };

  const payload = {
    input: {
      bounds,
      data: [{ type: ds.hubType, dataFilter:{ timeRange:{ from:startDate+'T00:00:00Z', to:endDate+'T23:59:59Z' }, maxCloudCoverage:70 } }]
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

    res.json({ success:true, indexName, dataset: ds.label, points });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────────
// WMS TILE PROXY — Serves XYZ tiles via Sentinel Hub WMS for high-res map tiles
// Uses existing Sentinel Hub credentials (same account, no extra cost)
// GET /sentinel/tiles/:z/:x/:y?indexName=NDVI&date=2024-06-01&datasetType=sentinel-2
// ──────────────────────────────────────────────────────────────────────────────
app.get('/sentinel/tiles/:z/:x/:y', async (req, res) => {
  // JWT check via query param (tiles are loaded via img src URLs)
  const tokenParam = req.query.token;
  if (!tokenParam) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(tokenParam, JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { z, x, y } = req.params;
  const { indexName, date, datasetType } = req.query;
  if (!indexName) return res.status(400).json({ error: 'indexName required' });

  const ds = resolveDataset(datasetType);

  // Red-Edge safety
  if (RED_EDGE_INDICES.includes(indexName) && !ds.hasRedEdge) {
    return res.status(400).json({
      error: `${indexName} requires Red-Edge bands. Please switch to Sentinel-2.`,
      redEdgeRequired: true
    });
  }

  const evalscript = getMapEvalscript(indexName, ds);
  if (!evalscript) return res.status(400).json({ error: 'Unknown index: ' + indexName });

  // Convert XYZ tile coords to bbox (Web Mercator → WGS84)
  const n = Math.pow(2, parseInt(z));
  const lon1 = (parseInt(x) / n) * 360 - 180;
  const lon2 = ((parseInt(x) + 1) / n) * 360 - 180;
  const lat2Rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * parseInt(y) / n)));
  const lat1Rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (parseInt(y) + 1) / n)));
  const lat1 = lat1Rad * 180 / Math.PI;
  const lat2 = lat2Rad * 180 / Math.PI;

  const d = new Date(date || new Date().toISOString().split('T')[0]);
  const from = new Date(d); from.setDate(d.getDate() - 25);
  const to   = new Date(d); to.setDate(d.getDate() + 25);

  const payload = {
    input: {
      bounds: { bbox: [lon1, lat1, lon2, lat2], properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
      data: [{ type: ds.hubType, dataFilter: { timeRange: { from: from.toISOString().split('T')[0]+'T00:00:00Z', to: to.toISOString().split('T')[0]+'T23:59:59Z' }, maxCloudCoverage: 65, mosaickingOrder: 'leastCC' } }]
    },
    output: { width: 256, height: 256, responses: [{ identifier: 'default', format: { type: 'image/png' } }] },
    evalscript
  };

  try {
    const token = await getSentinelToken();
    const imgRes = await fetch('https://services.sentinel-hub.com/api/v1/process', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!imgRes.ok) { return res.status(imgRes.status).send('Tile fetch failed'); }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.send(buf);
  } catch(e) {
    console.error('[TILE ERROR]', e.message);
    res.status(500).send('Tile error');
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// INDEX INFO ENDPOINT — Returns interpretations, warnings, color ramps
// ──────────────────────────────────────────────────────────────────────────────
app.get('/index-info', (_, res) => {
  res.json({
    redEdgeIndices: RED_EDGE_INDICES,
    supportedDatasets: Object.keys(BAND_MAP).map(k => ({ key: k, label: BAND_MAP[k].label, hasRedEdge: BAND_MAP[k].hasRedEdge })),
    warnings: {
      CMRI: 'Warning: CMRI is valid only in coastal/mangrove regions. High inland values represent standard vegetation.',
      MVI: 'MVI is calibrated for mangrove forests. Inland values may not be meaningful.',
      MARINE: 'MARINE uses Red-Edge bands — Sentinel-2 only.',
      REMI: 'REMI uses Red-Edge bands — Sentinel-2 only.',
      NDRE: 'NDRE uses Red-Edge bands — Sentinel-2 only.'
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SatelliteApp Proxy v6 on port ${PORT}`);
  console.log(`Dynamic band mapping: Sentinel-2 + Landsat 8/9`);
  console.log(`Red-Edge indices (Sentinel-2 only): ${RED_EDGE_INDICES.join(', ')}`);
  console.log(`USGS queue: ENABLED`);
  console.log(`Sentinel Hub configured: ${!!(SENTINEL_ID && SENTINEL_SEC)}`);
});
