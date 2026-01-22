// server/signaling-server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// Endpoint santé
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Endpoint pour créer une salle
app.post('/create-room', (req, res) => {
  const { userId, type = 'video' } = req.body;
  const roomId = `assma-${uuidv4().split('-')[0]}`;
  
  rooms.set(roomId, {
    id: roomId,
    type,
    creator: userId,
    participants: new Set(),
    createdAt: new Date(),
    isActive: true
  });
  
  console.log(`🏠 Salle créée: ${roomId} par ${userId}`);
  res.json({ roomId, type, createdAt: new Date().toISOString() });
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // En prod, remplace par ton domaine
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Stockage en mémoire (en prod, utilise Redis)
const rooms = new Map();
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('🔌 Nouvelle connexion:', socket.id);

  // Joindre une salle
  socket.on('join-room', async (data) => {
    const { roomId, userId, userName, userAvatar } = data;
    
    if (!rooms.has(roomId)) {
      socket.emit('room-error', { message: 'Salle introuvable' });
      return;
    }

    const room = rooms.get(roomId);
    
    // Vérifier si la salle est pleine (max 4 participants pour P2P)
    if (room.participants.size >= 4) {
      socket.emit('room-error', { message: 'Salle pleine' });
      return;
    }

    // Rejoindre la salle Socket.io
    await socket.join(roomId);
    
    // Stocker les infos utilisateur
    socket.userId = userId;
    socket.userName = userName;
    socket.userAvatar = userAvatar;
    socket.roomId = roomId;
    
    userSockets.set(userId, socket.id);
    room.participants.add(userId);

    // Notifier l'utilisateur qu'il a rejoint
    const participants = Array.from(room.participants).map(pid => ({
      id: pid,
      name: pid === userId ? userName : 'Participant',
      avatar: pid === userId ? userAvatar : '👤',
      isOnline: true
    }));

    socket.emit('room-joined', {
      roomId,
      type: room.type,
      participants,
      isCreator: room.creator === userId
    });

    // Notifier les autres participants
    socket.to(roomId).emit('user-joined', {
      userId,
      userName,
      userAvatar,
      participantsCount: room.participants.size
    });

    console.log(`👤 ${userName} (${userId}) a rejoint ${roomId}`);
    console.log(`👥 ${roomId}: ${room.participants.size} participants`);
  });

  // Envoyer une offre SDP
  socket.on('offer', (data) => {
    const { targetUserId, sdp, type } = data;
    const targetSocketId = userSockets.get(targetUserId);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('offer', {
        senderId: socket.userId,
        senderName: socket.userName,
        sdp,
        type,
        timestamp: new Date().toISOString()
      });
      console.log(`📨 Offre ${type} de ${socket.userId} à ${targetUserId}`);
    }
  });

  // Envoyer une réponse SDP
  socket.on('answer', (data) => {
    const { targetUserId, sdp } = data;
    const targetSocketId = userSockets.get(targetUserId);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('answer', {
        senderId: socket.userId,
        sdp,
        timestamp: new Date().toISOString()
      });
      console.log(`📨 Réponse de ${socket.userId} à ${targetUserId}`);
    }
  });

  // Envoyer un candidat ICE
  socket.on('ice-candidate', (data) => {
    const { targetUserId, candidate } = data;
    const targetSocketId = userSockets.get(targetUserId);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', {
        senderId: socket.userId,
        candidate,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Changer le statut (mute, vidéo, etc.)
  socket.on('user-status', (data) => {
    const { isMuted, isVideoOn } = data;
    socket.to(socket.roomId).emit('user-status-changed', {
      userId: socket.userId,
      isMuted,
      isVideoOn,
      timestamp: new Date().toISOString()
    });
  });

  // Quitter la salle
  socket.on('leave-room', () => {
    if (!socket.roomId) return;

    const room = rooms.get(socket.roomId);
    if (room) {
      room.participants.delete(socket.userId);
      userSockets.delete(socket.userId);

      // Notifier les autres
      socket.to(socket.roomId).emit('user-left', {
        userId: socket.userId,
        userName: socket.userName,
        participantsCount: room.participants.size
      });

      // Supprimer la salle si vide
      if (room.participants.size === 0) {
        rooms.delete(socket.roomId);
        console.log(`🗑️ Salle ${socket.roomId} supprimée (vide)`);
      }

      console.log(`👋 ${socket.userName} a quitté ${socket.roomId}`);
    }

    socket.leave(socket.roomId);
    delete socket.roomId;
  });

  // Ping/pong pour vérifier la connexion
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: new Date().toISOString() });
  });

  // Déconnexion
  socket.on('disconnect', () => {
    console.log('🔌 Déconnexion:', socket.id);
    
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.participants.delete(socket.userId);
        userSockets.delete(socket.userId);

        // Notifier les autres
        io.to(socket.roomId).emit('user-disconnected', {
          userId: socket.userId,
          userName: socket.userName,
          reason: 'disconnected'
        });

        // Supprimer la salle si vide
        if (room.participants.size === 0) {
          rooms.delete(socket.roomId);
          console.log(`🗑️ Salle ${socket.roomId} supprimée (déconnexion)`);
        }
      }
    }
  });
});

// Nettoyage des salles inactives (toutes les heures)
setInterval(() => {
  const now = new Date();
  let deleted = 0;
  
  for (const [roomId, room] of rooms.entries()) {
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    if (room.createdAt < hourAgo && room.participants.size === 0) {
      rooms.delete(roomId);
      deleted++;
    }
  }
  
  if (deleted > 0) {
    console.log(`🧹 ${deleted} salles inactives nettoyées`);
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Serveur de signalisation sur le port ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🌐 HTTP: http://localhost:${PORT}`);
});