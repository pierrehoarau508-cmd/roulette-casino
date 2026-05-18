require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/state', (req, res) => res.json(state));

// ── État global ─────────────────────────────────────────────────────
const TEAMS = ['🔴 Rouge', '🔵 Bleu', '🟢 Vert', '🟡 Or'];
const COLORS = { '🔴 Rouge': '#e74c3c', '🔵 Bleu': '#3498db', '🟢 Vert': '#2ecc71', '🟡 Or': '#f1c40f' };
const ROULETTE_NUMBERS = [
  0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,
  24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26
];
const RED_NUMBERS   = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const BLACK_NUMBERS = new Set([2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]);

const state = {
  spinning   : false,
  lastResult : null,
  spinCount  : 0,
  currentAngle: 0,
  teams: {
    '🔴 Rouge': { jetons: 1000, score: 0, membres: [] },
    '🔵 Bleu' : { jetons: 1000, score: 0, membres: [] },
    '🟢 Vert' : { jetons: 1000, score: 0, membres: [] },
    '🟡 Or'   : { jetons: 1000, score: 0, membres: [] },
  },
  bets   : {},   // { socketId: { team, type, value, amount } }
  chat   : [],   // historique chat
  history: [],   // derniers résultats
};

// ── Commentaires IA ─────────────────────────────────────────────────
const comments = {
  win : [
    n => `🔥 ${n} ! Les dieux du casino sourient aux audacieux !`,
    n => `💰 ${n} sort ! Quelle chance insolente !`,
    n => `🎰 ${n} ! La bille a choisi, et c'est magnifique !`,
    n => `⚡ ${n} ! Le destin frappe fort ce soir !`,
    n => `🌟 ${n} ! Personne ne l'avait vu venir !`,
  ],
  zero: [
    () => `😱 ZÉRO ! La maison ramasse tout ! Catastrophe générale !`,
    () => `💀 0 ! Le casino ricane dans l'ombre...`,
    () => `🏦 Zéro ! La banque dit merci, vous pouvez rentrer chez vous.`,
  ],
  red : [n => `🔴 ${n} Rouge — la passion du risque !`],
  black:[n => `⚫ ${n} Noir — l'élégance de la nuit !`],
};

function getComment(n) {
  if (n === 0) return comments.zero[Math.floor(Math.random()*comments.zero.length)]();
  const pool = [...comments.win, RED_NUMBERS.has(n) ? comments.red[0] : comments.black[0]];
  return pool[Math.floor(Math.random()*pool.length)](n);
}

// ── Calcul des gains ────────────────────────────────────────────────
function calcGain(bet, result) {
  const { type, value, amount } = bet;
  if (type === 'number' && parseInt(value) === result) return amount * 35;
  if (type === 'color'  && value === 'rouge' && RED_NUMBERS.has(result))   return amount;
  if (type === 'color'  && value === 'noir'  && BLACK_NUMBERS.has(result)) return amount;
  if (type === 'parity' && value === 'pair'  && result % 2 === 0 && result !== 0) return amount;
  if (type === 'parity' && value === 'impair'&& result % 2 === 1) return amount;
  if (type === 'dozen'  && value === '1-12'  && result >= 1  && result <= 12) return amount * 2;
  if (type === 'dozen'  && value === '13-24' && result >= 13 && result <= 24) return amount * 2;
  if (type === 'dozen'  && value === '25-36' && result >= 25 && result <= 36) return amount * 2;
  return -amount; // perte
}

// ── Socket.io ───────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.emit('state-update', state);
  socket.emit('chat-history', state.chat.slice(-30));

  // Rejoindre une équipe
  socket.on('join-team', ({ team, name }) => {
    if (!state.teams[team]) return;
    // Retirer de l'ancienne équipe si besoin
    TEAMS.forEach(t => {
      state.teams[t].membres = state.teams[t].membres.filter(m => m.id !== socket.id);
    });
    state.teams[team].membres.push({ id: socket.id, name: name || 'Anonyme' });
    socket.team = team;
    socket.playerName = name || 'Anonyme';
    io.emit('state-update', state);
    addChat('🤖 Croupier', `${socket.playerName} a rejoint l'équipe ${team} !`, 'ia');
  });

  // Miser
  socket.on('place-bet', ({ type, value, amount }) => {
    if (state.spinning) return socket.emit('error', 'La roulette tourne !');
    if (!socket.team)   return socket.emit('error', 'Rejoins une équipe d\'abord !');
    const team = state.teams[socket.team];
    if (team.jetons < amount) return socket.emit('error', 'Pas assez de jetons !');
    team.jetons -= amount;
    state.bets[socket.id] = { team: socket.team, type, value, amount, name: socket.playerName };
    io.emit('state-update', state);
    socket.emit('bet-placed', { type, value, amount });
  });

  // Lancer la roulette
  socket.on('request-spin', () => {
    if (state.spinning) return;
    if (Object.keys(state.bets).length === 0) return socket.emit('error', 'Personne n\'a misé !');
    state.spinning = true;
    state.spinCount++;

    const resultIndex = Math.floor(Math.random() * ROULETTE_NUMBERS.length);
    const result      = ROULETTE_NUMBERS[resultIndex];

    // Angle : chaque case = 360/37 degrés
    const segAngle  = 360 / 37;
    const targetAngle = resultIndex * segAngle;
    const extra     = (8 + Math.floor(Math.random() * 5)) * 360;
    state.currentAngle += extra + (360 - (state.currentAngle % 360) - targetAngle + 360) % 360;

    io.emit('spin-start', { finalAngle: state.currentAngle, result });

    setTimeout(() => {
      state.spinning   = false;
      state.lastResult = result;

      // Calcul des gains/pertes
      const recap = {};
      TEAMS.forEach(t => recap[t] = { gain: 0, perte: 0 });

      Object.entries(state.bets).forEach(([sid, bet]) => {
        const gain = calcGain(bet, result);
        if (gain > 0) {
          state.teams[bet.team].jetons += bet.amount + gain;
          state.teams[bet.team].score  += gain;
          recap[bet.team].gain += gain;
        } else {
          recap[bet.team].perte += Math.abs(gain);
        }
      });

      state.bets = {};
      state.history.unshift({ number: result, timestamp: Date.now() });
      if (state.history.length > 20) state.history.pop();

      const comment = getComment(result);
      addChat('🤖 Croupier IA', comment, 'ia');

      io.emit('spin-result', { result, recap, comment });
      io.emit('state-update', state);
    }, 7000);
  });

  // Chat
  socket.on('chat-message', ({ message }) => {
    if (!message || message.length > 200) return;
    const name = socket.playerName || 'Anonyme';
    const team = socket.team || '';
    addChat(name, message, 'player', team);
  });

  socket.on('disconnect', () => {
    TEAMS.forEach(t => {
      state.teams[t].membres = state.teams[t].membres.filter(m => m.id !== socket.id);
    });
    delete state.bets[socket.id];
    io.emit('state-update', state);
  });
});

