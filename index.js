const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Bellekte son 50 listelemeyi tutalim (Frontend acilisinda gostermek icin)
const recentListings = [];

// 1. WEBHOOK (DO Botu veriyi buraya yollar)
app.post('/api/webhooks/fast-listing', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  
  if (secret !== 'SUPER_SECRET_ALERTA_KEY_2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const listingData = req.body;
  console.log(`[YENI LISTELEME ALINDI] Borsadan gelen veri:`, listingData);
  
  // Gelen veriyi (Eger array ise icindekileri, degilse kendisini) listeye ekle
  if (Array.isArray(listingData.events)) {
    recentListings.unshift(...listingData.events);
  } else if (listingData.id) {
    recentListings.unshift(listingData);
  }

  // Listeyi max 50 elemanda tut
  if (recentListings.length > 50) {
    recentListings.length = 50;
  }
  
  // Gelen veriyi Frontend'deki bagli butun kullanicilara saniyesinde firlat
  io.emit('NEW_LISTING_EVENT', listingData);
  
  res.status(200).json({ success: true, message: 'Broadcasted listing to clients' });
});

// 2. HISTORY API (Frontend ilk acildiginda son listelemeleri cekmesi icin)
app.get('/api/exchange-listings', (req, res) => {
  res.status(200).json({
    latencyMs: 10,
    events: recentListings,
    statuses: [] // Istenirse bot statuleri de buraya eklenebilir
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
