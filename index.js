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
  console.log(`[LIQ VERİSİ ALINDI] ${liqData.symbol} | ${liqData.side} | $${(liqData.usdValue || 0).toLocaleString()}`);

  // Hafızaya ekle
  recentLiquidations.unshift(liqData);

  // En son 100 taneyi tut
  if (recentLiquidations.length > 100) {
    recentLiquidations.length = 100;
  }

  // Socket.io ile canlı akışa fırlat (Tüm bağlı ekranlar için)
  io.emit('NEW_LIQUIDATION_EVENT', liqData);

  res.status(200).json({ success: true, message: 'Broadcasted liquidation event' });
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
  socket.emit('INIT_LIQUIDATIONS', recentLiquidations);

  socket.on('disconnect', () => {
    console.log('❌ Kullanici ayrildi:', socket.id);
  });
});

server.listen(PORT, async () => {
  console.log(`🚀 Microservice is running on port ${PORT}`);
  await hydrateFromMainBackend();
});
