// api/interactions.mjs — Handler tombol Discord untuk Vercel (tanpa koneksi gateway)
// Discord mengirim setiap klik tombol ke URL ini (Interactions Endpoint URL).
// Data ID role/channel dibaca dari bot-data.json yang dibuat oleh setup-server.js.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   DISCORD_TOKEN       token bot
//   DISCORD_PUBLIC_KEY  Public Key aplikasi (Developer Portal → General Information)
import { verifyKey } from 'discord-interactions';
import { waitUntil } from '@vercel/functions';
import { createRequire } from 'node:module';

const data = createRequire(import.meta.url)('../bot-data.json');

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;

// Bit permission Discord (BigInt, tanpa perlu discord.js)
const PERM = {
  AddReactions: 1n << 6n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
};
const bits = (...p) => String(p.reduce((a, b) => a | b, 0n));
const TICKET_PERMS = [PERM.ViewChannel, PERM.SendMessages, PERM.ReadMessageHistory, PERM.AttachFiles, PERM.EmbedLinks, PERM.AddReactions];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Discord REST ----------
async function discord(method, path, body, reason, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bot ${process.env.DISCORD_TOKEN}`;
  if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const editOriginal = (i, content) =>
  discord('PATCH', `/webhooks/${i.application_id}/${i.token}/messages/@original`, { content }, null, { auth: false });

// ---------- Response helpers ----------
const respond = (body) => Response.json(body);
const ephemeral = (content) => respond({ type: 4, data: { content, flags: EPHEMERAL } });
const publicMessage = (content) => respond({ type: 4, data: { content, allowed_mentions: { parse: [] } } });
const deferEphemeral = () => respond({ type: 5, data: { flags: EPHEMERAL } });

// ---------- Bahasa ----------
function userLang(i) {
  if (data.langMode !== 'both') return data.langMode;
  const roles = i.member?.roles || [];
  if (roles.includes(data.roles.lang_id)) return 'id';
  if (roles.includes(data.roles.lang_en)) return 'en';
  return i.locale?.startsWith('id') ? 'id' : 'en';
}
const say = (i, t, lang) => (typeof t === 'string' ? t : t[lang || userLang(i)]);
const both = (en, id) => (data.langMode === 'en' ? en : data.langMode === 'id' ? id : `${en} / ${id}`);

// ---------- Utilitas ----------
const staffIds = () => data.staffKeys.map((k) => data.roles[k]);
const isStaff = (i) => staffIds().some((id) => (i.member?.roles || []).includes(id));

async function sendLog(title, fields) {
  if (!data.channels.ticketlog) return;
  await discord('POST', `/channels/${data.channels.ticketlog}/messages`, {
    embeds: [{ color: data.embedColor, title, fields, timestamp: new Date().toISOString() }],
  }).catch((err) => console.error('log error:', err.message));
}

// Ambil channel tiket yang valid, atau null
async function getTicketChannel(i) {
  const ch = await discord('GET', `/channels/${i.channel_id}`);
  if (ch.parent_id !== data.ticketCategoryId || !ch.topic?.startsWith('ticket:')) return null;
  return ch;
}

// ---------- Handlers ----------
async function handleVerify(i) {
  const uid = i.member.user.id;
  if (i.member.roles.includes(data.roles.member)) return ephemeral(say(i, data.txt.alreadyVerified));
  await discord('PUT', `/guilds/${i.guild_id}/members/${uid}/roles/${data.roles.member}`, undefined, 'Verified via button');
  return ephemeral(say(i, data.txt.verified));
}

async function handleLanguage(i, lang) {
  if (!['id', 'en'].includes(lang)) return ephemeral(say(i, data.txt.error));
  const other = lang === 'id' ? 'en' : 'id';
  const base = `/guilds/${i.guild_id}/members/${i.member.user.id}/roles`;
  await Promise.all([
    discord('DELETE', `${base}/${data.roles[`lang_${other}`]}`, undefined, 'Language switch'),
    discord('PUT', `${base}/${data.roles[`lang_${lang}`]}`, undefined, 'Language switch'),
  ]);
  return ephemeral(data.txt.langSet[lang]);
}

async function handlePing(i, key) {
  const ping = data.pings.find((p) => p.key === key);
  if (!ping) return ephemeral(say(i, data.txt.error));
  const roleId = data.roles[`ping_${key}`];
  const has = i.member.roles.includes(roleId);
  const url = `/guilds/${i.guild_id}/members/${i.member.user.id}/roles/${roleId}`;
  await discord(has ? 'DELETE' : 'PUT', url, undefined, 'Notification toggle');
  return ephemeral(
    say(i, {
      en: has ? `🔕 Removed **${ping.label.en}** notifications.` : `${ping.emoji} You will now receive **${ping.label.en}** notifications.`,
      id: has ? `🔕 Notifikasi **${ping.label.id}** dinonaktifkan.` : `${ping.emoji} Kamu sekarang menerima notifikasi **${ping.label.id}**.`,
    }),
  );
}

async function openTicket(i, type, cfg) {
  const guildId = i.guild_id;
  const user = i.member.user;
  const lang = userLang(i);

  const channels = await discord('GET', `/guilds/${guildId}/channels`);
  const mine = channels.filter((c) => c.parent_id === data.ticketCategoryId && c.topic?.startsWith(`ticket:${user.id}:`));
  if (mine.length >= data.maxOpenTickets) {
    const link = `<#${mine[0].id}>`;
    return editOriginal(i, lang === 'id' ? `Kamu masih punya tiket yang terbuka: ${link}` : `You already have an open ticket: ${link}`);
  }

  const slug = (user.username || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
  const channel = await discord(
    'POST',
    `/guilds/${guildId}/channels`,
    {
      name: `${cfg.emoji}${data.sep}${data.ticketWord}-${slug}`.toLowerCase(),
      type: 0,
      parent_id: data.ticketCategoryId,
      topic: `ticket:${user.id}:${type}`,
      permission_overwrites: [
        { id: guildId, type: 0, deny: bits(PERM.ViewChannel) },
        { id: user.id, type: 1, allow: bits(...TICKET_PERMS) },
        ...staffIds().map((id) => ({ id, type: 0, allow: bits(...TICKET_PERMS, PERM.ManageMessages) })),
      ],
    },
    `Ticket (${type}) by ${user.username}`,
  );

  await discord('POST', `/channels/${channel.id}/messages`, {
    content: `<@${user.id}> <@&${data.roles.support}>`,
    allowed_mentions: { users: [user.id], roles: [data.roles.support] },
    embeds: cfg.embeds,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: data.buttons.claim, custom_id: 'ticket:claim', emoji: { name: '🙋' } },
          { type: 2, style: 4, label: data.buttons.close, custom_id: 'ticket:close', emoji: { name: '🔒' } },
        ],
      },
    ],
  });

  await sendLog(data.logTitles.opened, [
    { name: 'User', value: `<@${user.id}> (${user.id})`, inline: true },
    { name: 'Type', value: `${cfg.emoji} ${type}`, inline: true },
    { name: 'Channel', value: `<#${channel.id}>`, inline: true },
  ]);

  await editOriginal(i, lang === 'id' ? `✅ Tiket dibuat: <#${channel.id}>` : `✅ Ticket created: <#${channel.id}>`);
}

