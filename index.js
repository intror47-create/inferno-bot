require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN. Create a .env file with DISCORD_TOKEN=<your bot token>');
  process.exit(1);
}

// Channel names (emoji-decorated) used to find the right channels
const WELCOME_CHANNEL_NAME = '⌖・welcome';
const TICKETS_CHANNEL_NAME = '🎫・tickets';
const BOT_COMMANDS_CHANNEL_NAME = '⚙・bot-commands';

const STORE_PATH = path.join(__dirname, 'invites.json');

// ---------- persistent invite-count store ----------
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}
function addInvite(guildId, inviterId) {
  const store = loadStore();
  store[guildId] = store[guildId] || {};
  store[guildId][inviterId] = (store[guildId][inviterId] || 0) + 1;
  saveStore(store);
  return store[guildId][inviterId];
}
function getInviteCount(guildId, userId) {
  const store = loadStore();
  return (store[guildId] && store[guildId][userId]) || 0;
}
function getSortedInvites(guildId) {
  const store = loadStore();
  const guildData = store[guildId] || {};
  return Object.entries(guildData).sort((a, b) => b[1] - a[1]);
}

// ---------- client setup ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

// guildId -> Map(code -> uses)
const inviteCache = new Map();

async function cacheGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, new Map(invites.map((i) => [i.code, i.uses])));
    console.log(`[invite] Cached ${invites.size} invite(s) for ${guild.name}`);
  } catch (err) {
    console.error(`[invite] Could not fetch invites for ${guild.name}:`, err.message);
  }
}

function findTextChannelByName(guild, name) {
  return guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildText && ch.name === name
  );
}

// ---------- ready: login, cache invites, ensure ticket panel ----------
client.once('ready', async () => {
  console.log(`INFERNO online as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    await cacheGuildInvites(guild);
    await ensureTicketPanel(guild);
  }
});

client.on('guildCreate', async (guild) => {
  await cacheGuildInvites(guild);
  await ensureTicketPanel(guild);
});

client.on('inviteCreate', (invite) => {
  const map = inviteCache.get(invite.guild.id) || new Map();
  map.set(invite.code, invite.uses);
  inviteCache.set(invite.guild.id, map);
});

client.on('inviteDelete', (invite) => {
  const map = inviteCache.get(invite.guild.id);
  if (map) map.delete(invite.code);
});

// ---------- invite tracking on member join ----------
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;

  // Auto-assign the "Member" role on join
  try {
    await guild.roles.fetch();
    const memberRole = guild.roles.cache.find((r) => r.name.toLowerCase() === 'member');
    if (memberRole) {
      await member.roles.add(memberRole);
      console.log(`[auto-role] Gave "${memberRole.name}" to ${member.user.tag}`);
    } else {
      console.warn('[auto-role] No role named "Member" found');
    }
  } catch (err) {
    console.error('[auto-role] Could not assign role:', err.message);
  }

  const oldMap = inviteCache.get(guild.id) || new Map();

  let newInvites;
  try {
    newInvites = await guild.invites.fetch();
  } catch (err) {
    console.error('[invite] Could not fetch invites on join:', err.message);
    return;
  }

  let usedInvite = null;
  for (const invite of newInvites.values()) {
    const oldUses = oldMap.get(invite.code) ?? 0;
    if (invite.uses > oldUses) {
      usedInvite = invite;
      break;
    }
  }

  // important: refresh the cache AFTER comparing
  inviteCache.set(guild.id, new Map(newInvites.map((i) => [i.code, i.uses])));

  const welcome = findTextChannelByName(guild, WELCOME_CHANNEL_NAME);
  if (!welcome) return;

  if (usedInvite && usedInvite.inviter) {
    const inviter = usedInvite.inviter;
    const count = addInvite(guild.id, inviter.id);
    const embed = new EmbedBuilder()
      .setTitle('New Recruit')
      .setColor(0xff4500)
      .setDescription(
        `${member} was invited by **${inviter.tag}**!\n` +
        `**${inviter.tag}** now has **${count}** invite${count === 1 ? '' : 's'}.`
      )
      .setTimestamp();
    await welcome.send({ embeds: [embed] }).catch(() => {});
  } else {
    await welcome
      .send(`${member} joined the server (invite source unknown — possibly a vanity URL or Discord discovery). Welcome!`)
      .catch(() => {});
  }
});

// ---------- ticket system ----------
const TICKET_OPEN_BUTTON_ID = 'inferno_open_ticket';
const TICKET_CLOSE_BUTTON_ID = 'inferno_close_ticket';
const TICKET_DELETE_BUTTON_ID = 'inferno_delete_ticket';
const TICKET_CANCEL_BUTTON_ID = 'inferno_cancel_delete';

async function ensureTicketPanel(guild) {
  const tickets = findTextChannelByName(guild, TICKETS_CHANNEL_NAME);
  if (!tickets) {
    console.warn(`[tickets] Channel "${TICKETS_CHANNEL_NAME}" not found in ${guild.name}`);
    return;
  }
  // If the bot already posted the panel, skip
  const recent = await tickets.messages.fetch({ limit: 20 }).catch(() => null);
  if (recent && recent.find((m) => m.author.id === client.user.id && m.components.length > 0)) {
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle('Need help?')
    .setColor(0xff4500)
    .setDescription(
      'Click the button below to open a private support ticket.\n' +
      'Only you and the staff team can see it once it is created.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_OPEN_BUTTON_ID)
      .setLabel('Open a Ticket')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary)
  );
  await tickets.send({ embeds: [embed], components: [row] }).catch(() => {});
  console.log(`[tickets] Panel posted in ${tickets.name}`);
}

async function openTicket(interaction) {
  const guild = interaction.guild;
  const name = `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);

  // one open ticket per user
  const existing = guild.channels.cache.find((ch) => ch.name === name && ch.type === ChannelType.GuildText);
  if (existing) {
    return interaction.reply({
      content: `You already have an open ticket: ${existing}`,
      ephemeral: true,
    });
  }

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    topic: `Support ticket for ${interaction.user.tag} (${interaction.user.id})`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      // Admins can always see tickets
      { id: guild.roles.premiumSubscriberRole?.id, allow: [] }, // placeholder, ignored if not found
    ].filter((o) => o.id),
  });

  const embed = new EmbedBuilder()
    .setTitle('Ticket Opened')
    .setColor(0xff4500)
    .setDescription(
      `Welcome ${interaction.user}! A staff member will be with you soon.\n\n` +
      'Use the button below to close this ticket when you are done.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_BUTTON_ID)
      .setLabel('Close Ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger)
  );
  await channel.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [row] });
  await interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
}

