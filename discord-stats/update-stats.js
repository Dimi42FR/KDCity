// ── update-stats.js ──────────────────────────────────────────────────────
// Lit les nouveaux messages du salon "KDLog" via l'API REST Discord,
// en extrait les morts / connexions / stats de jeu, et met à jour
// data/stats.json + data/cursor.json (pointeur du dernier message traité).
//
// Ne nécessite AUCUN accès SSH/FTP au serveur Minecraft : tout part
// du salon Discord où la console est déjà relayée.

const fs = require('fs')
const path = require('path')

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
const CHANNEL_ID = process.env.LOG_CHANNEL_ID

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error('❌ DISCORD_BOT_TOKEN ou LOG_CHANNEL_ID manquant (variables d\'env / secrets).')
  process.exit(1)
}

const DATA_DIR = path.join(__dirname, 'data')
const STATS_FILE = path.join(DATA_DIR, 'stats.json')
const CURSOR_FILE = path.join(DATA_DIR, 'cursor.json')

fs.mkdirSync(DATA_DIR, { recursive: true })

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

// ── Patterns de parsing (calqués sur ceux du launcher) ──────────────────
const DEATH_NOTICE_RE = /\[Death Notice\]\s+(\w+)\s+died at/i
const JOIN_RE = /(\w+) joined the game/i
const QUIT_RE = /(\w+) left the game/i

function ensurePlayer(stats, name) {
  if (!stats.players[name]) {
    stats.players[name] = { deaths: 0, joins: 0, lastSeen: null }
  }
  return stats.players[name]
}

function parseLine(stats, content) {
  let m
  if ((m = DEATH_NOTICE_RE.exec(content))) {
    const p = ensurePlayer(stats, m[1])
    p.deaths++
    p.lastSeen = new Date().toISOString()
    stats.totalDeaths = (stats.totalDeaths || 0) + 1
    return true
  }
  if ((m = JOIN_RE.exec(content))) {
    const p = ensurePlayer(stats, m[1])
    p.joins++
    p.lastSeen = new Date().toISOString()
    return true
  }
  if ((m = QUIT_RE.exec(content))) {
    ensurePlayer(stats, m[1]).lastSeen = new Date().toISOString()
    return true
  }
  return false
}

// ── Récupère les messages Discord après un certain ID (pagination) ──────
async function fetchMessagesAfter(afterId) {
  const all = []
  let after = afterId

  for (let page = 0; page < 20; page++) { // garde-fou : 20 pages max par run (2000 messages)
    const url = new URL(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`)
    url.searchParams.set('limit', '100')
    if (after) url.searchParams.set('after', after)

    const res = await fetch(url, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    })
    if (!res.ok) {
      throw new Error(`Discord API ${res.status}: ${await res.text()}`)
    }
    const batch = await res.json()
    if (batch.length === 0) break

    // L'API renvoie du plus récent au plus ancien : on veut traiter dans l'ordre chronologique
    all.push(...batch.reverse())
    after = batch[0].id // le plus récent de ce batch (avant reverse) devient le nouveau curseur
    if (batch.length < 100) break
  }
  return all
}

async function main() {
  const stats = loadJson(STATS_FILE, { players: {}, totalDeaths: 0, updatedAt: null })
  const cursor = loadJson(CURSOR_FILE, { lastMessageId: null })

  const messages = await fetchMessagesAfter(cursor.lastMessageId)
  console.log(`📥 ${messages.length} nouveau(x) message(s) à traiter.`)

  let changed = false
  for (const msg of messages) {
    // Les logs peuvent être multi-lignes dans un seul message, ou en embed
    const text = msg.content || (msg.embeds || []).map(e => `${e.title || ''}\n${e.description || ''}`).join('\n')
    for (const line of text.split('\n')) {
      if (parseLine(stats, line)) changed = true
    }
    cursor.lastMessageId = msg.id
  }

  if (changed) stats.updatedAt = new Date().toISOString()

  saveJson(STATS_FILE, stats)
  saveJson(CURSOR_FILE, cursor)

  console.log(changed ? '✅ stats.json mis à jour.' : 'ℹ️ Rien de nouveau à enregistrer.')
}

main().catch((err) => {
  console.error('💥 Erreur :', err)
  process.exit(1)
})
