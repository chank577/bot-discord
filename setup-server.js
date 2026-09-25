// setup-server.js  (v2 — Bilingual / Dwibahasa: English + Bahasa Indonesia)
// Auto-setup server Discord: NexGen Development (marketplace asset Roblox)
//
// Cara pakai / Usage:
//   npm install
//   node setup-server.js                → setup (idempoten) lalu bot tetap online untuk tombol
//   node setup-server.js --setup-only   → setup saja, lalu keluar
//   node setup-server.js --refresh      → setup + kirim ulang panel/pesan + reset permission channel
//
// Hosting di Vercel: jalankan `node setup-server.js --setup-only` di komputermu. Script akan menulis
// bot-data.json (berisi ID role/channel), lalu tombol ditangani oleh api/interactions.mjs di Vercel.
//
// Fitur / Features:
//   • Nama channel, topic, dan pesan dwibahasa (EN + ID), bisa diatur: 'both' | 'en' | 'id'
//   • Gerbang verifikasi (tombol) → role Member membuka seluruh server
//   • Panel role: pilih bahasa (🇮🇩 / 🇬🇧) + role notifikasi (toggle)
//   • Sistem tiket (Order / Support / Report) dengan channel privat, klaim, dan tutup
//   • Log tiket ke channel staff, slowmode, pengaturan keamanan server
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  GuildVerificationLevel,
  GuildExplicitContentFilter,
  GuildDefaultMessageNotifications,
  PermissionFlagsBits: P,
} = require('discord.js');

// ============================================================
// KONFIGURASI / CONFIG — semua yang bisa kamu ubah ada di sini
// ============================================================
const SERVER_NAME = 'NexGen Development';
const SEP = '｜'; // pemisah emoji dan nama channel
const DELAY_MS = 700; // jeda antar request (anti rate limit)
const EMBED_COLOR = 0x5865f2;
const AUDIT_REASON = 'NexGen auto-setup';

const LANG_MODE = 'both'; // bahasa isi pesan & topic: 'both' | 'en' | 'id'
const NAME_MODE = 'both'; // bahasa nama channel/kategori: 'both' | 'en' | 'id'
const VERIFICATION_GATE = true; // true = user baru hanya lihat channel info sampai menekan tombol Verify
const APPLY_GUILD_SETTINGS = true; // atur verification level, filter konten, notifikasi default
const SET_SYSTEM_CHANNEL = true; // pesan join otomatis muncul di channel welcome
const MAX_OPEN_TICKETS = 1; // maksimal tiket terbuka per user

// Edit sesuai kebutuhan lalu jalankan `node setup-server.js --refresh`
const PAYMENT_METHODS = [
  'DANA — 08xx-xxxx-xxxx (a/n Your Name)',
  'OVO — 08xx-xxxx-xxxx (a/n Your Name)',
  'Bank Transfer — 0000-0000-0000 (a/n Your Name)',
  'PayPal — your-email@example.com',
];
const REFUND_WINDOW_DAYS = 3;

if (!['both', 'en', 'id'].includes(LANG_MODE) || !['both', 'en', 'id'].includes(NAME_MODE)) {
  throw new Error("LANG_MODE dan NAME_MODE harus 'both', 'en', atau 'id'.");
}

const ARGS = new Set(process.argv.slice(2));
const SETUP_ONLY = ARGS.has('--setup-only');
const REFRESH = ARGS.has('--refresh');

// ============================================================
// BAHASA / LANGUAGE HELPERS
// ============================================================
const FLAG = { en: '🇬🇧', id: '🇮🇩' };
const LANG_COLOR = { en: 0x3498db, id: 0xe74c3c };
const ACTIVE_LANGS = LANG_MODE === 'both' ? ['en', 'id'] : [LANG_MODE];

// Teks inline ({en, id} atau string) sesuai LANG_MODE
const pick = (t, sep = ' | ') => (typeof t === 'string' ? t : ACTIVE_LANGS.map((l) => t[l]).join(sep));

// Nama channel/kategori sesuai NAME_MODE
function pickName(n, joiner) {
  if (typeof n === 'string') return n;
  if (NAME_MODE === 'en') return n.en;
  if (NAME_MODE === 'id') return n.id;
  return n.en === n.id ? n.en : `${n.en}${joiner}${n.id}`;
}

// ============================================================
// ROLE — diurutkan dari tertinggi ke terendah
// ============================================================
const ROLES = [
  { key: 'owner', name: 'Owner', color: 0xf1c40f, hoist: true, admin: true },
  {
    key: 'admin', name: 'Admin', color: 0xe74c3c, hoist: true,
    perms: [P.ManageGuild, P.ManageChannels, P.ManageRoles, P.ManageMessages, P.ManageThreads,
      P.KickMembers, P.BanMembers, P.ModerateMembers, P.MentionEveryone, P.ViewAuditLog],
  },
  {
    key: 'moderator', name: 'Moderator', color: 0xe67e22, hoist: true,
    perms: [P.ManageMessages, P.ManageThreads, P.KickMembers, P.ModerateMembers, P.MuteMembers, P.ViewAuditLog],
  },
  { key: 'support', name: 'Support Staff', color: 0x9b59b6, hoist: true, perms: [P.ManageMessages, P.ModerateMembers] },
  { key: 'developer', name: 'Developer', color: 0x3498db, hoist: true },
  { key: 'seller', name: 'Verified Seller', color: 0x2ecc71, hoist: true },
  { key: 'vip', name: 'VIP Customer', color: 0xe91e63, hoist: true },
  { key: 'buyer', name: 'Verified Buyer', color: 0x1abc9c },
  { key: 'member', name: 'Member', color: 0x95a5a6 },
  { key: 'lang_id', name: '🇮🇩 Bahasa Indonesia', color: 0xe74c3c },
  { key: 'lang_en', name: '🇬🇧 English', color: 0x3498db },
  { key: 'ping_news', name: '🔔 Announcements', color: 0xf39c12 },
  { key: 'ping_assets', name: '🛍️ New Assets', color: 0x2ecc71 },
  { key: 'ping_giveaway', name: '🎁 Giveaways', color: 0xe91e63 },
  { key: 'muted', name: 'Muted', color: 0x7f8c8d },
];

// Role staff: bisa kirim pesan di channel read-only, lihat channel staff, dan mengelola tiket
const STAFF = ['owner', 'admin', 'moderator', 'support'];
// Role tepercaya: tetap bisa melihat channel meski belum punya role Member
const TRUSTED = ['developer', 'seller', 'vip', 'buyer'];

