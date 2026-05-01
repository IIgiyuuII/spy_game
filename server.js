const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Spy Game Server is running',
    endpoints: {
      websocket: 'wss://spy-game-backend-11qd.onrender.com',
      version: '1.0.0'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', rooms: rooms.size });
});

const wss = new WebSocket.Server({ 
  server,
  handleProtocols: (protocols, request) => {
    return protocols[0] || '';
  }
});

const rooms = new Map();

const imagePool = [
  'https://raw.githubusercontent.com/IIgiyuuII/spy_game/main/public/images/5e78080e3427ec11e4a2c5f132fbf1f9.gif',
  'https://raw.githubusercontent.com/IIgiyuuII/spy_game/main/public/images/PhotoLab2_1.jpg',
  'https://raw.githubusercontent.com/IIgiyuuII/spy_game/main/public/images/Screenshot_117.jpg',
  'https://raw.githubusercontent.com/IIgiyuuII/spy_game/main/public/images/Screenshot_31.jpg',
  'https://raw.githubusercontent.com/IIgiyuuII/spy_game/main/public/images/Screenshot_73.jpg',
  'https://raw.githubusercontent.com/IIgiyuuII/spy_game/main/public/images/uQkhhR1hSi2FH-IwCqhTXFuNhnisOp41hI8tPwaCHNdDq6N2MyMfwRa8igRj7w7HwdwB1o5dhL8Rjs3ph4PTqhQv.jpg',
];

class Room {
  constructor(code, adminId) {
    this.code = code;
    this.adminId = adminId;
    this.players = new Map();
    this.gameStarted = false;
    this.currentRoundImage = null;
  }

  addPlayer(playerId, ws, username) {
    this.players.set(playerId, { ws, username, isSpy: false });
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    
    // Если админ вышел и есть другие игроки - передаем лидерство
    if (this.adminId === playerId && this.players.size > 0) {
      this.transferAdmin();
    }
  }

  // Новая функция передачи прав админа
  transferAdmin() {
    if (this.players.size === 0) return;
    
    // Выбираем случайного игрока новым админом
    const playersArray = Array.from(this.players.keys());
    const randomIndex = Math.floor(Math.random() * playersArray.length);
    const newAdminId = playersArray[randomIndex];
    this.adminId = newAdminId;
    
    // Уведомляем всех о новом админе
    this.broadcastToAll({
      type: 'admin_changed',
      newAdminId: newAdminId,
      players: this.getPlayersList()
    });
    
    // Отдельно уведомляем нового админа
    const newAdmin = this.players.get(newAdminId);
    if (newAdmin && newAdmin.ws) {
      newAdmin.ws.send(JSON.stringify({
        type: 'you_are_admin_now',
        message: 'Вы стали администратором комнаты!'
      }));
    }
  }

  broadcastToAll(message) {
    const msgString = JSON.stringify(message);
    this.players.forEach(player => {
      if (player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(msgString);
      }
    });
  }

  getPlayersList() {
    return Array.from(this.players.entries()).map(([id, data]) => ({
      id,
      username: data.username,
      isAdmin: id === this.adminId
    }));
  }

  startNewRound() {
    if (this.players.size < 3) return false;
    
    const imageIndex = Math.floor(Math.random() * imagePool.length);
    this.currentRoundImage = imagePool[imageIndex];
    
    const playersArray = Array.from(this.players.keys());
    const spyIndex = Math.floor(Math.random() * playersArray.length);
    const spyId = playersArray[spyIndex];
    
    this.players.forEach((player, id) => {
      player.isSpy = (id === spyId);
    });
    
    this.gameStarted = true;
    return {
      image: this.currentRoundImage,
      spyId: spyId
    };
  }
}

wss.on('connection', (ws) => {
  let currentPlayerId = uuidv4();
  let currentRoom = null;
  let currentUsername = '';

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    switch(data.type) {
      case 'create_room':
        const roomCode = generateRoomCode();
        currentUsername = data.username;
        const newRoom = new Room(roomCode, currentPlayerId);
        newRoom.addPlayer(currentPlayerId, ws, currentUsername);
        rooms.set(roomCode, newRoom);
        currentRoom = newRoom;
        
        ws.send(JSON.stringify({
          type: 'room_created',
          roomCode: roomCode,
          players: newRoom.getPlayersList(),
          isAdmin: true
        }));
        break;
        
      case 'join_room':
        const room = rooms.get(data.roomCode);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
          return;
        }
        
        currentUsername = data.username;
        room.addPlayer(currentPlayerId, ws, currentUsername);
        currentRoom = room;
        
        broadcastToRoom(room, {
          type: 'players_update',
          players: room.getPlayersList()
        });
        
        ws.send(JSON.stringify({
          type: 'room_joined',
          roomCode: room.code,
          players: room.getPlayersList(),
          isAdmin: room.adminId === currentPlayerId
        }));
        break;
        
      case 'start_game':
        if (!currentRoom || currentRoom.adminId !== currentPlayerId) return;
        
        const roundData = currentRoom.startNewRound();
        if (!roundData) {
          ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно игроков' }));
          return;
        }
        
        currentRoom.players.forEach((player, playerId) => {
          const isSpy = playerId === roundData.spyId;
          player.ws.send(JSON.stringify({
            type: 'game_started',
            image: isSpy ? null : roundData.image,
            isSpy: isSpy,
            isAdmin: playerId === currentRoom.adminId
          }));
        });
        break;
        
      case 'new_round':
        if (!currentRoom || currentRoom.adminId !== currentPlayerId) return;
        
        const newRoundData = currentRoom.startNewRound();
        if (!newRoundData) return;
        
        currentRoom.players.forEach((player, playerId) => {
          const isSpy = playerId === newRoundData.spyId;
          player.ws.send(JSON.stringify({
            type: 'new_round',
            image: isSpy ? null : newRoundData.image,
            isSpy: isSpy
          }));
        });
        break;
    }
  });
  
  ws.on('close', () => {
    if (currentRoom) {
      currentRoom.removePlayer(currentPlayerId);
      
      if (currentRoom.players.size === 0) {
        rooms.delete(currentRoom.code);
      } else {
        broadcastToRoom(currentRoom, {
          type: 'players_update',
          players: currentRoom.getPlayersList()
        });
      }
    }
  });
});

function broadcastToRoom(room, message) {
  const msgString = JSON.stringify(message);
  room.players.forEach(player => {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(msgString);
    }
  });
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});