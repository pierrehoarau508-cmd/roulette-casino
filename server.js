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

// ── Constantes ──────────────────────────────────────────────────────
const TEAMS   = ['🔴 Rouge','🔵 Bleu','🟢 Vert','🟡 Or'];
const NUMBERS = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED_N   = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

// ── État global ─────────────────────────────────────────────────────
const state = {
  spinning    : false,
  lastResult  : null,
  spinCount   : 0,
  currentAngle: 0,
  teams: {
    '🔴 Rouge': { jetons:1000, score:0, membres:[] },
    '🔵 Bleu' : { jetons:1000, score:0, membres:[] },
    '🟢 Vert' : { jetons:1000, score:0, membres:[] },
    '🟡 Or'   : { jetons:1000, score:0, membres:[] },
  },
  bets   : {},  // { discordId/socketId: { team, type, value, amount, name } }
  chat   : [],
  history: [],
};

// ── Calcul gains ────────────────────────────────────────────────────
function calcGain(bet, result) {
  const { type, value, amount } = bet;
  if (type==='number' && parseInt(value)===result)                            return amount*35;
  if (type==='color'  && value==='rouge' && RED_N.has(result))                return amount;
  if (type==='color'  && value==='noir'  && !RED_N.has(result) && result!==0) return amount;
  if (type==='parity' && value==='pair'  && result%2===0 && result!==0)       return amount;
  if (type==='parity' && value==='impair'&& result%2===1)                     return amount;
  if (type==='dozen'  && value==='1-12'  && result>=1  && result<=12)         return amount*2;
  if (type==='dozen'  && value==='13-24' && result>=13 && result<=24)         return amount*2;
  if (type==='dozen'  && value==='25-36' && result>=25 && result<=36)         return amount*2;
  return -amount;
}

// ── Commentateur IA ─────────────────────────────────────────────────
const COMMENTS = [
  n=>`🔥 ${n} ! Les dieux du casino sourient aux audacieux !`,
  n=>`💰 ${n} sort ! Quelle chance insolente ce soir !`,
  n=>`🎰 ${n} ! La bille a choisi, et c'est magnifique !`,
  n=>`⚡ ${n} ! Le destin frappe fort — personne ne l'avait vu venir !`,
  n=>`🌟 ${n} ! Le tapis vert ne ment jamais…`,
];
const ZERO_COMMENTS = [
  ()=>`😱 ZÉRO ! La maison ramasse tout ! Catastrophe générale !`,
  ()=>`💀 0 ! Le casino ricane dans l'ombre… Bonne chance la prochaine fois.`,
  ()=>`🏦 Zéro ! La banque dit merci, vous pouvez rentrer chez vous.`,
];
function getComment(n) {
  if (n===0) return ZERO_COMMENTS[Math.floor(Math.random()*ZERO_COMMENTS.length)]();
  return COMMENTS[Math.floor(Math.random()*COMMENTS.length)](n);
}

// ── Spin ────────────────────────────────────────────────────────────
function doSpin(onResult) {
  state.spinning   = true;
  state.spinCount++;
  const idx    = Math.floor(Math.random()*NUMBERS.length);
  const result = NUMBERS[idx];
  const seg    = 360 / 37;
  // NEEDLE_ANGLE = position de l'aiguille en degrés (180 = gauche)
  const NEEDLE_ANGLE = 180;
  // Centre du segment gagnant
  const segCenter = idx * seg + seg / 2;
  // On veut : (currentAngle + segCenter) % 360 == NEEDLE_ANGLE
  const curMod = ((state.currentAngle % 360) + 360) % 360;
  let   delta  = ((NEEDLE_ANGLE - curMod - segCenter) % 360 + 360) % 360;
  if (delta < 0.5) delta += 360; // évite d'arriver pile au départ
  const extra = (8 + Math.floor(Math.random() * 5)) * 360;
  state.currentAngle += extra + delta;

  io.emit('spin-start', { finalAngle: state.currentAngle, result });

  setTimeout(() => {
    state.spinning   = false;
    state.lastResult = result;

    // Gains/pertes par équipe
    const recap = {};
    TEAMS.forEach(t => recap[t] = { gain:0, perte:0 });
    Object.entries(state.bets).forEach(([id, bet]) => {
      const g = calcGain(bet, result);
      if (g > 0) {
        state.teams[bet.team].jetons += bet.amount + g;
        state.teams[bet.team].score  += g;
        recap[bet.team].gain += g;
      } else {
        recap[bet.team].perte += Math.abs(g);
      }
    });
    state.bets = {};
    state.history.unshift({ number: result, timestamp: Date.now() });
    if (state.history.length > 20) state.history.pop();

    const comment = getComment(result);
    addChat('🤖 Croupier IA', comment, 'ia');
    io.emit('spin-result', { result, recap, comment });
    io.emit('state-update', state);

    onResult(result, recap, comment);
  }, 7000);
}