// Role notifikasi yang bisa di-toggle lewat panel
const PING_ROLES = [
  { key: 'news', emoji: '🔔', label: { en: 'Announcements', id: 'Pengumuman' } },
  { key: 'assets', emoji: '🛍️', label: { en: 'New Assets', id: 'Asset Baru' } },
  { key: 'giveaway', emoji: '🎁', label: { en: 'Giveaways', id: 'Giveaway' } },
];

// ============================================================
// PRESET PERMISSION — "role" boleh string atau array key role; 'everyone' = @everyone
// ============================================================
const ACCESS = {
  PUBLIC_READONLY: [
    {
      role: 'everyone',
      allow: [P.ViewChannel, P.ReadMessageHistory, P.AddReactions],
      deny: [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads],
    },
    { role: STAFF, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles] },
  ],
  PUBLIC_CHAT: [
    {
      role: 'everyone',
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AddReactions, P.EmbedLinks, P.AttachFiles],
    },
  ],
  SELLER_POST: [
    {
      role: 'everyone',
      allow: [P.ViewChannel, P.ReadMessageHistory, P.AddReactions],
      deny: [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads],
    },
    { role: [...STAFF, 'seller', 'developer'], allow: [P.SendMessages, P.EmbedLinks, P.AttachFiles] },
  ],
  BUYER_POST: [
    {
      role: 'everyone',
      allow: [P.ViewChannel, P.ReadMessageHistory, P.AddReactions],
      deny: [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads],
    },
    { role: [...STAFF, 'buyer', 'vip'], allow: [P.SendMessages, P.EmbedLinks, P.AttachFiles] },
  ],
  STAFF_ONLY: [
    { role: 'everyone', deny: [P.ViewChannel] },
    {
      role: STAFF,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.AttachFiles],
    },
  ],
  PUBLIC_VOICE: [
    { role: 'everyone', allow: [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD] },
  ],
  STAFF_VOICE: [
    { role: 'everyone', deny: [P.ViewChannel, P.Connect] },
    { role: STAFF, allow: [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD] },
  ],
};

// Role Muted otomatis ditambahkan ke semua preset non-staff
const MUTED_RULE = {
  role: 'muted',
  deny: [P.SendMessages, P.SendMessagesInThreads, P.AddReactions, P.Speak],
};

