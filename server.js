const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static('public'));

const games = new Map();
const players = new Map();

class Game {
  constructor(id, hostId) {
    this.id = id;
    this.players = [];
    this.hostId = hostId;
    this.started = false;
    this.deck = [];
    this.pile = [];
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.mustPlayLower = false;
    this.lastAction = '';
  }

  addPlayer(socketId, name) {
    if (this.players.length >= 4) return false;
    this.players.push({
      id: socketId,
      name: name,
      hand: [],
      faceUp: [],
      faceDown: [],
      isReady: false
    });
    return true;
  }

  removePlayer(socketId) {
    this.players = this.players.filter(p => p.id !== socketId);
    if (this.hostId === socketId && this.players.length > 0) {
      this.hostId = this.players[0].id;
    }
  }

  initializeDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    this.deck = [];
    
    for (let suit of suits) {
      for (let rank of ranks) {
        this.deck.push({ rank, suit, value: this.getCardValue(rank) });
      }
    }
    
    // Shuffle deck
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  getCardValue(rank) {
    const values = { '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15 };
    return values[rank];
  }

  dealCards() {
    // Deal 3 face-down cards to each player
    this.players.forEach(player => {
      player.faceDown = this.deck.splice(0, 3);
      player.faceUp = this.deck.splice(0, 3);
      player.hand = this.deck.splice(0, 3);
    });
  }

  startGame() {
    this.initializeDeck();
    this.dealCards();
    this.started = true;
    this.currentPlayerIndex = 0;
    this.lastAction = 'Game started!';
  }

  getCurrentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  canPlayCard(card) {
    if (this.pile.length === 0) return true;
    
    const topCard = this.pile[this.pile.length - 1];
    
    // Special cards can always be played
    if (card.rank === '2' || card.rank === '10') return true;
    
    // Must play lower than 7
    if (this.mustPlayLower) {
      return card.value < topCard.value;
    }
    
    // Normal rule: play equal or higher
    return card.value >= topCard.value;
  }

  playCard(playerId, cardIndex, source) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { success: false, message: 'Player not found' };

    let card;
    if (source === 'hand') {
      card = player.hand[cardIndex];
      if (!card) return { success: false, message: 'Invalid card' };
      if (!this.canPlayCard(card)) return { success: false, message: 'Cannot play this card' };
      player.hand.splice(cardIndex, 1);
    } else if (source === 'faceUp') {
      if (player.hand.length > 0) return { success: false, message: 'Must play from hand first' };
      card = player.faceUp[cardIndex];
      if (!card) return { success: false, message: 'Invalid card' };
      if (!this.canPlayCard(card)) return { success: false, message: 'Cannot play this card' };
      player.faceUp.splice(cardIndex, 1);
    } else if (source === 'faceDown') {
      if (player.hand.length > 0 || player.faceUp.length > 0) {
        return { success: false, message: 'Must play other cards first' };
      }
      card = player.faceDown[cardIndex];
      if (!card) return { success: false, message: 'Invalid card' };
      player.faceDown.splice(cardIndex, 1);
      
      // Blind play - if it can't be played, pick up pile
      if (!this.canPlayCard(card)) {
        player.hand.push(card, ...this.pile);
        this.pile = [];
        this.lastAction = `${player.name} played ${card.rank}${card.suit} blindly and picked up the pile!`;
        this.nextTurn();
        return { success: true, message: 'Picked up pile', action: 'pickup' };
      }
    }

    this.pile.push(card);
    this.lastAction = `${player.name} played ${card.rank}${card.suit}`;

    // Draw a card if hand is not full and deck has cards
    if (source === 'hand' && player.hand.length < 3 && this.deck.length > 0) {
      player.hand.push(this.deck.pop());
    }

    // Handle special cards
    let burnPile = false;
    let skipNext = false;
    let playAgain = false;

    if (card.rank === '10') {
      this.pile = [];
      this.lastAction += ' - Pile burned!';
      playAgain = true;
      burnPile = true;
    } else if (card.rank === '2') {
      this.mustPlayLower = false;
      this.lastAction += ' - Reset!';
    } else if (card.rank === '7') {
      this.mustPlayLower = true;
      this.lastAction += ' - Next must play lower!';
    } else if (card.rank === '8') {
      this.lastAction += ' - Skip next player!';
      skipNext = true;
    }

    // Check for 4 of a kind (auto-burn)
    if (this.pile.length >= 4) {
      const last4 = this.pile.slice(-4);
      if (last4.every(c => c.rank === last4[0].rank)) {
        this.pile = [];
        this.lastAction += ' - 4 of a kind! Pile burned!';
        playAgain = true;
        burnPile = true;
      }
    }

    // Check if player won
    if (player.hand.length === 0 && player.faceUp.length === 0 && player.faceDown.length === 0) {
      return { success: true, message: 'Winner!', action: 'win' };
    }

    if (!playAgain) {
      if (skipNext) {
        this.currentPlayerIndex = (this.currentPlayerIndex + 2) % this.players.length;
      } else {
        this.nextTurn();
      }
    }

    return { success: true, message: 'Card played', action: burnPile ? 'burn' : 'normal' };
  }

