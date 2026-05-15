const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const MAIN_BACKEND_URL = 'https://alertachart-backend-production.up.railway.app/api/webhooks/fast-listing';
const MAIN_BACKEND_HISTORY_URL = 'https://alertachart-backend-production.up.railway.app/api/exchange-listings';
const WEBHOOK_SECRET = 'd0cc02ad4e52771cb9419aefbf4f35474e7010047c6894590d8e21ceb9fb692f';

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

let recentListings = [];
let recentLiquidations = []; // Likidasyon hafızası

// === 📈 YÜKSEK PERFORMANSLI IN-MEMORY ROLLING STATS ===
let minBuckets = {};  // Dakikalık hacim havuzu (15dk için)
let hourBuckets = {}; // Saatlik hacim havuzu (1s, 4s, 1w için)

function addLiquidationToStats(usdValue, timestamp, side) {
  const ts = Number(timestamp) || Date.now();
  const minTs = Math.floor(ts / 60000) * 60000;
  const hourTs = Math.floor(ts / 3600000) * 3600000;

  const sideUp = String(side || '').toUpperCase();
  // Alerta Chart Standard: Longs (Sells) ve Shorts (Buys) ayrımı
  const isShort = sideUp === 'BUY' || sideUp === 'SHORT';
  const longsVal = isShort ? 0 : usdValue;
  const shortsVal = isShort ? usdValue : 0;

  // Dakikalık havuz güncellemesi
  if (!minBuckets[minTs]) {
    minBuckets[minTs] = { total: 0, longs: 0, shorts: 0 };
  }
  minBuckets[minTs].total += usdValue;
  minBuckets[minTs].longs += longsVal;
  minBuckets[minTs].shorts += shortsVal;

  // Saatlik havuz güncellemesi
  if (!hourBuckets[hourTs]) {
    hourBuckets[hourTs] = { total: 0, longs: 0, shorts: 0 };
  }
  hourBuckets[hourTs].total += usdValue;
  hourBuckets[hourTs].longs += longsVal;
  hourBuckets[hourTs].shorts += shortsVal;

  // Hafızayı korumak için eski havuzları temizle
  const now = Date.now();
  const maxMinTime = now - 16 * 60000; // 16 dk sakla
  for (const key in minBuckets) {
    if (parseInt(key) < maxMinTime) delete minBuckets[key];
  }

  const maxHourTime = now - 169 * 3600000; // 169 saat sakla (yaklaşık 7 gün)
  for (const key in hourBuckets) {
    if (parseInt(key) < maxHourTime) delete hourBuckets[key];
  }
}

function getRollingStats() {
  const now = Date.now();
  const stats = {
    v15m: { total: 0, longs: 0, shorts: 0 },
    v1h: { total: 0, longs: 0, shorts: 0 },
    v4h: { total: 0, longs: 0, shorts: 0 },
    v1w: { total: 0, longs: 0, shorts: 0 }
  };

  const time15m = now - 15 * 60000;
  const time1h = now - 60 * 60000;
  const time4h = now - 4 * 3600000;
  const time1w = now - 7 * 24 * 3600000;

  // 15dk'lık topla
  for (const [tsStr, bucket] of Object.entries(minBuckets)) {
    const ts = parseInt(tsStr);
    if (ts >= time15m && bucket) {
      stats.v15m.total += bucket.total;
      stats.v15m.longs += bucket.longs;
      stats.v15m.shorts += bucket.shorts;
    }
  }

  // 1s, 4s ve 1 haftalık topla
  for (const [tsStr, bucket] of Object.entries(hourBuckets)) {
    const ts = parseInt(tsStr);
    if (bucket) {
      if (ts >= time1h) {
        stats.v1h.total += bucket.total;
        stats.v1h.longs += bucket.longs;
        stats.v1h.shorts += bucket.shorts;
      }
      if (ts >= time4h) {
        stats.v4h.total += bucket.total;
        stats.v4h.longs += bucket.longs;
        stats.v4h.shorts += bucket.shorts;
      }
      if (ts >= time1w) {
        stats.v1w.total += bucket.total;
        stats.v1w.longs += bucket.longs;
        stats.v1w.shorts += bucket.shorts;
      }
    }
  }

  return stats;
}
// =====================================================

// Borsalarin durumunu takip eden basit bir yapi
const exchangeStatuses = {
  binance: { exchange: 'binance', name: 'Binance', ok: true, latencyMs: 45, lastCheckedAt: new Date().toISOString() },
  bybit: { exchange: 'bybit', name: 'Bybit', ok: true, latencyMs: 60, lastCheckedAt: new Date().toISOString() },
  coinbase: { exchange: 'coinbase', name: 'Coinbase', ok: true, latencyMs: 90, lastCheckedAt: new Date().toISOString() },
  upbit: { exchange: 'upbit', name: 'Upbit', ok: true, latencyMs: 110, lastCheckedAt: new Date().toISOString() }
};