// ============================================================
// STRUKTUR SERVER — kategori → channel
// type: 'text' | 'voice' | 'news' (news butuh fitur Community, otomatis fallback ke text)
// name: string, atau { en, id }.  gated: true = butuh role Member (bila VERIFICATION_GATE aktif)
// ============================================================
const STRUCTURE = [
  {
    emoji: '📌', category: { en: 'INFORMATION', id: 'INFORMASI' }, gated: false,
    channels: [
      { key: 'welcome', emoji: '👋', name: { en: 'welcome', id: 'selamat-datang' }, type: 'text', access: 'PUBLIC_READONLY',
        topic: { en: `Welcome to ${SERVER_NAME}!`, id: `Selamat datang di ${SERVER_NAME}!` } },
      { key: 'verify', emoji: '✅', name: { en: 'verify', id: 'verifikasi' }, type: 'text', access: 'PUBLIC_READONLY',
        topic: { en: 'Press the button to unlock the server.', id: 'Tekan tombol untuk membuka server.' } },
      { key: 'rules', emoji: '📜', name: { en: 'rules', id: 'peraturan' }, type: 'text', access: 'PUBLIC_READONLY',
        topic: { en: 'Must-read before trading.', id: 'Wajib dibaca sebelum bertransaksi.' } },
      { key: 'announce', emoji: '📢', name: { en: 'announcements', id: 'pengumuman' }, type: 'news', access: 'PUBLIC_READONLY',
        topic: { en: 'Official announcements and updates.', id: 'Pengumuman resmi dan update terbaru.' } },
      { key: 'faq', emoji: '❓', name: { en: 'faq', id: 'faq' }, type: 'text', access: 'PUBLIC_READONLY',
        topic: { en: 'Frequently asked questions.', id: 'Pertanyaan yang sering ditanyakan.' } },
      { key: 'roles', emoji: '🎭', name: { en: 'get-roles', id: 'ambil-role' }, type: 'text', access: 'PUBLIC_READONLY', gated: true,
        topic: { en: 'Pick your language and notification roles.', id: 'Pilih bahasa dan role notifikasi.' } },
    ],
  },
  {
    emoji: '🛒', category: { en: 'MARKETPLACE', id: 'MARKETPLACE' }, gated: true,
    channels: [
      { key: 'howto', emoji: '📝', name: { en: 'how-to-order', id: 'cara-order' }, type: 'text', access: 'PUBLIC_READONLY',
        topic: { en: 'Complete guide to buying assets.', id: 'Panduan lengkap cara membeli asset.' } },
      { key: 'catalog', emoji: '🛍️', name: { en: 'asset-catalog', id: 'katalog-asset' }, type: 'text', access: 'SELLER_POST',
        topic: { en: 'Roblox assets for sale (scripts, models, UI, maps, etc).', id: 'Daftar asset Roblox yang dijual (script, model, UI, map, dll).' } },
      { key: 'request', emoji: '🙋', name: { en: 'asset-requests', id: 'request-asset' }, type: 'text', access: 'PUBLIC_CHAT', slow: 30,
        topic: { en: 'Looking for a specific asset? Request it here.', id: 'Cari asset tertentu? Request di sini.' } },
      { key: 'refund', emoji: '💸', name: { en: 'refund-policy', id: 'kebijakan-refund' }, type: 'text', access: 'PUBLIC_READONLY',
        topic: { en: 'Refund and warranty terms.', id: 'Ketentuan refund dan garansi.' } },
      { key: 'testi', emoji: '⭐', name: { en: 'reviews', id: 'testimoni' }, type: 'text', access: 'BUYER_POST',
        topic: { en: 'Reviews from verified buyers.', id: 'Testimoni dari pembeli terverifikasi.' } },
    ],
  },
  {
    emoji: '🎫', category: { en: 'TRANSACTIONS', id: 'TRANSAKSI' }, gated: true,
    channels: [
      { key: 'ticket', emoji: '🎟️', name: { en: 'create-ticket', id: 'buat-tiket' }, type: 'text', access: 'PUBLIC_READONLY',
        topic: { en: 'Open a ticket for orders, support or reports.', id: 'Buka tiket untuk order, bantuan, atau laporan.' } },
      { key: 'payment', emoji: '💳', name: { en: 'payment-info', id: 'info-pembayaran' }, type: 'text', access: 'PUBLIC_READONLY',
        topic: { en: 'Official payment methods.', id: 'Metode pembayaran resmi.' } },
      { key: 'status', emoji: '📦', name: { en: 'order-status', id: 'status-order' }, type: 'text', access: 'PUBLIC_READONLY',
        topic: { en: 'Order status updates.', id: 'Update status order.' } },
    ],
  },
  {
    // Kategori tempat tiket dibuat oleh bot (tidak punya channel statis)
    emoji: '📂', category: { en: 'TICKETS', id: 'TIKET' }, access: 'STAFF_ONLY', tickets: true, channels: [],
  },
  {
    emoji: '💬', category: { en: 'COMMUNITY', id: 'KOMUNITAS' }, gated: true,
    channels: [
      { key: 'general', emoji: '💬', name: { en: 'general-chat', id: 'obrolan-umum' }, type: 'text', access: 'PUBLIC_CHAT', slow: 3,
        topic: { en: 'Casual chat about Roblox dev (any language).', id: 'Ngobrol santai seputar Roblox dev (bahasa bebas).' } },
      { key: 'chat_en', emoji: '🇬🇧', name: 'english-lounge', type: 'text', access: 'PUBLIC_CHAT', slow: 3,
        topic: { en: 'English-speaking corner.', id: 'Sudut untuk berbahasa Inggris.' } },
      { key: 'chat_id', emoji: '🇮🇩', name: 'ruang-indonesia', type: 'text', access: 'PUBLIC_CHAT', slow: 3,
        topic: { en: 'Indonesian-speaking corner.', id: 'Sudut untuk berbahasa Indonesia.' } },
      { key: 'showcase', emoji: '🎮', name: { en: 'showcase', id: 'showcase' }, type: 'text', access: 'PUBLIC_CHAT', slow: 10,
        topic: { en: 'Show off your games and work.', id: 'Pamerkan game atau hasil kerjamu.' } },
      { key: 'feedback', emoji: '💡', name: { en: 'suggestions', id: 'saran-dan-feedback' }, type: 'text', access: 'PUBLIC_CHAT', slow: 60,
        topic: { en: 'Suggestions for the server and our products.', id: 'Saran untuk server dan produk kami.' } },
      { key: 'media', emoji: '📸', name: { en: 'media', id: 'media' }, type: 'text', access: 'PUBLIC_CHAT', slow: 5,
        topic: { en: 'Images, videos and screenshots.', id: 'Gambar, video, dan screenshot.' } },
    ],
  },
  {
    emoji: '🛠️', category: { en: 'SUPPORT', id: 'BANTUAN' }, gated: true,
    channels: [
      { key: 'help', emoji: '🆘', name: { en: 'help', id: 'bantuan' }, type: 'text', access: 'PUBLIC_CHAT', slow: 5,
        topic: { en: 'Help using assets you have purchased.', id: 'Bantuan penggunaan asset yang sudah dibeli.' } },
      { key: 'bug', emoji: '🐞', name: { en: 'bug-reports', id: 'laporan-bug' }, type: 'text', access: 'PUBLIC_CHAT', slow: 30,
        topic: { en: 'Report bugs in our assets.', id: 'Laporkan bug pada asset.' } },
    ],
  },
  {
    emoji: '🔊', category: { en: 'VOICE', id: 'VOICE' }, gated: true,
    channels: [
      { key: 'vc1', emoji: '🔊', name: { en: 'Lounge', id: 'Ruang Umum' }, type: 'voice', access: 'PUBLIC_VOICE' },
      { key: 'vc2', emoji: '💻', name: { en: 'Developer Talk', id: 'Diskusi Developer' }, type: 'voice', access: 'PUBLIC_VOICE' },
      { key: 'vc_id', emoji: '🇮🇩', name: 'Ruang Indonesia', type: 'voice', access: 'PUBLIC_VOICE' },
      { key: 'vc_en', emoji: '🇬🇧', name: 'English Room', type: 'voice', access: 'PUBLIC_VOICE' },
    ],
  },
  {
    emoji: '🔒', category: { en: 'STAFF', id: 'STAFF' }, access: 'STAFF_ONLY',
    channels: [
      { key: 'staffchat', emoji: '🗨️', name: 'staff-chat', type: 'text', access: 'STAFF_ONLY',
        topic: { en: 'Internal staff chat.', id: 'Obrolan internal staff.' } },
      { key: 'txlog', emoji: '🧾', name: { en: 'transaction-log', id: 'log-transaksi' }, type: 'text', access: 'STAFF_ONLY',
        topic: { en: 'Transaction records.', id: 'Catatan transaksi.' } },
      { key: 'modlog', emoji: '🛡️', name: { en: 'mod-log', id: 'log-moderasi' }, type: 'text', access: 'STAFF_ONLY',
        topic: { en: 'Moderation records.', id: 'Catatan moderasi.' } },
      { key: 'ticketlog', emoji: '📑', name: { en: 'ticket-logs', id: 'log-tiket' }, type: 'text', access: 'STAFF_ONLY',
        topic: { en: 'Ticket open/close/claim logs.', id: 'Log tiket dibuka/ditutup/diklaim.' } },
      { key: 'staffvc', emoji: '🎙️', name: 'Staff Voice', type: 'voice', access: 'STAFF_VOICE' },
    ],
  },
];