  pickupPile(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return false;

    player.hand.push(...this.pile);
    this.lastAction = `${player.name} picked up the pile (${this.pile.length} cards)`;
    this.pile = [];
    this.mustPlayLower = false;
    this.nextTurn();
    return true;
  }

  nextTurn() {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    this.mustPlayLower = false;
  }

  getGameState(forPlayerId) {
    return {
      id: this.id,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        hand: p.id === forPlayerId ? p.hand : [],
        faceUp: p.faceUp, // Everyone can see face-up cards
        faceDownCount: p.faceDown.length,
        isReady: p.isReady
      })),
      pile: this.pile,
      topCard: this.pile.length > 0 ? this.pile[this.pile.length - 1] : null,
      currentPlayerIndex: this.currentPlayerIndex,
      currentPlayerId: this.players[this.currentPlayerIndex]?.id,
      deckCount: this.deck.length,
      started: this.started,
      hostId: this.hostId,
      mustPlayLower: this.mustPlayLower,
      lastAction: this.lastAction
    };
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('createGame', (playerName) => {
    const gameId = Math.random().toString(36).substr(2, 6).toUpperCase();
    const game = new Game(gameId, socket.id);
    game.addPlayer(socket.id, playerName);
    games.set(gameId, game);
    players.set(socket.id, { gameId, name: playerName });
    
    socket.join(gameId);
    socket.emit('gameCreated', { gameId, gameState: game.getGameState(socket.id) });
  });

  socket.on('joinGame', ({ gameId, playerName }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit('error', 'Game not found');
      return;
    }
    if (game.started) {
      socket.emit('error', 'Game already started');
      return;
    }
    if (!game.addPlayer(socket.id, playerName)) {
      socket.emit('error', 'Game is full');
      return;
    }

    players.set(socket.id, { gameId, name: playerName });
    socket.join(gameId);
    
    io.to(gameId).emit('gameUpdate', game.getGameState(socket.id));
    io.to(gameId).emit('playerJoined', { name: playerName });
  });

  socket.on('startGame', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const game = games.get(playerData.gameId);
    if (!game || game.hostId !== socket.id) return;
    if (game.players.length < 2) {
      socket.emit('error', 'Need at least 2 players');
      return;
    }

    game.startGame();
    
    game.players.forEach(player => {
      io.to(player.id).emit('gameUpdate', game.getGameState(player.id));
    });
  });

  socket.on('playCard', ({ cardIndex, source }) => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const game = games.get(playerData.gameId);
    if (!game || !game.started) return;
    if (game.getCurrentPlayer().id !== socket.id) {
      socket.emit('error', 'Not your turn');
      return;
    }

    const result = game.playCard(socket.id, cardIndex, source);
    
    if (!result.success) {
      socket.emit('error', result.message);
      return;
    }

    if (result.action === 'win') {
      io.to(playerData.gameId).emit('gameOver', { 
        winner: playerData.name,
        winnerId: socket.id 
      });
    }

    game.players.forEach(player => {
      io.to(player.id).emit('gameUpdate', game.getGameState(player.id));
    });
  });

  socket.on('pickupPile', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const game = games.get(playerData.gameId);
    if (!game || !game.started) return;
    if (game.getCurrentPlayer().id !== socket.id) return;

    game.pickupPile(socket.id);
    
    game.players.forEach(player => {
      io.to(player.id).emit('gameUpdate', game.getGameState(player.id));
    });
  });

  socket.on('chatMessage', (message) => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    io.to(playerData.gameId).emit('chatMessage', {
      player: playerData.name,
      message: message
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const playerData = players.get(socket.id);
    if (playerData) {
      const game = games.get(playerData.gameId);
      if (game) {
        game.removePlayer(socket.id);
        if (game.players.length === 0) {
          games.delete(playerData.gameId);
        } else {
          io.to(playerData.gameId).emit('playerLeft', { name: playerData.name });
          game.players.forEach(player => {
            io.to(player.id).emit('gameUpdate', game.getGameState(player.id));
          });
        }
      }
      players.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});