// Baslangicta Ana Backend'den gecmis listelemeleri cekme (Hydration)
async function hydrateFromMainBackend() {
  try {
    console.log('[Seed] Ana backendden gecmis veriler cekiliyor...');
    const response = await fetch(MAIN_BACKEND_HISTORY_URL);
    if (response.ok) {
      const data = await response.json();
      if (data && Array.isArray(data.events) && data.events.length > 0) {
        recentListings = data.events.slice(0, 50);
        console.log(`[Seed] Basarili! ${recentListings.length} adet gecmis listeleme hafizaya alindi.`);
      }
    }
  } catch (err) {
    console.error('[Seed] Gecmis verileri cekerken hata olustu:', err.message);
  }
}

// 1. WEBHOOK (Listeleme Botu veriyi buraya yollar)
app.post('/api/webhooks/fast-listing', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const listingData = req.body;
  console.log(`[YENI LISTELEME ALINDI] Borsadan gelen veri:`, listingData);
  
  // Ilgili borsanin son kontrol edilme zamanini guncelle
  const exchangeId = listingData.exchange || (listingData.events && listingData.events[0] && listingData.events[0].exchange);
  if (exchangeId && exchangeStatuses[exchangeId]) {
    exchangeStatuses[exchangeId].lastCheckedAt = new Date().toISOString();
    exchangeStatuses[exchangeId].ok = true;
  }

  // Gelen veriyi hafizaya ekle
  if (Array.isArray(listingData.events)) {
    recentListings.unshift(...listingData.events);
  } else if (listingData.id) {
    recentListings.unshift(listingData);
  }

  // Mukerrer kayitlari temizle (id'ye gore)
  const seenIds = new Set();
  recentListings = recentListings.filter(item => {
    if (!item || !item.id) return false;
    if (seenIds.has(item.id)) return false;
    seenIds.add(item.id);
    return true;
  });

  if (recentListings.length > 50) {
    recentListings.length = 50;
  }
  
  // Saniyede Frontend'deki kullanicilara yolla
  io.emit('NEW_LISTING_EVENT', listingData);
  
  // Arka planda ana backende ilet
  fetch(MAIN_BACKEND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': WEBHOOK_SECRET
    },
    body: JSON.stringify(listingData)
  }).then(response => {
    console.log(`[Forward] Ana backend e iletildi. Durum: ${response.status}`);
  }).catch(err => {
    console.error(`[Forward] Ana backend e iletme HATA:`, err.message);
  });
  
  res.status(200).json({ success: true, message: 'Broadcasted to Socket and forwarded to Main Backend' });
});

// 2. WEBHOOK (Likidasyon Botu veriyi buraya yollar)
app.post('/api/webhooks/liquidation', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const liqData = req.body;
  const usdValue = Number(liqData.usdValue) || 0;
  const timestamp = Number(liqData.timestamp) || Date.now();

  console.log(`[LIQ VERİSİ ALINDI] ${liqData.symbol} | ${liqData.side} | $${usdValue.toLocaleString()}`);

  // 📊 İstatistiksel hesaplama havuzuna ekle
  addLiquidationToStats(usdValue, timestamp, liqData.side);

  // Güncel metrikleri al
  const rollingStats = getRollingStats();
  
  // Veri paketine ekle (tarayıcı anında güncellesin)
  liqData.rollingStats = rollingStats;

  // Hafızaya ekle
  recentLiquidations.unshift(liqData);

  // En son 100 taneyi tut
  if (recentLiquidations.length > 100) {
    recentLiquidations.length = 100;
  }

  // Socket.io ile canlı akışa fırlat (Tüm bağlı ekranlar için)
  io.emit('NEW_LIQUIDATION_EVENT', liqData);

  res.status(200).json({ success: true, message: 'Broadcasted liquidation event with rolling stats' });
});

// 3. HISTORY LISTINGS API
app.get('/api/exchange-listings', (req, res) => {
  const now = new Date();
  const statusesArray = Object.values(exchangeStatuses).map(status => ({
    ...status,
    lastCheckedAt: new Date(now.getTime() - Math.random() * 5000).toISOString(),
    latencyMs: Math.floor(Math.random() * 40) + 40
  }));

  res.status(200).json({
    latencyMs: 10,
    events: recentListings,
    statuses: statusesArray
  });
});

// 4. HISTORY LIQUIDATIONS API
app.get('/api/liquidations', (req, res) => {
  res.status(200).json({
    success: true,
    events: recentLiquidations
  });
});

app.get('/', (req, res) => {
  res.send('Alerta Liq & Listing Microservice is Running!');
});

io.on('connection', (socket) => {
  console.log('🔗 Yeni bir kullanici baglandi:', socket.id);
  
  // Yeni gelen kullanıcıya geçmiş verileri direkt yolla (opsiyonel)
  socket.emit('INIT_LISTINGS', recentListings);
  socket.emit('INIT_LIQUIDATIONS', {
    history: recentLiquidations,
    rollingStats: getRollingStats()
  });

  socket.on('disconnect', () => {
    console.log('❌ Kullanici ayrildi:', socket.id);
  });
});

server.listen(PORT, async () => {
  console.log(`🚀 Microservice is running on port ${PORT}`);
  await hydrateFromMainBackend();
});