// ============================================================
// PESAN AWAL / INITIAL MESSAGES (EN + ID)
// Placeholder {#key} otomatis menjadi mention channel (mis. {#rules} → #peraturan)
// ============================================================
const MESSAGES = {
  welcome: {
    en: {
      title: `Welcome to ${SERVER_NAME}!`,
      description:
        'The marketplace for Roblox assets: scripts, models, UI, maps and complete game systems.\n\n' +
        '**Get started**\n' +
        '1. Verify yourself in {#verify}\n' +
        '2. Pick your language & notifications in {#roles}\n' +
        '3. Read the {#rules}\n' +
        '4. Browse products in {#catalog}\n' +
        '5. Need help? Open a ticket in {#ticket}',
    },
    id: {
      title: `Selamat datang di ${SERVER_NAME}!`,
      description:
        'Marketplace asset Roblox: script, model, UI, map, dan sistem game lengkap.\n\n' +
        '**Mulai dari sini**\n' +
        '1. Verifikasi dirimu di {#verify}\n' +
        '2. Pilih bahasa & notifikasi di {#roles}\n' +
        '3. Baca {#rules}\n' +
        '4. Lihat produk di {#catalog}\n' +
        '5. Butuh bantuan? Buka tiket di {#ticket}',
    },
  },
  verify: {
    en: {
      title: 'Verification',
      description: 'Press the button below to verify yourself and unlock the rest of the server.\nBy verifying, you agree to follow the {#rules}.',
    },
    id: {
      title: 'Verifikasi',
      description: 'Tekan tombol di bawah untuk memverifikasi dirimu dan membuka seluruh channel server.\nDengan verifikasi, kamu setuju mengikuti {#rules}.',
    },
  },
  rules: {
    en: {
      title: 'Server Rules',
      description:
        '**1. Respect** everyone. No harassment, hate speech or discrimination.\n' +
        '**2. No spam** or unauthorised advertising.\n' +
        '**3. Official tickets only.** All trades go through a ticket. Staff will never ask for payment via DM.\n' +
        '**4. No leaking or reselling** purchased assets without permission.\n' +
        '**5. No scams.** Scammers are permanently banned.\n' +
        '**6. Use the right channel** and, where possible, the right language room.\n' +
        '**7. Follow** the Discord Terms of Service and Community Guidelines.\n\n' +
        'Staff decisions are final. Rules may change without notice.',
    },
    id: {
      title: 'Peraturan Server',
      description:
        '**1. Hormati** semua member dan staff. Dilarang melecehkan, ujaran kebencian, atau diskriminasi.\n' +
        '**2. Dilarang spam** atau promosi tanpa izin.\n' +
        '**3. Hanya tiket resmi.** Semua transaksi wajib melalui tiket. Staff tidak akan meminta pembayaran lewat DM.\n' +
        '**4. Dilarang menyebarkan atau menjual ulang** asset yang dibeli tanpa izin.\n' +
        '**5. Dilarang menipu.** Penipu akan di-ban permanen.\n' +
        '**6. Gunakan channel yang tepat** dan, bila memungkinkan, ruang bahasa yang sesuai.\n' +
        '**7. Ikuti** Discord Terms of Service dan Community Guidelines.\n\n' +
        'Keputusan staff bersifat final. Peraturan dapat berubah sewaktu-waktu.',
    },
  },
  faq: {
    en: {
      title: 'FAQ',
      description:
        '**Can I use the assets in commercial games?**\nCheck the license in each asset description.\n\n' +
        '**How long does delivery take?**\nUsually right after staff verify your payment.\n\n' +
        '**What if I find a bug?**\nReport it in {#bug} or open a Support ticket in {#ticket}.\n\n' +
        '**Can I request a custom asset?**\nYes! Post it in {#request} or open an Order ticket.\n\n' +
        '**Can I get a refund?**\nPlease read {#refund}.',
    },
    id: {
      title: 'FAQ',
      description:
        '**Apakah asset bisa dipakai di game komersial?**\nCek ketentuan lisensi di deskripsi masing-masing asset.\n\n' +
        '**Berapa lama proses pengiriman?**\nUmumnya setelah pembayaran terverifikasi oleh staff.\n\n' +
        '**Bagaimana jika ada bug?**\nLaporkan di {#bug} atau buka tiket Bantuan di {#ticket}.\n\n' +
        '**Bisa request asset custom?**\nBisa! Tulis di {#request} atau buka tiket Pesan.\n\n' +
        '**Apakah bisa refund?**\nSilakan baca {#refund}.',
    },
  },
  roles: {
    en: {
      title: 'Get Your Roles',
      description:
        '**Language**\nChoose the language the bot uses when replying to you.\n\n' +
        '**Notifications**\nToggle the pings you want. Press a button again to remove the role.',
    },
    id: {
      title: 'Ambil Role Kamu',
      description:
        '**Bahasa**\nPilih bahasa yang dipakai bot saat membalasmu.\n\n' +
        '**Notifikasi**\nAktifkan ping yang kamu mau. Tekan tombol lagi untuk melepas role.',
    },
  },
  howto: {
    en: {
      title: 'How to Order',
      description:
        '1. Choose an asset in {#catalog}.\n' +
        '2. Open an **Order** ticket in {#ticket}.\n' +
        '3. Tell us the asset name and your preferred payment method.\n' +
        '4. Pay following {#payment}, then send your proof of payment in the ticket.\n' +
        '5. Staff verifies and delivers the asset to you.\n' +
        '6. Leave a review in {#testi}.',
    },
    id: {
      title: 'Cara Order Asset',
      description:
        '1. Pilih asset di {#catalog}.\n' +
        '2. Buka tiket **Pesan** di {#ticket}.\n' +
        '3. Sebutkan nama asset dan metode pembayaran yang dipilih.\n' +
        '4. Bayar sesuai {#payment}, lalu kirim bukti transfer di tiket.\n' +
        '5. Staff memverifikasi dan mengirim asset kepadamu.\n' +
        '6. Tinggalkan review di {#testi}.',
    },
  },
  payment: {
    en: {
      title: 'Payment Info',
      description:
        'Only pay through the official methods below, and only after staff confirm your order in a ticket.\n\n' +
        PAYMENT_METHODS.map((m) => `• ${m}`).join('\n') +
        '\n\n⚠️ Staff will **never** ask you to pay via DM. Always send proof of payment inside your ticket ({#ticket}).',
    },
    id: {
      title: 'Info Pembayaran',
      description:
        'Bayar hanya lewat metode resmi di bawah, dan hanya setelah staff mengonfirmasi ordermu di tiket.\n\n' +
        PAYMENT_METHODS.map((m) => `• ${m}`).join('\n') +
        '\n\n⚠️ Staff **tidak akan pernah** meminta pembayaran lewat DM. Selalu kirim bukti bayar di dalam tiketmu ({#ticket}).',
    },
  },
  refund: {
    en: {
      title: 'Refund Policy',
      description:
        `Refunds are reviewed case by case through a ticket, within **${REFUND_WINDOW_DAYS} days** of delivery.\n\n` +
        '**Eligible**\n• The asset does not work as described and we cannot fix it\n• You received a different asset from the one you ordered\n\n' +
        '**Not eligible**\n• Change of mind after delivery\n• The asset was modified, leaked or resold\n• Problems caused by other scripts or your own game setup\n\n' +
        'Open a **Support** ticket in {#ticket} with your proof of purchase.',
    },
    id: {
      title: 'Kebijakan Refund',
      description:
        `Refund ditinjau kasus per kasus melalui tiket, maksimal **${REFUND_WINDOW_DAYS} hari** setelah asset dikirim.\n\n` +
        '**Bisa direfund**\n• Asset tidak berfungsi sesuai deskripsi dan tidak bisa kami perbaiki\n• Asset yang diterima berbeda dengan yang dipesan\n\n' +
        '**Tidak bisa direfund**\n• Berubah pikiran setelah asset dikirim\n• Asset sudah dimodifikasi, dibocorkan, atau dijual ulang\n• Masalah akibat script lain atau setup game kamu sendiri\n\n' +
        'Buka tiket **Bantuan** di {#ticket} beserta bukti pembelian.',
    },
  },
  ticket: {
    en: {
      title: 'Open a Ticket',
      description:
        'Choose a ticket type below. A private channel will be created for you and our staff.\n\n' +
        '🛒 **Order** – buy an asset or request custom work\n' +
        '🛠️ **Support** – help with an asset you bought\n' +
        '🚨 **Report** – scams, rule-breakers or staff issues\n\n' +
        `You can have up to **${MAX_OPEN_TICKETS}** open ticket(s) at a time.`,
    },
    id: {
      title: 'Buka Tiket',
      description:
        'Pilih jenis tiket di bawah. Channel privat akan dibuat untukmu dan staff kami.\n\n' +
        '🛒 **Pesan** – beli asset atau request pekerjaan custom\n' +
        '🛠️ **Bantuan** – bantuan untuk asset yang sudah dibeli\n' +
        '🚨 **Laporan** – penipuan, pelanggar aturan, atau masalah dengan staff\n\n' +
        `Kamu bisa punya maksimal **${MAX_OPEN_TICKETS}** tiket terbuka sekaligus.`,
    },
  },
  request: {
    en: {
      title: 'Asset Requests',
      description: 'Looking for something specific? Post:\n• Asset name / type\n• What it should do\n• References (image or video)\n• Your budget\n\nSellers and developers will reply.',
    },
    id: {
      title: 'Request Asset',
      description: 'Cari asset tertentu? Tulis:\n• Nama / jenis asset\n• Fungsi yang diinginkan\n• Referensi (gambar atau video)\n• Budget kamu\n\nSeller dan developer akan membalas.',
    },
  },
  status: {
    en: {
      title: 'Order Status',
      description: 'Staff post order progress here (e.g. Processing, Delivered, Completed). Questions about your order? Open a ticket in {#ticket}.',
    },
    id: {
      title: 'Status Order',
      description: 'Staff memposting progres order di sini (mis. Diproses, Terkirim, Selesai). Ada pertanyaan soal ordermu? Buka tiket di {#ticket}.',
    },
  },
  bug: {
    en: {
      title: 'Bug Report Template',
      description: 'Please include:\n• Asset name & version\n• What happened\n• What you expected\n• Steps to reproduce\n• Screenshot, video or Output logs',
    },
    id: {
      title: 'Template Laporan Bug',
      description: 'Sertakan:\n• Nama & versi asset\n• Apa yang terjadi\n• Yang kamu harapkan\n• Langkah untuk mereproduksi\n• Screenshot, video, atau log Output',
    },
  },
};