function handleTicketOpen(i, type) {
  const cfg = data.ticketTypes[type];
  if (!cfg || !data.ticketCategoryId) return ephemeral(say(i, data.txt.notReady));
  // Balas dulu (batas 3 detik dari Discord), kerjakan pembuatan tiket di latar belakang
  waitUntil(
    openTicket(i, type, cfg).catch((err) => {
      console.error('openTicket error:', err.message);
      return editOriginal(i, say(i, data.txt.error)).catch(() => {});
    }),
  );
  return deferEphemeral();
}

async function handleTicketClaim(i) {
  const ch = await getTicketChannel(i);
  if (!ch) return ephemeral(say(i, data.txt.notReady));
  if (!isStaff(i)) return ephemeral(say(i, data.txt.noPermission));
  const uid = i.member.user.id;
  waitUntil(
    sendLog(data.logTitles.claimed, [
      { name: 'Staff', value: `<@${uid}>`, inline: true },
      { name: 'Channel', value: `<#${ch.id}>`, inline: true },
    ]),
  );
  return publicMessage(`🙋 ${both(`<@${uid}> will handle this ticket.`, `<@${uid}> akan menangani tiket ini.`)}`);
}

async function handleTicketClose(i) {
  const ch = await getTicketChannel(i);
  if (!ch) return ephemeral(say(i, data.txt.notReady));
  const ownerId = ch.topic.split(':')[1];
  const uid = i.member.user.id;
  if (!isStaff(i) && uid !== ownerId) return ephemeral(say(i, data.txt.noPermission));

  waitUntil(
    (async () => {
      await sendLog(data.logTitles.closed, [
        { name: 'Closed by', value: `<@${uid}>`, inline: true },
        { name: 'Owner', value: `<@${ownerId}>`, inline: true },
        { name: 'Channel', value: `#${ch.name}`, inline: true },
      ]);
      await sleep(5000);
      await discord('DELETE', `/channels/${ch.id}`, undefined, `Ticket closed by ${i.member.user.username}`);
    })().catch((err) => console.error('closeTicket error:', err.message)),
  );
  return publicMessage(`🔒 ${both('Closing this ticket in 5 seconds…', 'Tiket ditutup dalam 5 detik…')}`);
}

async function route(i) {
  const [scope, action, extra] = i.data.custom_id.split(':');
  if (scope === 'verify') return handleVerify(i);
  if (scope === 'lang') return handleLanguage(i, action);
  if (scope === 'ping') return handlePing(i, action);
  if (scope === 'ticket' && action === 'open') return handleTicketOpen(i, extra);
  if (scope === 'ticket' && action === 'claim') return handleTicketClaim(i);
  if (scope === 'ticket' && action === 'close') return handleTicketClose(i);
  return ephemeral(say(i, data.txt.notReady));
}

// ---------- Entry point ----------
export default {
  async fetch(request) {
    if (request.method !== 'POST') return new Response('NexGen interactions endpoint is running.', { status: 200 });

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const raw = await request.text();

    const valid = signature && timestamp && process.env.DISCORD_PUBLIC_KEY
      && (await verifyKey(raw, signature, timestamp, process.env.DISCORD_PUBLIC_KEY));
    if (!valid) return new Response('Bad request signature', { status: 401 });

    const i = JSON.parse(raw);
    if (i.type === 1) return respond({ type: 1 }); // PING → PONG (verifikasi URL oleh Discord)
    if (i.type !== 3 || !i.guild_id) return new Response(null, { status: 204 }); // hanya tombol di dalam server

    try {
      return await route(i);
    } catch (err) {
      console.error(`interaction error (${i.data?.custom_id}):`, err.message);
      return ephemeral(say(i, data.txt.error));
    }
  },
};