function addChat(name, message, type, team = '') {
  const entry = { name, message, type, team, time: new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }) };
  state.chat.push(entry);
  if (state.chat.length > 100) state.chat.shift();
  io.emit('chat-message', entry);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`✅ Casino en ligne sur le port ${PORT}`));

// ── Bot Discord (optionnel) ─────────────────────────────────────────
if (process.env.DISCORD_TOKEN) {
  const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
  const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

  const CMDS = [
    new SlashCommandBuilder().setName('spin').setDescription('🎰 Lance la roulette !'),
    new SlashCommandBuilder().setName('scores').setDescription('🏆 Tableau des scores'),
    new SlashCommandBuilder().setName('jetons').setDescription('💰 Jetons de chaque équipe'),
    new SlashCommandBuilder().setName('casino').setDescription('🔗 Lien vers le casino'),
  ].map(c => c.toJSON());

  bot.once('ready', async () => {
    console.log(`✅ Bot Discord : ${bot.user.tag}`);
    try {
      const rest = new REST({ version:'10' }).setToken(process.env.DISCORD_TOKEN);
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: CMDS });
    } catch(e) { console.error(e.message); }
  });

  bot.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    if (cmd === 'spin') {
      if (state.spinning) return interaction.reply({ content: '⏳ La roulette tourne !', ephemeral: true });
      // Lance depuis Discord (sans mise)
      state.spinning = true;
      state.spinCount++;
      const resultIndex = Math.floor(Math.random() * ROULETTE_NUMBERS.length);
      const result      = ROULETTE_NUMBERS[resultIndex];
      const segAngle    = 360 / 37;
      const targetAngle = resultIndex * segAngle;
      const extra       = (8 + Math.floor(Math.random() * 5)) * 360;
      state.currentAngle += extra + (360 - (state.currentAngle % 360) - targetAngle + 360) % 360;
      io.emit('spin-start', { finalAngle: state.currentAngle, result });
      const color = result === 0 ? 0x00AA00 : RED_NUMBERS.has(result) ? 0xFF0000 : 0x111111;
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle('🎰 La roulette tourne !').setDescription(`Lancée par **${interaction.user.username}** !\n\n[🔴 Voir en direct](${process.env.PUBLIC_URL||'#'})`).setColor(0xFFD700)] });
      setTimeout(async () => {
        state.spinning = false;
        state.lastResult = result;
        state.bets = {};
        state.history.unshift({ number: result, timestamp: Date.now() });
        if (state.history.length > 20) state.history.pop();
        const comment = getComment(result);
        addChat('🤖 Croupier IA', comment, 'ia');
        io.emit('spin-result', { result, recap: {}, comment });
        io.emit('state-update', state);
        const channelId = interaction.channelId;
        try {
          const channel = bot.channels.cache.get(channelId);
          if (channel) await channel.send({ embeds: [new EmbedBuilder().setTitle(`🎰 Résultat : ${result === 0 ? '🟢 0' : RED_NUMBERS.has(result) ? `🔴 ${result}` : `⚫ ${result}`}`).setDescription(comment).setColor(result===0?0x00AA00:RED_NUMBERS.has(result)?0xFF0000:0x222222).setTimestamp()] });
        } catch(e) {}
      }, 7000);
    }

    if (cmd === 'scores') {
      const lines = TEAMS.map(t => `${t} : **${state.teams[t].score}** pts — **${state.teams[t].jetons}** jetons`).join('\n');
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle('🏆 Tableau des scores').setDescription(lines).setColor(0xFFD700)] });
    }

    if (cmd === 'jetons') {
      const lines = TEAMS.map(t => `${t} : **${state.teams[t].jetons}** jetons`).join('\n');
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle('💰 Jetons').setDescription(lines).setColor(0x2ecc71)] });
    }

    if (cmd === 'casino') {
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle('🎰 Casino en direct').setDescription(`[🔴 Ouvrir le casino](${process.env.PUBLIC_URL||'#'})`).setColor(0xFFD700)] });
    }
  });

  bot.login(process.env.DISCORD_TOKEN).catch(e => console.error('Discord:', e.message));
}