// Jenis tiket / Ticket types
const TICKET_TYPES = {
  order: {
    emoji: '🛒', style: ButtonStyle.Success, label: { en: 'Order', id: 'Pesan' },
    en: {
      title: '🛒 Order Ticket',
      description: 'Thanks for your interest! Please tell us:\n1. Asset name(s)\n2. Preferred payment method (see {#payment})\n3. Your Roblox username\n\nA staff member will reply shortly.',
    },
    id: {
      title: '🛒 Tiket Pesan',
      description: 'Terima kasih atas ketertarikanmu! Mohon sebutkan:\n1. Nama asset\n2. Metode pembayaran yang dipilih (lihat {#payment})\n3. Username Roblox kamu\n\nStaff akan segera membalas.',
    },
  },
  support: {
    emoji: '🛠️', style: ButtonStyle.Primary, label: { en: 'Support', id: 'Bantuan' },
    en: {
      title: '🛠️ Support Ticket',
      description: 'Please describe your problem and include:\n• Asset name\n• What happened vs. what you expected\n• Screenshot, video or Output logs\n\nA staff member will reply shortly.',
    },
    id: {
      title: '🛠️ Tiket Bantuan',
      description: 'Jelaskan masalahmu dan sertakan:\n• Nama asset\n• Yang terjadi vs. yang diharapkan\n• Screenshot, video, atau log Output\n\nStaff akan segera membalas.',
    },
  },
  report: {
    emoji: '🚨', style: ButtonStyle.Danger, label: { en: 'Report', id: 'Laporan' },
    en: {
      title: '🚨 Report Ticket',
      description: 'Please describe what happened, who is involved and attach evidence (screenshots, links). Your report is only visible to staff.',
    },
    id: {
      title: '🚨 Tiket Laporan',
      description: 'Jelaskan apa yang terjadi, siapa yang terlibat, dan lampirkan bukti (screenshot, link). Laporanmu hanya terlihat oleh staff.',
    },
  },
};

// Balasan singkat bot / Bot reply strings
const TXT = {
  verified: { en: '✅ You are verified. Welcome aboard! Check out {#roles} for language & notification roles.', id: '✅ Kamu sudah terverifikasi. Selamat datang! Cek {#roles} untuk role bahasa & notifikasi.' },
  alreadyVerified: { en: 'You are already verified.', id: 'Kamu sudah terverifikasi.' },
  langSet: { en: '🇬🇧 Language set to **English**.', id: '🇮🇩 Bahasa diatur ke **Bahasa Indonesia**.' },
  noPermission: { en: '⛔ You do not have permission to do that.', id: '⛔ Kamu tidak punya izin untuk melakukan itu.' },
  closing: { en: '🔒 Closing this ticket in 5 seconds…', id: '🔒 Tiket ditutup dalam 5 detik…' },
  error: {
    en: '⚠️ Something went wrong. Please try again or contact staff (the bot may lack permission to manage this role).',
    id: '⚠️ Terjadi kesalahan. Coba lagi atau hubungi staff (bot mungkin tidak punya izin mengelola role ini).',
  },
  notReady: { en: '⚠️ This feature is not ready yet. Please contact staff.', id: '⚠️ Fitur ini belum siap. Silakan hubungi staff.' },
};

// ============================================================
// LOGIKA — tidak perlu diubah
// ============================================================
const TYPE = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  news: ChannelType.GuildAnnouncement,
};

// Diisi saat setup, dipakai oleh handler tombol
const ROLE_ID = {};
const CHANNEL_ID = {};
const CATEGORY_ID = {};
const openingTickets = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (icon, msg) => console.log(`${icon}  ${msg}`);

const categoryName = (group) => `${group.emoji} ${pickName(group.category, ' / ')}`;

function channelName(def) {
  const base = pickName(def.name, def.type === 'voice' ? ' / ' : '-');
  const full = def.emoji ? `${def.emoji}${SEP}${base}` : base;
  return def.type === 'voice' ? full : full.toLowerCase().replace(/\s+/g, '-');
}