async function closeTicket(interaction) {
  const channel = interaction.channel;
  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  const isOwnerField = channel.topic && channel.topic.includes(interaction.user.id);
  if (!isAdmin && !isOwnerField) {
    return interaction.reply({ content: 'Only staff or the ticket opener can close this ticket.', ephemeral: true });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TICKET_DELETE_BUTTON_ID).setLabel('Delete Channel').setEmoji('🗑').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(TICKET_CANCEL_BUTTON_ID).setLabel('Keep It').setStyle(ButtonStyle.Secondary)
  );
  await interaction.reply({ content: 'Close this ticket? This will **delete the channel** and its history.', components: [row] });
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === TICKET_OPEN_BUTTON_ID) return openTicket(interaction);
      if (interaction.customId === TICKET_CLOSE_BUTTON_ID) return closeTicket(interaction);
      if (interaction.customId === TICKET_DELETE_BUTTON_ID) {
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        const isOwnerField = interaction.channel.topic && interaction.channel.topic.includes(interaction.user.id);
        if (!isAdmin && !isOwnerField) {
          return interaction.reply({ content: 'Not allowed.', ephemeral: true });
        }
        await interaction.reply({ content: 'Deleting ticket in 5 seconds...' });
        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
        return;
      }
      if (interaction.customId === TICKET_CANCEL_BUTTON_ID) {
        return interaction.reply({ content: 'Cancelled — ticket stays open.', ephemeral: true });
      }
    }
  } catch (err) {
    console.error('[interaction]', err);
    const msg = { content: 'Something went wrong with that action.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// ---------- prefix commands ----------
const PREFIX = '!';

function inviteEmbed(guild, user, count, title) {
  return new EmbedBuilder()
    .setTitle(title || 'Invite Count')
    .setColor(0xff4500)
    .setDescription(`<@${user.id}> has invited **${count}** player${count === 1 ? '' : 's'} to **Uncharted SMP**.`)
    .setTimestamp();
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = message.content.trim();
  if (!content.startsWith(PREFIX)) return;

  const [cmd, ...rest] = content.slice(PREFIX.length).split(/\s+/);
  const command = cmd.toLowerCase();
  const mentionArg = message.mentions.users.first();

  if (command === 'invite' || command === 'invites') {
    const target = mentionArg || message.author;
    const count = getInviteCount(message.guild.id, target.id);
    return message.reply({ embeds: [inviteEmbed(message.guild, target, count)] });
  }

  if (command === 'invites-top' || command === 'leaderboard') {
    const rows = getSortedInvites(message.guild.id).slice(0, 10);
    if (rows.length === 0) {
      return message.reply('No invites tracked yet. Go invite some friends!');
    }
    const lines = rows.map(([id, count], i) => `**${i + 1}.** <@${id}> — **${count}** invite${count === 1 ? '' : 's'}`);
    const embed = new EmbedBuilder()
      .setTitle('Invite Leaderboard')
      .setColor(0xffa500)
      .setDescription(lines.join('\n'))
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  if (command === 'ticket') {
    return message.reply('Use the **Open a Ticket** button in <#🎫・tickets> to open a private ticket.');
  }

  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('INFERNO — Commands')
      .setColor(0xff4500)
      .setDescription(
        [
          '`!invite` — show how many players you have invited',
          '`!invite @user` — show another player’s invites',
          '`!leaderboard` — top 10 inviters',
          '`!ticket` — open a support ticket',
          '`!help` — this menu',
        ].join('\n')
      );
    return message.reply({ embeds: [embed] });
  }
});

client.login(TOKEN);
