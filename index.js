const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Socket.io ayarları (Frontend buradan dinleyecek)
const io = new Server(server, {
  cors: {
    origin: '*', // Vercel'den gelen isteklere izin ver
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// 1. WEBHOOK (DigitalOcean Borsa Listing Botu veriyi buraya yollar)
app.post('/api/webhooks/fast-listing', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  
  if (secret !== 'SUPER_SECRET_ALERTA_KEY_2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const listingData = req.body;
  console.log(`[YENI LISTELEME ALINDI] Borsadan gelen veri:`, listingData);
  
  // Gelen Borsa Listeleme verisini Frontend'deki butun kullanicilara saniyesinde firlat
  io.emit('NEW_LISTING_EVENT', listingData);
  
  res.status(200).json({ success: true, message: 'Broadcasted listing to clients' });
});

// Sadece servisin calisip calismadigini test etmek icin basit bir GET
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
