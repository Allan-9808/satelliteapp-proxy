const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const USGS_API = 'https://m2m.cr.usgs.gov/api/api/json/stable';
const USGS_USERNAME = process.env.USGS_USERNAME;
const USGS_TOKEN = process.env.USGS_TOKEN;
const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET || 'SatelliteApp2026SecretKey';
const SENTINEL_CLIENT_ID = process.env.SENTINEL_CLIENT_ID;
const SENTINEL_CLIENT_SECRET = process.env.SENTINEL_CLIENT_SECRET;

let usgsApiKey = null;
let usgsApiKeyExpiry = null;
let sentinelToken = null;
let sentinelTokenExpiry = null;

// SERVER-SIDE PROMISE QUEUE
let usgsQueueChain = Promise.resolve();
function queueUsgsRequest(fn) {
  const result = usgsQueueChain.then(() => fn()).catch(err => { throw err; });
  usgsQueueChain = result.catch(() => {});
  return result;
}

function fetchWithTimeout(url, options, ms = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getUsgsApiKey() {
  const now = Date.now();
  if (usgsApiKey && usgsApiKeyExpiry && now < usgsApiKeyExpiry) return usgsApiKey;
  console.log('[USGS] Refreshing API key...');
  const response = await fetchWithTimeout(`${USGS_API}/login-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USGS_USERNAME, token: USGS_TOKEN })
  }, 30000);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error('USGS non-JSON: ' + text.substring(0, 100)); }
  if (data.errorCode) throw new Error(data.errorCode + ': ' + data.errorMessage);
  usgsApiKey = data.data;
  usgsApiKeyExpiry = now + 90 * 60 * 1000;
  console.log('[USGS] API key refreshed, waiting 2s for slot to clear...');
  await sleep(2000);
  return usgsApiKey;
}

async function getSentinelToken() {
  if (!SENTINEL_CLIENT_ID || !SENTINEL_CLIENT_SECRET) throw new Error('Sentinel Hub credentials not configured');
  const now = Date.now();
  if (sentinelToken && sentinelTokenExpiry && now < sentinelTokenExpiry) return sentinelToken;
  const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: SENTINEL_CLIENT_ID, client_secret: SENTINEL_CLIENT_SECRET });
  const res = await fetch('https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Sentinel Hub auth failed: ' + JSON.stringify(data));
  sentinelToken = data.access_token;
  sentinelTokenExpiry = now + (data.expires_in - 60) * 1000;
  console.log('[SENTINEL] Token obtained');
  return sentinelToken;
}

/**
 * Calculates the minimum pixel width/height required for Sentinel Hub API calls
 * so that resolution never exceeds maxResMPerPx (default 1400 m/px for S2L2A).
 *
 * Scientific basis:
 *   1 degree latitude  ≈ 111,320 metres
 *   1 degree longitude ≈ 111,320 × cos(latitude) metres
 *
 * @param {object} bbox  - { lat1, lon1, lat2, lon2 }
 * @param {number} maxDim - Maximum pixels in any dimension (default 512, cap for cost)
 * @param {number} maxResMPerPx - Max metres per pixel allowed (1400 for S2L2A safety margin)
 * @returns {{ width: number, height: number }}
 */
function calcSentinelDimensions(bbox, maxDim, maxResMPerPx) {
  maxDim = maxDim || 512;
  maxResMPerPx = maxResMPerPx || 1400; // 1400 not 1500 — safety margin

  const midLat = (bbox.lat1 + bbox.lat2) / 2;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(midLat * Math.PI / 180);

  const widthM  = Math.abs(bbox.lon2 - bbox.lon1) * metersPerDegLon;
  const heightM = Math.abs(bbox.lat2 - bbox.lat1) * metersPerDegLat;

  // Minimum pixels to stay under maxResMPerPx
  const minW = Math.ceil(widthM  / maxResMPerPx) + 2;
  const minH = Math.ceil(heightM / maxResMPerPx) + 2;

  // Cap at maxDim (to control processing cost), but never go below minimum
  const width  = Math.min(maxDim, Math.max(minW, 32));
  const height = Math.min(maxDim, Math.max(minH, 32));

  console.log(`[DIMS] BBox: ${(widthM/1000).toFixed(1)}km×${(heightM/1000).toFixed(1)}km → ${width}×${height}px (${(widthM/width).toFixed(0)}m/px)`);
  return { width, height };
}

function getProcessEvalscript(indexName) {
  const SCRIPTS = {
    NDVI: {
      bands: ["B04","B08"],
      compute: "let v=(s.B08-s.B04)/(s.B08+s.B04+1e-6);",
      colors: "colorBlend(v,[-0.2,0,0.2,0.4,0.6,0.8],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]])"
    },
    NDWI: {
      bands: ["B03","B08"],
      compute: "let v=(s.B03-s.B08)/(s.B03+s.B08+1e-6);",
      colors: "colorBlend(v,[-0.6,-0.3,0,0.2,0.4,0.6],[[0.94,0.97,1],[0.75,0.89,0.97],[0.50,0.74,0.90],[0.22,0.55,0.80],[0.06,0.35,0.67],[0,0.19,0.52]])"
    },
    MNDWI: {
      bands: ["B03","B11"],
      compute: "let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);",
      colors: "colorBlend(v,[-0.6,-0.3,0,0.2,0.4,0.6],[[0.94,0.97,1],[0.75,0.89,0.97],[0.50,0.74,0.90],[0.22,0.55,0.80],[0.06,0.35,0.67],[0,0.19,0.52]])"
    },
    NDBI: {
      bands: ["B08","B11"],
      compute: "let v=(s.B11-s.B08)/(s.B11+s.B08+1e-6);",
      colors: "colorBlend(v,[-0.5,-0.2,0,0.2,0.4,0.6],[[0.13,0.55,0.13],[0.56,0.73,0.56],[0.96,0.96,0.86],[0.85,0.75,0.50],[0.70,0.50,0.20],[0.55,0.25,0.08]])"
    },
    EVI: {
      bands: ["B02","B04","B08"],
      compute: "let v=2.5*(s.B08-s.B04)/(s.B08+6*s.B04-7.5*s.B02+1+1e-6);",
      colors: "colorBlend(v,[-0.2,0,0.2,0.4,0.6,0.9],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]])"
    },
    SAVI: {
      bands: ["B04","B08"],
      compute: "let v=1.5*(s.B08-s.B04)/(s.B08+s.B04+0.5+1e-6);",
      colors: "colorBlend(v,[-0.2,0,0.2,0.4,0.6,0.9],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]])"
    },
    GNDVI: {
      bands: ["B03","B08"],
      compute: "let v=(s.B08-s.B03)/(s.B08+s.B03+1e-6);",
      colors: "colorBlend(v,[-0.2,0,0.2,0.4,0.6,0.8],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]])"
    },
    NDMI: {
      bands: ["B08","B11"],
      compute: "let v=(s.B08-s.B11)/(s.B08+s.B11+1e-6);",
      colors: "colorBlend(v,[-0.8,-0.4,0,0.2,0.4,0.8],[[0.92,0.76,0.45],[0.98,0.94,0.82],[0.92,0.97,1.0],[0.55,0.82,0.97],[0.14,0.59,0.90],[0,0.25,0.62]])"
    },
    NDBaI: {
      bands: ["B11","B12"],
      compute: "let v=(s.B11-s.B12)/(s.B11+s.B12+1e-6);",
      colors: "colorBlend(v,[-0.6,-0.3,0,0.2,0.4,0.6],[[0.13,0.55,0.13],[0.64,0.84,0.64],[0.97,0.97,0.88],[0.94,0.82,0.55],[0.76,0.54,0.22],[0.55,0.27,0.07]])"
    },
    BSI: {
      bands: ["B02","B04","B08","B11"],
      compute: "let v=((s.B11+s.B04)-(s.B08+s.B02))/((s.B11+s.B04)+(s.B08+s.B02)+1e-6);",
      colors: "colorBlend(v,[-0.6,-0.3,0,0.1,0.3,0.5],[[0.13,0.55,0.13],[0.64,0.84,0.64],[0.96,0.96,0.86],[0.94,0.82,0.55],[0.76,0.54,0.22],[0.55,0.27,0.07]])"
    },
    NDRE: {
      bands: ["B04","B05"],
      compute: "let v=(s.B05-s.B04)/(s.B05+s.B04+1e-6);",
      colors: "colorBlend(v,[-0.2,0,0.2,0.4,0.6,0.8],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]])"
    },
    NDSI: {
      bands: ["B03","B11"],
      compute: "let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);",
      colors: "colorBlend(v,[-0.6,-0.3,0,0.2,0.4,0.8],[[0.65,0.33,0.16],[0.86,0.63,0.40],[0.98,0.92,0.84],[0.80,0.93,0.97],[0.55,0.85,0.97],[0.95,0.97,1.0]])"
    },
    OSAVI: {
      bands: ["B04","B08"],
      compute: "let v=(s.B08-s.B04)/(s.B08+s.B04+0.16);",
      colors: "colorBlend(v,[-0.2,0,0.2,0.4,0.6,0.9],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]])"
    },
    MSAVI: {
      bands: ["B04","B08"],
      compute: "let x=2*s.B08+1; let v=(x-Math.sqrt(Math.max(0,x*x-8*(s.B08-s.B04))))/2;",
      colors: "colorBlend(v,[-0.2,0,0.2,0.4,0.6,0.9],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]])"
    },
    CMRI: {
      bands: ["B03","B04","B08","B11"],
      compute: "let ndvi=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mndwi=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=ndvi-mndwi;",
      colors: "colorBlend(v,[-1.5,-0.5,0,0.5,1.0,1.5],[[0.0,0.19,0.52],[0.22,0.55,0.80],[0.90,0.90,0.65],[0.46,0.72,0.26],[0.08,0.53,0.08],[0,0.3,0]])"
    },
    MMRI: {
      bands: ["B03","B04","B08","B11"],
      compute: "let ndvi=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mndwi=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=Math.abs(mndwi)/(Math.abs(mndwi)+Math.abs(ndvi)+1e-6);",
      colors: "colorBlend(v,[0,0.2,0.4,0.6,0.8,1.0],[[0.94,0.97,1],[0.58,0.80,0.92],[0.16,0.58,0.73],[0.04,0.39,0.27],[0.02,0.27,0.16],[0,0.15,0.08]])"
    },
    MVI: {
      bands: ["B03","B08","B11"],
      compute: "let denom=s.B11-s.B03; let v=(Math.abs(denom)<1e-6)?0:(s.B08-s.B03)/denom; v=Math.max(0,Math.min(10,v));",
      colors: "colorBlend(v,[0,1,2,4,6,10],[[0.98,0.92,0.84],[0.80,0.91,0.66],[0.46,0.72,0.26],[0.16,0.55,0.16],[0.04,0.38,0.12],[0,0.20,0.05]])"
    },
  };

  const cfg = SCRIPTS[indexName] || SCRIPTS['NDVI'];
  const bandsInput = cfg.bands.map(b => `"${b}"`).join(',');

  // CRITICAL: 4-channel RGBA output so no-data pixels are transparent (not white)
  return `//VERSION=3
function setup() {
  return {
    input: [{ bands: [${bandsInput},"dataMask"], units: "REFLECTANCE" }],
    output: { bands: 4, sampleType: "AUTO" }
  };
}
function evaluatePixel(s) {
  if (!s.dataMask) return [0.16, 0.16, 0.20, 0];
  ${cfg.compute}
  if (isNaN(v) || !isFinite(v)) return [0.16, 0.16, 0.20, 0];
  let rgb = ${cfg.colors};
  return [...rgb, 1];
}`;
}

// ── JWT auth middleware ─────────────────────────────────────────
function requireAuth(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'No token' }); return null; }
  try { return jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
  catch(e) { res.status(401).json({ error: 'Invalid token' }); return null; }
}

// ── Health check ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SatelliteApp Proxy', usgsConfigured: !!(USGS_USERNAME && USGS_TOKEN), sentinelHub: !!(SENTINEL_CLIENT_ID && SENTINEL_CLIENT_SECRET), queueEnabled: true, statisticsEnabled: true });
});

// ── App login ───────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.trim() !== APP_USERNAME.trim() || password.trim() !== APP_PASSWORD.trim()) return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
  console.log(`[LOGIN] ${username} authenticated`);
  res.json({ token, username });
});

// ── USGS proxy ──────────────────────────────────────────────────
app.post('/usgs/:endpoint', async (req, res) => {
  const decoded = requireAuth(req, res); if (!decoded) return;
  const endpoint = req.params.endpoint;
  console.log(`[USGS] ${decoded.username} -> ${endpoint} (queued)`);

  try {
    const data = await queueUsgsRequest(async () => {
      const apiKey = await getUsgsApiKey();
      const makeReq = (key) => fetchWithTimeout(`${USGS_API}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': key },
        body: JSON.stringify(req.body)
      }, 45000);

      let response = await makeReq(apiKey);
      let result;
      try { result = JSON.parse(await response.text()); }
      catch(e) { throw new Error('USGS invalid JSON response'); }

      if (result.errorCode === 'CONCURRENT_REQUEST_LIMIT' ||
          (result.errorMessage || '').toLowerCase().includes('multiple requests')) {
        console.log('[USGS] CONCURRENT -> waiting 6s then retrying...');
        await sleep(6000);
        response = await makeReq(apiKey);
        try { result = JSON.parse(await response.text()); }
        catch(e) { throw new Error('USGS invalid JSON on retry'); }
      }

      if (result.errorCode === 'UNAUTHORIZED_USER' || result.errorCode === 'AUTH_INVALID') {
        console.log('[USGS] Auth expired -> refreshing...');
        usgsApiKey = null; usgsApiKeyExpiry = null;
        const newKey = await getUsgsApiKey();
        response = await makeReq(newKey);
        try { result = JSON.parse(await response.text()); }
        catch(e) { throw new Error('USGS invalid JSON after auth refresh'); }
      }

      console.log(`[USGS] ${endpoint} complete, error: ${result.errorCode || 'none'}`);
      return result;
    });
    res.json(data);
  } catch(err) {
    console.error(`[USGS] Error:`, err.message);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'USGS request timed out. Please try again in 30 seconds.' });
    res.status(500).json({ error: err.message });
  }
});