// ── Chat ─────────────────────────────────────────────────────────────
function addChat(name, message, type, team='') {
  const entry = { name, message, type, team, time: new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}) };
  state.chat.push(entry);
  if (state.chat.length>100) state.chat.shift();
  io.emit('chat-message', entry);
}

// ── Socket.io ────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.emit('state-update', state);
  socket.emit('chat-history', state.chat.slice(-30));

  socket.on('join-team', ({ team, name }) => {
    if (!state.teams[team]) return;
    TEAMS.forEach(t => { state.teams[t].membres = state.teams[t].membres.filter(m=>m.id!==socket.id); });
    state.teams[team].membres.push({ id:socket.id, name:name||'Anonyme' });
    socket.team = team; socket.playerName = name||'Anonyme';
    io.emit('state-update', state);
    addChat('🤖 Croupier', `${socket.playerName} a rejoint ${team} !`, 'ia');
  });

  socket.on('place-bet', ({ type, value, amount }) => {
    if (state.spinning) return socket.emit('error','La roulette tourne !');
    if (!socket.team)   return socket.emit('error','Rejoins une équipe d\'abord !');
    if (state.teams[socket.team].jetons < amount) return socket.emit('error','Pas assez de jetons !');
    state.teams[socket.team].jetons -= amount;
    state.bets[socket.id] = { team:socket.team, type, value, amount, name:socket.playerName };
    io.emit('state-update', state);
    socket.emit('bet-placed', { type, value, amount });
  });

  socket.on('request-spin', () => {
    if (state.spinning) return socket.emit('error','Déjà en cours !');
    if (Object.keys(state.bets).length===0) return socket.emit('error','Personne n\'a misé !');
    doSpin(() => {});
  });

  socket.on('chat-message', ({ message }) => {
    if (!message||message.length>200) return;
    addChat(socket.playerName||'Anonyme', message, 'player', socket.team||'');
  });

  socket.on('disconnect', () => {
    TEAMS.forEach(t => { state.teams[t].membres = state.teams[t].membres.filter(m=>m.id!==socket.id); });
    delete state.bets[socket.id];
    io.emit('state-update', state);
  });
});

const PORT = process.env.PORT||3000;
httpServer.listen(PORT, ()=>console.log(`✅ Casino en ligne sur le port ${PORT}`));

