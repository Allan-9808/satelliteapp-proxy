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
  const decoded = requireAuth(req, res); if (!decoded) return;
  const { bbox, date, indexName, width = 512, height = 512, cloudCover } = req.body;
  if (!bbox || !date || !indexName) return res.status(400).json({ error: 'bbox, date, indexName required' });

  const evalscripts = {
    NDVI:  'return colorBlend((B08-B04)/(B08+B04),[-0.2,0,0.2,0.4,0.6,0.8],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    NDWI:  'return colorBlend((B03-B08)/(B03+B08),[-0.6,-0.3,0,0.2,0.4,0.6],[[0.94,0.97,1],[0.75,0.89,0.97],[0.50,0.74,0.90],[0.22,0.55,0.80],[0.06,0.35,0.67],[0,0.19,0.52]]);',
    NDBI:  'return colorBlend((B11-B08)/(B11+B08),[-0.5,-0.2,0,0.2,0.4,0.6],[[0.13,0.55,0.13],[0.56,0.73,0.56],[0.96,0.96,0.86],[0.85,0.75,0.50],[0.70,0.50,0.20],[0.55,0.25,0.08]]);',
    EVI:   'let evi=2.5*(B08-B04)/(B08+6*B04-7.5*B02+1); return colorBlend(evi,[-0.2,0,0.2,0.4,0.6,0.9],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    SAVI:  'let savi=((B08-B04)/(B08+B04+0.5))*1.5; return colorBlend(savi,[-0.2,0,0.2,0.4,0.6,0.9],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    MNDWI: 'return colorBlend((B03-B11)/(B03+B11),[-0.6,-0.3,0,0.2,0.4,0.6],[[0.94,0.97,1],[0.75,0.89,0.97],[0.50,0.74,0.90],[0.22,0.55,0.80],[0.06,0.35,0.67],[0,0.19,0.52]]);',
    NDMI:  'return colorBlend((B08-B11)/(B08+B11),[-0.5,-0.2,0,0.2,0.4,0.6],[[0.85,0.75,0.50],[0.90,0.90,0.80],[0.95,0.95,0.90],[0.56,0.82,0.56],[0.18,0.65,0.40],[0,0.5,0.2]]);',
    BSI:   'let bsi=((B11+B04)-(B08+B02))/((B11+B04)+(B08+B02)); return colorBlend(bsi,[-0.4,-0.1,0,0.1,0.3,0.5],[[0.13,0.55,0.13],[0.50,0.73,0.50],[0.96,0.96,0.86],[0.85,0.75,0.50],[0.70,0.50,0.20],[0.55,0.25,0.08]]);',
    OSAVI: 'let osavi=(B08-B04)/(B08+B04+0.16); return colorBlend(osavi,[-0.2,0,0.2,0.4,0.6,0.8],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    MSAVI: 'let x=(2*B08+1);let msavi=(x-Math.sqrt(Math.max(0,x*x-8*(B08-B04))))/2; return colorBlend(msavi,[-0.2,0,0.2,0.4,0.6,0.8],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    NDSI:  'return colorBlend((B03-B11)/(B03+B11),[-0.5,-0.2,0,0.2,0.5,0.8],[[0.55,0.25,0.08],[0.85,0.75,0.50],[0.96,0.96,0.86],[0.80,0.90,1.0],[0.50,0.75,1.0],[0.30,0.55,0.90]]);',
    GNDVI: 'return colorBlend((B08-B03)/(B08+B03),[-0.2,0,0.2,0.4,0.6,0.8],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    NDRE:  'return colorBlend((B06-B04)/(B06+B04),[-0.2,0,0.1,0.3,0.5,0.7],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    NDBaI: 'return colorBlend((B11-B12)/(B11+B12),[-0.4,-0.1,0,0.1,0.3,0.5],[[0.13,0.55,0.13],[0.50,0.73,0.50],[0.96,0.96,0.86],[0.85,0.75,0.50],[0.70,0.50,0.20],[0.55,0.25,0.08]]);',
    MVI:   'let mvi=(B08-B03)/(B11-B03+0.0001); return colorBlend(mvi,[0,2,4,6,10,20],[[0.96,0.96,0.86],[0.70,0.88,0.70],[0.40,0.75,0.40],[0.18,0.65,0.18],[0,0.50,0],[0,0.30,0]]);',
    CMRI:  'let ndvi2=(B08-B04)/(B08+B04);let mndwi2=(B03-B11)/(B03+B11);let cmri=ndvi2-mndwi2;return colorBlend(cmri,[-1,-0.3,0,0.3,0.6,1.2],[[0.06,0.35,0.67],[0.50,0.74,0.90],[0.96,0.96,0.86],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    MMRI:  'let ndvi3=(B08-B04)/(B08+B04);let mndwi3=(B03-B11)/(B03+B11);let mmri=Math.abs(mndwi3)/(Math.abs(mndwi3)+Math.abs(ndvi3)+0.0001);return colorBlend(mmri,[0,0.2,0.4,0.6,0.8,1],[[0,0.4,0],[0.18,0.65,0.18],[0.56,0.82,0.31],[1,1,0.88],[0.50,0.74,0.90],[0.06,0.35,0.67]]);',
    UTFVI: 'return [B04*3, B03*3, B02*3];',
  };

  const script = evalscripts[indexName] || evalscripts['NDVI'];
  // Build bands list based on what the script uses
  const allBands = ["B02","B03","B04","B06","B08","B11","B12"];
  const usedBands = allBands.filter(b => script.includes(b));
  if (usedBands.length === 0) usedBands.push("B02","B03","B04","B08","B11");

  // FIXED: evalscript is PLAIN TEXT, NOT base64, NOT data URI
  const evalscript = `//VERSION=3
function setup(){return{input:[${usedBands.map(b=>'"'+b+'"').join(',')}],output:{bands:3}}}
function evaluatePixel(s){let ${usedBands.map(b=>b+'=s.'+b).join(',')};${script}}`;

  const maxCloud = typeof cloudCover === 'number' ? cloudCover : 100;

  try {
    const token = await getSentinelToken();
    const payload = {
      input: {
        bounds: { bbox: [bbox.lon1,bbox.lat1,bbox.lon2,bbox.lat2], properties:{crs:'http://www.opengis.net/def/crs/EPSG/0/4326'} },
        data: [{ type:'sentinel-2-l2a', dataFilter:{ timeRange:{ from:date+'T00:00:00Z', to:date+'T23:59:59Z' }, maxCloudCoverage: maxCloud }}]
      },
      output: { width, height, responses:[{ identifier:'default', format:{ type:'image/png' }}] },
      evalscript: evalscript
    };
    console.log(`[SENTINEL/MAP] ${indexName} for ${date}, cloud<=${maxCloud}%`);
    const imgRes = await fetch('https://services.sentinel-hub.com/api/v1/process', {
      method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(payload)
    });
    if (!imgRes.ok) {
      const e = await imgRes.text();
      console.error('[SENTINEL/MAP] Error:', e.substring(0,300));
      return res.status(imgRes.status).json({ error: 'Sentinel: ' + e.substring(0,300) });
    }
    const base64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
    res.json({ image: base64, mimeType: 'image/png' });
  } catch(err) {
    console.error('[SENTINEL/MAP] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Sentinel Hub Statistics API (NEW — real index values) ───────
const INDEX_EVALSCRIPTS = {
  NDVI:  { bands:["B04","B08"],            script:"let v=(s.B08-s.B04)/(s.B08+s.B04+1e-6);" },
  NDWI:  { bands:["B03","B08"],            script:"let v=(s.B03-s.B08)/(s.B03+s.B08+1e-6);" },
  MNDWI: { bands:["B03","B11"],            script:"let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);" },
  NDBI:  { bands:["B08","B11"],            script:"let v=(s.B11-s.B08)/(s.B11+s.B08+1e-6);" },
  EVI:   { bands:["B02","B04","B08"],      script:"let v=2.5*(s.B08-s.B04)/(s.B08+6*s.B04-7.5*s.B02+1+1e-6);" },
  SAVI:  { bands:["B04","B08"],            script:"let v=1.5*(s.B08-s.B04)/(s.B08+s.B04+0.5+1e-6);" },
  GNDVI: { bands:["B03","B08"],            script:"let v=(s.B08-s.B03)/(s.B08+s.B03+1e-6);" },
  NDMI:  { bands:["B08","B11"],            script:"let v=(s.B08-s.B11)/(s.B08+s.B11+1e-6);" },
  BSI:   { bands:["B02","B04","B08","B11"],script:"let v=((s.B11+s.B04)-(s.B08+s.B02))/((s.B11+s.B04)+(s.B08+s.B02)+1e-6);" },
  NDSI:  { bands:["B03","B11"],            script:"let v=(s.B03-s.B11)/(s.B03+s.B11+1e-6);" },
  OSAVI: { bands:["B04","B08"],            script:"let v=(s.B08-s.B04)/(s.B08+s.B04+0.16);" },
  MSAVI: { bands:["B04","B08"],            script:"let x=(2*s.B08+1);let v=(x-Math.sqrt(Math.max(0,x*x-8*(s.B08-s.B04))))/2;" },
  NDRE:  { bands:["B04","B06"],            script:"let v=(s.B06-s.B04)/(s.B06+s.B04+1e-6);" },
  NDBaI: { bands:["B11","B12"],            script:"let v=(s.B11-s.B12)/(s.B11+s.B12+1e-6);" },
  CMRI:  { bands:["B03","B04","B08","B11"],script:"let ndvi=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mndwi=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=ndvi-mndwi;" },
  MMRI:  { bands:["B03","B04","B08","B11"],script:"let ndvi=(s.B08-s.B04)/(s.B08+s.B04+1e-6);let mndwi=(s.B03-s.B11)/(s.B03+s.B11+1e-6);let v=Math.abs(mndwi)/(Math.abs(mndwi)+Math.abs(ndvi)+1e-6);" },
  MVI:   { bands:["B03","B08","B11"],      script:"let v=(s.B08-s.B03)/(s.B11-s.B03+1e-6);" },
  UTFVI: { bands:["B04","B08","B11"],      script:"let v=(s.B11-s.B08)/(s.B11+s.B08+1e-6);" },
};

app.post('/sentinel/statistics', async (req, res) => {
  const decoded = requireAuth(req, res); if (!decoded) return;
  const { bbox, aoiGeometry, indexName, startDate, endDate, interval } = req.body;
  if (!bbox || !indexName || !startDate || !endDate) {
    return res.status(400).json({ error: 'bbox, indexName, startDate, endDate required' });
  }

  const idxConfig = INDEX_EVALSCRIPTS[indexName];
  if (!idxConfig) return res.status(400).json({ error: `Unknown index: ${indexName}` });

  const bandsInput = idxConfig.bands.map(b => `"${b}"`).join(',');
  const validChecks = idxConfig.bands.map(b => `s.${b} > 0`).join(' && ');

  const evalscript = `//VERSION=3
function setup() {
  return {
    input: [{ bands: [${bandsInput}], units: "REFLECTANCE" }],
    output: [
      { id: "data", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  ${idxConfig.script}
  let valid = (${validChecks}) ? 1 : 0;
  return { data: [isNaN(v) ? 0 : v], dataMask: [valid] };
}`;

  const bounds = aoiGeometry
    ? { geometry: aoiGeometry, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } }
    : { bbox: [bbox.lon1, bbox.lat1, bbox.lon2, bbox.lat2], properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } };

  const payload = {
    input: {
      bounds,
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: {
          timeRange: { from: startDate + "T00:00:00Z", to: endDate + "T23:59:59Z" },
          maxCloudCoverage: 80
        }
      }]
    },
    aggregation: {
      timeRange: { from: startDate + "T00:00:00Z", to: endDate + "T23:59:59Z" },
      aggregationInterval: { of: interval || "P1M" },
      width: 100,
      height: 100,
      evalscript: evalscript
    },
    calculations: { default: {} }
  };

  try {
    const token = await getSentinelToken();
    console.log(`[SENTINEL/STATS] ${indexName} ${startDate} to ${endDate} interval=${interval||'P1M'}`);
    const statRes = await fetch('https://services.sentinel-hub.com/api/v1/statistics', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const rawText = await statRes.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch(e) { return res.status(500).json({ error: 'Sentinel non-JSON: ' + rawText.substring(0,200) }); }
    if (!statRes.ok) {
      console.error('[SENTINEL/STATS] Error:', JSON.stringify(data).substring(0,300));
      return res.status(statRes.status).json({ error: 'Sentinel Stats error: ' + JSON.stringify(data).substring(0,300) });
    }
    console.log(`[SENTINEL/STATS] Got ${(data.data || []).length} intervals`);
    res.json({ success: true, data: data.data || [] });
  } catch(err) {
    console.error('[SENTINEL/STATS] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SatelliteApp Proxy on port ${PORT}`);
  console.log(`USGS queue: ENABLED`);
  console.log(`Sentinel Hub: ${!!(SENTINEL_CLIENT_ID && SENTINEL_CLIENT_SECRET)}`);
  console.log(`Statistics API: ENABLED`);
});
