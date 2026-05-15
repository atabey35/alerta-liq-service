const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Vercel'den gelen isteklere izin ver
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
// DigitalOcean sunucumuzun statik IP'si
const DO_IP = '168.144.109.202'; 
const DO_API_URL = `http://${DO_IP}:3001/api/liquidations`;

// 1. WEBHOOK (DigitalOcean botu yakaladigi veriyi buraya yollar)
app.post('/webhook/liquidations', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  
  if (secret !== 'SUPER_SECRET_ALERTA_KEY_2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const liqData = req.body;
  
  // Gelen veriyi Frontend'deki bagli butun kullanicilara saniyesinde firlat (Canli Animasyonlar)
  io.emit('new_liquidation', liqData);
  
  res.status(200).json({ success: true, message: 'Broadcasted to clients' });
});

// 2. PROXY (Vercel Gecmis Veri Istediginde HTTPS Sorununu Cozmek Icin)
app.get('/api/history', async (req, res) => {
  try {
    const { limit = 100, hours = 24 } = req.query;
    
    // Asil sorguyu DigitalOcean'daki SQLite API'sine atiyoruz
    const response = await fetch(`${DO_API_URL}?limit=${limit}&hours=${hours}`);
    const data = await response.json();
    
    res.status(200).json(data);
  } catch (error) {
    console.error('DO API Error:', error.message);
    res.status(500).json({ error: 'DigitalOcean sunucusuna ulasilamadi.' });
  }
});

io.on('connection', (socket) => {
  console.log('🔗 Yeni bir kullanici baglandi (Liq Socket):', socket.id);
  
  socket.on('disconnect', () => {
    console.log('❌ Kullanici ayrildi:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Liq Microservice is running on port ${PORT}`);
});
