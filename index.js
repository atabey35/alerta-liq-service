const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Gerekli yonlendirmeler icin fetch modulunu de ekleyebiliriz. Node 18+ uzerinde global fetch var zaten.
const MAIN_BACKEND_URL = 'https://alertachart-backend-production.up.railway.app/api/webhooks/fast-listing';
const WEBHOOK_SECRET = 'SUPER_SECRET_ALERTA_KEY_2026';

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

const recentListings = [];

// 1. WEBHOOK (DO Botu veriyi buraya yollar)
app.post('/api/webhooks/fast-listing', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const listingData = req.body;
  console.log(`[YENI LISTELEME ALINDI] Borsadan gelen veri:`, listingData);
  
  // Gelen veriyi hafizaya ekle
  if (Array.isArray(listingData.events)) {
    recentListings.unshift(...listingData.events);
  } else if (listingData.id) {
    recentListings.unshift(listingData);
  }

  if (recentListings.length > 50) {
    recentListings.length = 50;
  }
  
  // ADIM 1: Saniyede Frontend'deki kullanicilara yolla (Gorsel olarak aninda gorsunler)
  io.emit('NEW_LISTING_EVENT', listingData);
  
  // ADIM 2: Arka planda ana backende ilet (Push notification gitsin ve DB'ye kaydolsun)
  // Beklemiyoruz (await etmiyoruz), arka planda gitsin ki bu responds aninda donsun!
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

// 2. HISTORY API
app.get('/api/exchange-listings', (req, res) => {
  res.status(200).json({
    latencyMs: 10,
    events: recentListings,
    statuses: []
  });
});

app.get('/', (req, res) => {
  res.send('Alerta Listing Microservice is Running!');
});

io.on('connection', (socket) => {
  console.log('🔗 Yeni bir kullanici baglandi (Listing Socket):', socket.id);
  
  socket.on('disconnect', () => {
    console.log('❌ Kullanici ayrildi:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Listing Microservice is running on port ${PORT}`);
});