// {#key} → <#channelId>
const resolveMentions = (text) =>
  text.replace(/\{#(\w+)\}/g, (_, key) => (CHANNEL_ID[key] ? `<#${CHANNEL_ID[key]}>` : `**#${key}**`));

// Satu embed per bahasa aktif
function buildEmbeds(msg) {
  return ACTIVE_LANGS.map((l) =>
    new EmbedBuilder()
      .setColor(LANG_COLOR[l])
      .setTitle(msg[l].title.startsWith(FLAG[l]) ? msg[l].title : `${FLAG[l]} ${msg[l].title}`)
      .setDescription(resolveMentions(msg[l].description)),
  );
}

// ---------- Tombol / panel ----------
const btn = (id, label, style, emoji) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
};
const row = (...buttons) => new ActionRowBuilder().addComponents(buttons);

const PANELS = {
  verify: () => [row(btn('verify', pick({ en: 'Verify', id: 'Verifikasi' }, ' / '), ButtonStyle.Success, '✅'))],
  roles: () => [
    row(
      btn('lang:id', 'Bahasa Indonesia', ButtonStyle.Primary, '🇮🇩'),
      btn('lang:en', 'English', ButtonStyle.Primary, '🇬🇧'),
    ),
    row(...PING_ROLES.map((p) => btn(`ping:${p.key}`, pick(p.label, ' / '), ButtonStyle.Secondary, p.emoji))),
  ],
  ticket: () => [
    row(...Object.entries(TICKET_TYPES).map(([key, c]) => btn(`ticket:open:${key}`, pick(c.label, ' / '), c.style, c.emoji))),
  ],
};

// ---------- Permission ----------
function buildOverwrites(guild, accessKey, gated = false) {
  let rules = ACCESS[accessKey].map((r) => ({ ...r }));
  const isStaffPreset = accessKey.startsWith('STAFF');

  if (VERIFICATION_GATE && gated && !isStaffPreset) {
    // @everyone kehilangan ViewChannel; role Member/staff/tepercaya yang mendapatkannya.
    // Izin lain (kirim pesan, dll) tetap di level @everyone supaya role Muted tetap efektif.
    rules = rules.map((r) => {
      if (r.role !== 'everyone') return r;
      return {
        ...r,
        allow: (r.allow || []).filter((perm) => perm !== P.ViewChannel),
        deny: [...(r.deny || []), P.ViewChannel],
      };
    });
    rules.push({ role: ['member', ...STAFF, ...TRUSTED], allow: [P.ViewChannel] });
  }
  if (!isStaffPreset) rules.push(MUTED_RULE);

  const merged = new Map();
  for (const rule of rules) {
    for (const key of [].concat(rule.role)) {
      const id = key === 'everyone' ? guild.id : ROLE_ID[key];
      const current = merged.get(id) || { id, allow: new Set(), deny: new Set() };
      (rule.allow || []).forEach((perm) => current.allow.add(perm));
      (rule.deny || []).forEach((perm) => current.deny.add(perm));
      merged.set(id, current);
    }
  }
  return [...merged.values()].map((o) => ({ id: o.id, allow: [...o.allow], deny: [...o.deny] }));
}

// ---------- Setup ----------
async function applyGuildSettings(guild) {
  if (!APPLY_GUILD_SETTINGS) return;
  try {
    await guild.setVerificationLevel(GuildVerificationLevel.Medium, AUDIT_REASON);
    await guild.setExplicitContentFilter(GuildExplicitContentFilter.AllMembers, AUDIT_REASON);
    await guild.setDefaultMessageNotifications(GuildDefaultMessageNotifications.OnlyMentions, AUDIT_REASON);
    log('⚙️', 'Pengaturan keamanan server diterapkan (verification: Medium, filter: semua member, notifikasi: hanya mention)');
  } catch (err) {
    log('⚠️', `Sebagian pengaturan server gagal diterapkan: ${err.message}`);
  }
}

async function setupRoles(guild) {
  for (const def of ROLES) {
    let role = guild.roles.cache.find((r) => r.name === def.name);
    if (role) {
      log('⏭️', `Role sudah ada: ${def.name}`);
    } else {
      role = await guild.roles.create({
        name: def.name,
        color: def.color,
        hoist: def.hoist || false,
        mentionable: false,
        permissions: def.admin ? [P.Administrator] : def.perms || [],
        reason: AUDIT_REASON,
      });
      log('✅', `Role dibuat: ${def.name}`);
      await sleep(DELAY_MS);
    }
    ROLE_ID[def.key] = role.id;
  }
}

async function createChannel(guild, category, def, overwrites) {
  const base = {
    name: channelName(def),
    parent: category.id,
    permissionOverwrites: overwrites,
    topic: def.type === 'voice' || !def.topic ? undefined : pick(def.topic),
    rateLimitPerUser: def.type === 'voice' ? undefined : def.slow || 0,
    reason: AUDIT_REASON,
  };
  try {
    return await guild.channels.create({ ...base, type: TYPE[def.type] });
  } catch (err) {
    if (def.type === 'news') {
      log('⚠️', `Fitur Community belum aktif, ${channelName(def)} dibuat sebagai channel text biasa`);
      return guild.channels.create({ ...base, type: TYPE.text });
    }
    throw err;
  }
}

async function setupStructure(guild) {
  const fresh = new Set(); // channel yang perlu diisi pesan awal

  for (const group of STRUCTURE) {
    const catName = categoryName(group);
    const catOverwrites = group.access ? buildOverwrites(guild, group.access) : [];

    let category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === catName);
    if (category) {
      log('⏭️', `Kategori sudah ada: ${catName}`);
      if (REFRESH && group.access) {
        await category.permissionOverwrites.set(catOverwrites, AUDIT_REASON);
        await sleep(DELAY_MS);
      }
    } else {
      category = await guild.channels.create({
        name: catName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: catOverwrites,
        reason: AUDIT_REASON,
      });
      log('✅', `Kategori dibuat: ${catName}`);
      await sleep(DELAY_MS);
    }
    if (group.tickets) CATEGORY_ID.tickets = category.id;

    for (const def of group.channels) {
      const name = channelName(def);
      const overwrites = buildOverwrites(guild, def.access, def.gated ?? group.gated ?? false);
      let channel = guild.channels.cache.find((c) => c.parentId === category.id && c.name === name);

      if (channel) {
        log('⏭️', `   Channel sudah ada: ${name}`);
        if (REFRESH) {
          await channel.permissionOverwrites.set(overwrites, AUDIT_REASON);
          if (def.type !== 'voice' && def.topic && typeof channel.setTopic === 'function') {
            await channel.setTopic(pick(def.topic), AUDIT_REASON);
          }
          fresh.add(def.key);
          log('🔄', `   Diperbarui: ${name}`);
          await sleep(DELAY_MS);
        }
      } else {
        channel = await createChannel(guild, category, def, overwrites);
        fresh.add(def.key);
        log('✅', `   Channel dibuat: ${name}`);
        await sleep(DELAY_MS);
      }
      CHANNEL_ID[def.key] = channel.id;
    }
  }
  return fresh;
}