// ════════════════════════════════════════════════════════════════════
//  BOT DISCORD
// ════════════════════════════════════════════════════════════════════
if (!process.env.DISCORD_TOKEN) {
  console.warn('⚠️  DISCORD_TOKEN absent — bot Discord désactivé');
} else {
  const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
  const bot = new Client({ intents:[GatewayIntentBits.Guilds] });

  // ── Commandes slash ──────────────────────────────────────────────
  const CMDS = [
    new SlashCommandBuilder()
      .setName('spin')
      .setDescription('🎰 Lance la roulette de casino !'),

    new SlashCommandBuilder()
      .setName('miser')
      .setDescription('💰 Mise des jetons avant le spin')
      .addStringOption(o=>o.setName('type').setDescription('Type de mise').setRequired(true)
        .addChoices(
          {name:'Numéro (x35)',value:'number'},
          {name:'Rouge (x2)',value:'color_rouge'},
          {name:'Noir (x2)',value:'color_noir'},
          {name:'Pair (x2)',value:'parity_pair'},
          {name:'Impair (x2)',value:'parity_impair'},
          {name:'1-12 (x3)',value:'dozen_1-12'},
          {name:'13-24 (x3)',value:'dozen_13-24'},
          {name:'25-36 (x3)',value:'dozen_25-36'},
        ))
      .addIntegerOption(o=>o.setName('mise').setDescription('Montant en jetons').setRequired(true).setMinValue(1).setMaxValue(500))
      .addIntegerOption(o=>o.setName('numero').setDescription('Numéro (0-36) si type = Numéro').setMinValue(0).setMaxValue(36)),

    new SlashCommandBuilder()
      .setName('equipe')
      .setDescription('👥 Rejoindre une équipe')
      .addStringOption(o=>o.setName('nom').setDescription('Ton prénom').setRequired(true))
      .addStringOption(o=>o.setName('equipe').setDescription('Équipe').setRequired(true)
        .addChoices(
          {name:'🔴 Rouge',value:'🔴 Rouge'},
          {name:'🔵 Bleu', value:'🔵 Bleu'},
          {name:'🟢 Vert', value:'🟢 Vert'},
          {name:'🟡 Or',   value:'🟡 Or'},
        )),

    new SlashCommandBuilder()
      .setName('scores')
      .setDescription('🏆 Tableau des scores'),

    new SlashCommandBuilder()
      .setName('jetons')
      .setDescription('💰 Jetons de chaque équipe'),

    new SlashCommandBuilder()
      .setName('mises')
      .setDescription('📋 Voir les mises en cours'),

    new SlashCommandBuilder()
      .setName('resetjetons')
      .setDescription('♻️ Remet les jetons à 1000 pour toutes les équipes'),

    new SlashCommandBuilder()
      .setName('casino')
      .setDescription('🔗 Lien vers le casino en direct'),

  ].map(c=>c.toJSON());

  bot.once('ready', async () => {
    console.log(`✅ Bot Discord : ${bot.user.tag}`);
    try {
      const rest = new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body:CMDS });
      console.log('✅ Commandes slash enregistrées');
    } catch(e) { console.error('❌ Commandes:', e.message); }
  });

  // Stocke les joueurs Discord : { discordId: { name, team } }
  const discordPlayers = {};

  bot.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const cmd  = interaction.commandName;
    const user = interaction.user.id;
    const uname= interaction.user.displayName ?? interaction.user.username;
    const channelId = interaction.channelId;

    // ── /equipe ────────────────────────────────────────────────────
    if (cmd === 'equipe') {
      const nom   = interaction.options.getString('nom');
      const team  = interaction.options.getString('equipe');
      // Retirer de l'ancienne équipe
      TEAMS.forEach(t => {
        state.teams[t].membres = state.teams[t].membres.filter(m=>m.id!==user);
      });
      state.teams[team].membres.push({ id:user, name:nom });
      discordPlayers[user] = { name:nom, team };
      io.emit('state-update', state);
      addChat('🎮 Discord', `${nom} a rejoint ${team} !`, 'ia', team);
      const color = team.includes('Rouge')?0xe74c3c:team.includes('Bleu')?0x3498db:team.includes('Vert')?0x2ecc71:0xf1c40f;
      await interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle(`👥 Équipe rejointe !`)
        .setDescription(`**${nom}** est maintenant dans l'équipe **${team}** !`)
        .setColor(color).setTimestamp()]});
    }

    // ── /miser ─────────────────────────────────────────────────────
    if (cmd === 'miser') {
      const player = discordPlayers[user];
      if (!player) return interaction.reply({ content:'❌ Rejoins d\'abord une équipe avec `/equipe` !', ephemeral:true });
      if (state.spinning) return interaction.reply({ content:'⏳ La roulette tourne, attend le prochain tour !', ephemeral:true });

      const typeRaw = interaction.options.getString('type');
      const mise    = interaction.options.getInteger('mise');
      const numero  = interaction.options.getInteger('numero');
      const team    = player.team;

      let type, value;
      if (typeRaw==='number') {
        if (numero===null) return interaction.reply({ content:'❌ Précise un numéro (0-36) !', ephemeral:true });
        type='number'; value=String(numero);
      } else {
        [type, value] = typeRaw.split('_');
      }

      if (state.teams[team].jetons < mise)
        return interaction.reply({ content:`❌ Pas assez de jetons ! (${state.teams[team].jetons} disponibles)`, ephemeral:true });

      state.teams[team].jetons -= mise;
      state.bets[user] = { team, type, value, amount:mise, name:player.name };
      io.emit('state-update', state);

      const label = type==='number'?`numéro ${value}`:type==='color'?value:type==='parity'?value:value;
      await interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle('💰 Mise enregistrée !')
        .setDescription(`**${player.name}** (${team}) mise **${mise} jetons** sur **${label}**`)
        .setColor(0xFFD700).setFooter({text:`Solde équipe : ${state.teams[team].jetons} jetons`}).setTimestamp()]});
    }

    // ── /spin ──────────────────────────────────────────────────────
    if (cmd === 'spin') {
      if (state.spinning) return interaction.reply({ content:'⏳ La roulette tourne déjà !', ephemeral:true });
      if (Object.keys(state.bets).length===0) return interaction.reply({ content:'❌ Personne n\'a misé ! Utilisez `/miser` d\'abord.', ephemeral:true });

      await interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle('🎰 La roulette tourne !')
        .setDescription(`**${uname}** a lancé la roulette !\n\n🔴 **[Regarder en direct](${process.env.PUBLIC_URL||'#'})**`)
        .setColor(0xFFD700).setFooter({text:`Spin #${state.spinCount+1}`}).setTimestamp()]});

      doSpin(async (result, recap, comment) => {
        const color = result===0?0x00AA00:RED_N.has(result)?0xFF0000:0x333333;
        const numStr = result===0?'🟢 0':RED_N.has(result)?`🔴 ${result}`:`⚫ ${result}`;

        // Ligne de recap par équipe
        const recapLines = TEAMS.map(t => {
          const r = recap[t];
          const g = r.gain>0?`+${r.gain}`:r.perte>0?`-${r.perte}`:'±0';
          const sign = r.gain>0?'📈':r.perte>0?'📉':'➖';
          return `${sign} ${t} : **${g} jetons** — Solde : ${state.teams[t].jetons}`;
        }).join('\n');

        try {
          const channel = bot.channels.cache.get(channelId);
          if (channel) await channel.send({ embeds:[new EmbedBuilder()
            .setTitle(`🎰 Résultat : ${numStr}`)
            .setDescription(`${comment}\n\n${recapLines}`)
            .setColor(color).setFooter({text:`Spin #${state.spinCount}`}).setTimestamp()]});
        } catch(e) { console.error('Erreur envoi résultat:', e.message); }
      });
    }

    // ── /scores ────────────────────────────────────────────────────
    if (cmd === 'scores') {
      const sorted = TEAMS.slice().sort((a,b)=>state.teams[b].score-state.teams[a].score);
      const medals = ['🥇','🥈','🥉','4️⃣'];
      const lines = sorted.map((t,i)=>`${medals[i]} ${t} : **${state.teams[t].score} pts**`).join('\n');
      await interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle('🏆 Tableau des scores').setDescription(lines).setColor(0xFFD700).setTimestamp()]});
    }

    // ── /jetons ────────────────────────────────────────────────────
    if (cmd === 'jetons') {
      const lines = TEAMS.map(t=>`${t} : **${state.teams[t].jetons} jetons**`).join('\n');
      await interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle('💰 Jetons par équipe').setDescription(lines).setColor(0x2ecc71).setTimestamp()]});
    }

    // ── /mises ─────────────────────────────────────────────────────
    if (cmd === 'mises') {
      const bets = Object.values(state.bets);
      if (bets.length===0) return interaction.reply({ content:'Aucune mise en cours.', ephemeral:true });
      const lines = bets.map(b=>`• **${b.name}** (${b.team}) → ${b.amount} jetons sur **${b.type==='number'?'n°'+b.value:b.value}**`).join('\n');
      await interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle(`📋 Mises en cours (${bets.length})`).setDescription(lines).setColor(0x5865F2).setTimestamp()]});
    }

    // ── /resetjetons ────────────────────────────────────────────────
    if (cmd === 'resetjetons') {
      TEAMS.forEach(t=>{ state.teams[t].jetons=1000; state.teams[t].score=0; });
      state.bets = {};
      io.emit('state-update', state);
      await interaction.reply('♻️ Jetons et scores remis à zéro !');
    }

    // ── /casino ────────────────────────────────────────────────────
    if (cmd === 'casino') {
      await interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle('🎰 Casino Royal — En direct')
        .setDescription(`🔴 **[Ouvrir le casino](${process.env.PUBLIC_URL||'#'})**`)
        .setColor(0xFFD700)]});
    }
  });

  bot.login(process.env.DISCORD_TOKEN).catch(e=>console.error('❌ Discord login:', e.message));
}