// ── Sentinel Hub Index Map (FIXED evalscript) ───────────────────
app.post('/sentinel/map', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { bbox, indexName } = req.body;
  // date is optional — if not provided, use "most recent available" via wide window
  const requestedDate = req.body.date; // optional YYYY-MM-DD

  if (!bbox || !indexName) return res.status(400).json({ error: 'bbox and indexName required' });

  // UTFVI requires thermal band not in S2 — reject gracefully
  if (indexName === 'UTFVI') {
    return res.status(400).json({ error: 'UTFVI requires Landsat thermal band (B10), which is not available in Sentinel-2. Please use NDBaI or BSI as a soil/surface alternative.' });
  }

  // Calculate dimensions dynamically — FIX FOR RESOLUTION ERROR
  const { width, height } = calcSentinelDimensions(bbox, 512, 1400);

  // Date range: use ±20 days around requested date, or last 30 days if no date given
  let fromDate, toDate;
  if (requestedDate) {
    const d = new Date(requestedDate);
    const from = new Date(d); from.setDate(d.getDate() - 20);
    const to   = new Date(d); to.setDate(d.getDate() + 20);
    fromDate = from.toISOString().split('T')[0] + 'T00:00:00Z';
    toDate   = to.toISOString().split('T')[0]   + 'T23:59:59Z';
  } else {
    const now = new Date();
    const from = new Date(now); from.setDate(now.getDate() - 30);
    fromDate = from.toISOString().split('T')[0] + 'T00:00:00Z';
    toDate   = now.toISOString().split('T')[0]  + 'T23:59:59Z';
  }

  const rawEvalscript = getProcessEvalscript(indexName);

  const payload = {
    input: {
      bounds: {
        bbox: [bbox.lon1, bbox.lat1, bbox.lon2, bbox.lat2],
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' }
      },
      data: [{
        type: 'sentinel-2-l2a',
        dataFilter: {
          timeRange: { from: fromDate, to: toDate },
          maxCloudCoverage: 60,
          mosaickingOrder: 'leastCC'  // prefer least cloud cover in date range
        }
      }]
    },
    output: {
      width,
      height,
      responses: [{ identifier: 'default', format: { type: 'image/png' } }]
    },
    evalscript: rawEvalscript  // ← PLAIN TEXT, never base64 or data URI
  };

  try {
    const token = await getSentinelToken();
    const imgRes = await fetch('https://services.sentinel-hub.com/api/v1/process', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!imgRes.ok) {
      const errText = await imgRes.text();
      console.error('[SENTINEL MAP] Error:', errText.substring(0, 300));
      return res.status(imgRes.status).json({ error: 'Sentinel map error: ' + errText.substring(0, 200) });
    }

    const base64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
    res.json({ image: base64, mimeType: 'image/png', width, height, bbox });
  } catch(err) {
    console.error('[SENTINEL MAP] Fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Sentinel Hub Statistics API (NEW — real index values) ───────
const STATS_SCRIPTS = {
  NDVI:  { bands:["B04","B08"],             script:"let v=(s.B08-s.B04)/(s.B08+s.B04+1e-6);" },
  NDWI:  { bands:["B03","B08"],             script:"let v=(s.B03-s.B08)/(s.B03+s.B08+1e-6);" },
  MNDWI: { bands:["B03","B11"],             script:"let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);" },
  NDBI:  { bands:["B08","B11"],             script:"let v=(s.B11-s.B08)/(s.B11+s.B08+1e-6);" },
  EVI:   { bands:["B02","B04","B08"],       script:"let v=2.5*(s.B08-s.B04)/(s.B08+6*s.B04-7.5*s.B02+1+1e-6);v=Math.max(-1,Math.min(2,v));" },
  SAVI:  { bands:["B04","B08"],             script:"let v=1.5*(s.B08-s.B04)/(s.B08+s.B04+0.5+1e-6);" },
  GNDVI: { bands:["B03","B08"],             script:"let v=(s.B08-s.B03)/(s.B08+s.B03+1e-6);" },
  NDMI:  { bands:["B08","B11"],             script:"let v=(s.B08-s.B11)/(s.B08+s.B11+1e-6);" },
  BSI:   { bands:["B02","B04","B08","B11"], script:"let v=((s.B11+s.B04)-(s.B08+s.B02))/((s.B11+s.B04)+(s.B08+s.B02)+1e-6);" },
  NDSI:  { bands:["B03","B11"],             script:"let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);" },
  OSAVI: { bands:["B04","B08"],             script:"let v=(s.B08-s.B04)/(s.B08+s.B04+0.16);" },
  MSAVI: { bands:["B04","B08"],             script:"let x=2*s.B08+1;let v=(x-Math.sqrt(Math.max(0,x*x-8*(s.B08-s.B04))))/2;" },
  NDBaI: { bands:["B11","B12"],             script:"let v=(s.B11-s.B12)/(s.B11+s.B12+1e-6);" },
  NDRE:  { bands:["B04","B05"],             script:"let v=(s.B05-s.B04)/(s.B05+s.B04+1e-6);" },
  CMRI:  { bands:["B03","B04","B08","B11"], script:"let ndvi=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mndwi=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=ndvi-mndwi;" },
  MMRI:  { bands:["B03","B04","B08","B11"], script:"let ndvi=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mndwi=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=Math.abs(mndwi)/(Math.abs(mndwi)+Math.abs(ndvi)+1e-6);" },
  MVI:   { bands:["B03","B08","B11"],       script:"let denom=s.B11-s.B03;let v=Math.abs(denom)<1e-6?0:(s.B08-s.B03)/denom;v=Math.max(0,Math.min(20,v));" },
};

app.post('/sentinel/statistics', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { bbox, aoiGeometry, indexName, startDate, endDate, interval } = req.body;
  if (!bbox || !indexName || !startDate || !endDate) {
    return res.status(400).json({ error: 'bbox, indexName, startDate, endDate required' });
  }

  if (indexName === 'UTFVI') {
    return res.status(400).json({ error: 'UTFVI requires Landsat thermal band (B10) not available in Sentinel-2. Use NDBaI instead.' });
  }

  const cfg = STATS_SCRIPTS[indexName];
  if (!cfg) return res.status(400).json({ error: `Unknown index: ${indexName}` });

  // Dynamic dimensions — THE FIX
  const { width, height } = calcSentinelDimensions(bbox, 512, 1400);

  const bandsInput = cfg.bands.map(b => `"${b}"`).join(',');
  const rawEvalscript = `//VERSION=3
function setup() {
  return {
    input: [{ bands: [${bandsInput},"dataMask"], units: "REFLECTANCE" }],
    output: [
      { id: "data", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  if (!s.dataMask) return { data: [0], dataMask: [0] };
  ${cfg.script}
  if (isNaN(v) || !isFinite(v)) return { data: [0], dataMask: [0] };
  return { data: [v], dataMask: [1] };
}`;

  const bounds = aoiGeometry
    ? { geometry: aoiGeometry, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } }
    : { bbox: [bbox.lon1, bbox.lat1, bbox.lon2, bbox.lat2], properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } };

  const payload = {
    input: {
      bounds,
      data: [{
        type: 'sentinel-2-l2a',
        dataFilter: {
          timeRange: { from: startDate + 'T00:00:00Z', to: endDate + 'T23:59:59Z' },
          maxCloudCoverage: 70
        }
      }]
    },
    aggregation: {
      timeRange: { from: startDate + 'T00:00:00Z', to: endDate + 'T23:59:59Z' },
      aggregationInterval: { of: interval || 'P1M' },
      width,
      height,
      evalscript: rawEvalscript  // ← PLAIN TEXT
    },
    calculations: { default: { histograms: {}, statistics: {} } }
  };

  try {
    const token = await getSentinelToken();
    const statRes = await fetch('https://services.sentinel-hub.com/api/v1/statistics', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const rawText = await statRes.text();
    let data;
    try { data = JSON.parse(rawText); } catch(e) {
      return res.status(500).json({ error: 'Sentinel Stats returned non-JSON: ' + rawText.substring(0, 200) });
    }

    if (!statRes.ok) {
      return res.status(statRes.status).json({ error: 'Sentinel Stats error: ' + JSON.stringify(data).substring(0, 300) });
    }

    // Extract clean data points from the Statistics API response
    const points = (data.data || []).map(interval => {
      const stats = interval?.outputs?.data?.bands?.B0?.stats;
      if (!stats || stats.sampleCount === 0 || stats.noDataCount === stats.sampleCount) return null;
      return {
        date: interval.interval?.from?.split('T')[0] || '',
        mean:     parseFloat(stats.mean?.toFixed(4)  || 0),
        min:      parseFloat(stats.min?.toFixed(4)   || 0),
        max:      parseFloat(stats.max?.toFixed(4)   || 0),
        stDev:    parseFloat(stats.stDev?.toFixed(4) || 0),
        count:    stats.sampleCount - stats.noDataCount,
      };
    }).filter(p => p !== null);

    res.json({ success: true, indexName, points, totalIntervals: data.data?.length || 0 });
  } catch(err) {
    console.error('[SENTINEL STATS] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SatelliteApp Proxy on port ${PORT}`);
  console.log(`USGS queue: ENABLED`);
});