async function clearBotMessages(channel, botId) {
  const messages = await channel.messages.fetch({ limit: 50 });
  for (const m of messages.filter((x) => x.author.id === botId).values()) {
    await m.delete().catch(() => {});
    await sleep(300);
  }
}

// Dikirim setelah semua channel ada, supaya mention {#key} bisa di-resolve
async function postMessages(guild, client, fresh) {
  for (const key of fresh) {
    const msg = MESSAGES[key];
    const channel = guild.channels.cache.get(CHANNEL_ID[key]);
    if (!msg || !channel || !channel.isTextBased()) continue;

    if (REFRESH) await clearBotMessages(channel, client.user.id);
    const payload = { embeds: buildEmbeds(msg) };
    if (PANELS[key]) payload.components = PANELS[key]();
    await channel.send(payload);
    log('💬', `Pesan dikirim: #${channel.name}`);
    await sleep(DELAY_MS);
  }
}

// Menulis bot-data.json: data yang dibutuhkan handler HTTP di Vercel (hanya ID + teks, tanpa rahasia)
function exportRuntimeData() {
  const ticketTypes = {};
  for (const [key, cfg] of Object.entries(TICKET_TYPES)) {
    ticketTypes[key] = { emoji: cfg.emoji, embeds: buildEmbeds(cfg).map((e) => e.toJSON()) };
  }
  const txt = {};
  for (const [key, v] of Object.entries(TXT)) txt[key] = { en: resolveMentions(v.en), id: resolveMentions(v.id) };

  const out = {
    generatedAt: new Date().toISOString(),
    langMode: LANG_MODE,
    sep: SEP,
    embedColor: EMBED_COLOR,
    maxOpenTickets: MAX_OPEN_TICKETS,
    ticketWord: pick({ en: 'ticket', id: 'tiket' }, '-'),
    roles: ROLE_ID,
    channels: CHANNEL_ID,
    ticketCategoryId: CATEGORY_ID.tickets || null,
    staffKeys: STAFF,
    pings: PING_ROLES.map((p) => ({ key: p.key, emoji: p.emoji, label: p.label })),
    buttons: {
      claim: pick({ en: 'Claim', id: 'Ambil' }, ' / '),
      close: pick({ en: 'Close', id: 'Tutup' }, ' / '),
    },
    logTitles: {
      opened: pick({ en: 'Ticket opened', id: 'Tiket dibuka' }),
      claimed: pick({ en: 'Ticket claimed', id: 'Tiket diklaim' }),
      closed: pick({ en: 'Ticket closed', id: 'Tiket ditutup' }),
    },
    txt,
    ticketTypes,
  };
  fs.writeFileSync(path.join(__dirname, 'bot-data.json'), JSON.stringify(out, null, 2));
  log('📄', 'bot-data.json ditulis (dipakai oleh api/interactions.mjs di Vercel)');
}

async function setup(client) {
  const guildId = process.env.GUILD_ID;
  if (!guildId) throw new Error('GUILD_ID belum diisi di file .env');

  const guild = await client.guilds.fetch(guildId);
  await guild.roles.fetch();
  await guild.channels.fetch();

  const me = await guild.members.fetchMe();
  if (!me.permissions.has(P.Administrator)) {
    throw new Error('Bot butuh permission Administrator. Beri di Server Settings > Roles, lalu jalankan ulang.');
  }

  log('🚀', `Mulai setup server: ${SERVER_NAME} (bahasa: ${LANG_MODE}, nama channel: ${NAME_MODE}, gerbang verifikasi: ${VERIFICATION_GATE ? 'ON' : 'OFF'})`);
  if (guild.name !== SERVER_NAME) await guild.setName(SERVER_NAME, AUDIT_REASON);
  await applyGuildSettings(guild);

  // Cegah @everyone dipakai sembarang orang
  const everyone = guild.roles.everyone;
  await everyone.setPermissions(everyone.permissions.remove(P.MentionEveryone), AUDIT_REASON);

  await setupRoles(guild);
  const fresh = await setupStructure(guild);
  await postMessages(guild, client, fresh);

  if (SET_SYSTEM_CHANNEL && CHANNEL_ID.welcome) {
    try {
      await guild.setSystemChannel(guild.channels.cache.get(CHANNEL_ID.welcome), AUDIT_REASON);
    } catch (err) {
      log('⚠️', `Gagal mengatur system channel: ${err.message}`);
    }
  }

  exportRuntimeData();

  log('🎉', 'Setup selesai! Cek server kamu, lalu pasang role Owner ke akunmu.');
  return guild;
}

// ============================================================
// INTERAKSI TOMBOL / BUTTON HANDLERS
// ============================================================
function userLang(i) {
  if (LANG_MODE !== 'both') return LANG_MODE;
  const roles = i.member?.roles?.cache;
  if (roles?.has(ROLE_ID.lang_id)) return 'id';
  if (roles?.has(ROLE_ID.lang_en)) return 'en';
  return i.locale?.startsWith('id') ? 'id' : 'en';
}

const textFor = (i, t, lang) => resolveMentions(typeof t === 'string' ? t : t[lang || userLang(i)]);
const reply = (i, t, lang) =>
  i.reply({ content: textFor(i, t, lang), flags: MessageFlags.Ephemeral });

const isStaff = (member) => STAFF.some((k) => member.roles.cache.has(ROLE_ID[k]));

async function sendTicketLog(guild, title, fields) {
  const channel = guild.channels.cache.get(CHANNEL_ID.ticketlog);
  if (!channel) return;
  const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle(title).addFields(fields).setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function handleVerify(i) {
  if (i.member.roles.cache.has(ROLE_ID.member)) return reply(i, TXT.alreadyVerified);
  await i.member.roles.add(ROLE_ID.member, 'Verified via button');
  return reply(i, TXT.verified);
}

async function handleLanguage(i, lang) {
  if (!['id', 'en'].includes(lang)) return;
  const other = lang === 'id' ? 'en' : 'id';
  await i.member.roles.remove(ROLE_ID[`lang_${other}`], 'Language switch');
  await i.member.roles.add(ROLE_ID[`lang_${lang}`], 'Language switch');
  return reply(i, TXT.langSet[lang], lang);
}

async function handlePing(i, key) {
  const ping = PING_ROLES.find((p) => p.key === key);
  if (!ping) return;
  const roleId = ROLE_ID[`ping_${key}`];
  const has = i.member.roles.cache.has(roleId);
  if (has) await i.member.roles.remove(roleId, 'Notification toggle');
  else await i.member.roles.add(roleId, 'Notification toggle');
  return reply(i, {
    en: has ? `🔕 Removed **${ping.label.en}** notifications.` : `${ping.emoji} You will now receive **${ping.label.en}** notifications.`,
    id: has ? `🔕 Notifikasi **${ping.label.id}** dinonaktifkan.` : `${ping.emoji} Kamu sekarang menerima notifikasi **${ping.label.id}**.`,
  });
}

async function handleTicketOpen(i, type) {
  const cfg = TICKET_TYPES[type];
  if (!cfg) return;
  if (!CATEGORY_ID.tickets) return reply(i, TXT.notReady);
  const guild = i.guild;

  const existing = guild.channels.cache.filter(
    (c) => c.parentId === CATEGORY_ID.tickets && c.topic?.startsWith(`ticket:${i.user.id}:`),
  );
  if (existing.size >= MAX_OPEN_TICKETS || openingTickets.has(i.user.id)) {
    const c = existing.first();
    return reply(i, {
      en: `You already have an open ticket${c ? `: ${c}` : '.'}`,
      id: `Kamu masih punya tiket yang terbuka${c ? `: ${c}` : '.'}`,
    });
  }

  openingTickets.add(i.user.id);
  try {
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const slug = i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
    const perms = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.AddReactions];
    const channel = await guild.channels.create({
      name: `${cfg.emoji}${SEP}${pick({ en: 'ticket', id: 'tiket' }, '-')}-${slug}`.toLowerCase(),
      type: ChannelType.GuildText,
      parent: CATEGORY_ID.tickets,
      topic: `ticket:${i.user.id}:${type}`,
      permissionOverwrites: [
        { id: guild.id, deny: [P.ViewChannel] },
        { id: i.user.id, allow: perms },
        ...STAFF.map((k) => ({ id: ROLE_ID[k], allow: [...perms, P.ManageMessages] })),
      ],
      reason: `Ticket (${type}) by ${i.user.tag}`,
    });

    await channel.send({
      content: `${i.user} <@&${ROLE_ID.support}>`,
      allowedMentions: { users: [i.user.id], roles: [ROLE_ID.support] },
      embeds: buildEmbeds(cfg),
      components: [
        row(
          btn('ticket:claim', pick({ en: 'Claim', id: 'Ambil' }, ' / '), ButtonStyle.Primary, '🙋'),
          btn('ticket:close', pick({ en: 'Close', id: 'Tutup' }, ' / '), ButtonStyle.Danger, '🔒'),
        ),
      ],
    });

    await sendTicketLog(guild, pick({ en: 'Ticket opened', id: 'Tiket dibuka' }), [
      { name: 'User', value: `${i.user} (${i.user.id})`, inline: true },
      { name: 'Type', value: `${cfg.emoji} ${pick(cfg.label, ' / ')}`, inline: true },
      { name: 'Channel', value: `${channel}`, inline: true },
    ]);

    const t = { en: `✅ Ticket created: ${channel}`, id: `✅ Tiket dibuat: ${channel}` };
    await i.editReply({ content: t[userLang(i)] });
  } finally {
    openingTickets.delete(i.user.id);
  }
}

async function handleTicketClaim(i) {
  const ch = i.channel;
  if (!ch?.topic?.startsWith('ticket:') || ch.parentId !== CATEGORY_ID.tickets) return;
  if (!isStaff(i.member)) return reply(i, TXT.noPermission);
  await i.reply({
    content: `🙋 ${pick({ en: `${i.user} will handle this ticket.`, id: `${i.user} akan menangani tiket ini.` }, ' / ')}`,
    allowedMentions: { parse: [] },
  });
  await sendTicketLog(i.guild, pick({ en: 'Ticket claimed', id: 'Tiket diklaim' }), [
    { name: 'Staff', value: `${i.user}`, inline: true },
    { name: 'Channel', value: `${ch}`, inline: true },
  ]);
}

async function handleTicketClose(i) {
  const ch = i.channel;
  if (!ch?.topic?.startsWith('ticket:') || ch.parentId !== CATEGORY_ID.tickets) return;
  const ownerId = ch.topic.split(':')[1];
  if (!isStaff(i.member) && i.user.id !== ownerId) return reply(i, TXT.noPermission);

  await i.reply({ content: pick(TXT.closing, ' / ') });
  await sendTicketLog(i.guild, pick({ en: 'Ticket closed', id: 'Tiket ditutup' }), [
    { name: 'Closed by', value: `${i.user}`, inline: true },
    { name: 'Owner', value: `<@${ownerId}>`, inline: true },
    { name: 'Channel', value: `#${ch.name}`, inline: true },
  ]);
  await sleep(5000);
  await ch.delete(`Ticket closed by ${i.user.tag}`);
}

async function onInteraction(i) {
  if (!i.isButton() || !i.inGuild()) return;
  const [scope, action, extra] = i.customId.split(':');
  try {
    if (scope === 'verify') return await handleVerify(i);
    if (scope === 'lang') return await handleLanguage(i, action);
    if (scope === 'ping') return await handlePing(i, action);
    if (scope === 'ticket' && action === 'open') return await handleTicketOpen(i, extra);
    if (scope === 'ticket' && action === 'claim') return await handleTicketClaim(i);
    if (scope === 'ticket' && action === 'close') return await handleTicketClose(i);
  } catch (err) {
    console.error(`❌ Interaction error (${i.customId}):`, err.message);
    const content = textFor(i, TXT.error);
    try {
      if (i.deferred && !i.replied) await i.editReply({ content });
      else if (i.replied) await i.followUp({ content, flags: MessageFlags.Ephemeral });
      else await i.reply({ content, flags: MessageFlags.Ephemeral });
    } catch {
      /* abaikan */
    }
  }
}

// ============================================================
// START
// ============================================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    await setup(client);
    if (SETUP_ONLY) {
      client.destroy();
      return;
    }
    client.on(Events.InteractionCreate, onInteraction);
    log('🟢', 'Bot online — tombol verifikasi, role, dan tiket aktif. Tekan Ctrl+C untuk berhenti. / Bot online — buttons are live. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('❌ Setup gagal / Setup failed:', err.message);
    process.exitCode = 1;
    client.destroy();
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(process.env.DISCORD_TOKEN);
