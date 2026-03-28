import { CONFIG } from '../config'

export type DiscordChannel = 'feed' | 'briefings' | 'sinais' | 'carteira' | 'acoes' | 'thread' | 'roteiro'

export interface DiscordEmbed {
  title: string
  description?: string
  color: number           // decimal: ex. 0x2ECC71 = 3066993
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  footer?: { text: string }
  timestamp?: string      // ISO 8601
}

const WEBHOOK_MAP: Record<DiscordChannel, () => string> = {
  feed: () => CONFIG.discord.webhookFeed,
  briefings: () => CONFIG.discord.webhookBriefings,
  sinais: () => CONFIG.discord.webhookSinais,
  carteira: () => CONFIG.discord.webhookCarteira,
  acoes: () => CONFIG.discord.webhookAcoes,
  thread: () => CONFIG.discord.webhookThread,
  roteiro: () => CONFIG.discord.webhookRoteiro,
}

// Paleta de cores por canal e tipo de evento
export const DISCORD_COLORS = {
  // #feed
  alertApproaching: 0x9B59B6,   // roxo — key level se aproximando
  alertTesting: 0x8E44AD,      // roxo escuro — key level sendo testado
  gexFlip: 0xAA44CC,           // lilás — GEX regime flip
  cboePCR: 0x7D3C98,           // roxo médio — PCR diário
  redditSentiment: 0x6C3483,   // roxo fundo — sentimento social

  // #briefings
  preMarket: 0x00FF88,         // verde — mantém existente
  postClose: 0xFFCC00,         // âmbar — mantém existente
  macroDigest: 0x3498DB,       // azul — novo digest macro+notícias
  macroDayBefore: 0x2980B9,    // azul escuro — aviso D-1 FOMC/CPI/NFP
  dailyScript: 0x9B59B6,       // roxo — roteiro do dia

  // #sinais
  signalProceed: 0x2ECC71,     // verde — OPERAR
  signalWait: 0xF39C12,        // âmbar — AGUARDAR
  signalAvoid: 0xE74C3C,      // vermelho — NÃO OPERAR
  croApproved: 0x27AE60,       // verde escuro — CRO APPROVED
  croRejected: 0xC0392B,       // vermelho escuro — CRO REJECTED
  croRestructure: 0xF39C12,    // âmbar — NEEDS_RESTRUCTURE
  opexAlert: 0xE67E22,        // laranja — OPEX semana

  // #carteira
  portfolioProfit: 0x00CC66,   // verde lucro — 50% atingido
  portfolioTime: 0xFFAA00,    // amarelo — ≤21 DTE
  portfolioHold: 0x44AA88,     // verde médio — MANTER

  // video script (Kasper)
  videoScript: 0x9B59B6,       // roxo — roteiro Kasper TikTok/Shorts
  roteiro: 0x9B59B6,           // roxo — identidade visual Kasper no #roteiro
} as const

/**
 * Envia um embed para um canal Discord.
 * Fire-and-forget — nunca lança exceção para o chamador.
 * Respeita limite de 4096 chars em description (split automático).
 */
export async function sendEmbed(channel: DiscordChannel, embed: DiscordEmbed): Promise<void> {
  const url = WEBHOOK_MAP[channel]()
  if (!url) return // webhook não configurado — silencioso

  try {
    const embeds = splitEmbedIfNeeded(embed)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds }),
    })
    if (!res.ok) {
      console.warn(`[Discord] #${channel} HTTP ${res.status}`)
    }
  } catch (err) {
    console.warn(`[Discord] Falha ao enviar para #${channel}:`, (err as Error).message)
  }
}

/**
 * Se description > 4000 chars, divide em múltiplos embeds quebrados em \n.
 */
function splitEmbedIfNeeded(embed: DiscordEmbed): DiscordEmbed[] {
  const MAX = 4000
  if (!embed.description || embed.description.length <= MAX) return [embed]

  const parts: string[] = []
  let current = ''
  for (const line of embed.description.split('\n')) {
    if ((current + line).length > MAX) {
      parts.push(current.trim())
      current = ''
    }
    current += line + '\n'
  }
  if (current.trim()) parts.push(current.trim())

  return parts.map((desc, i) => ({
    ...embed,
    title: i === 0 ? embed.title : `${embed.title} (cont.)`,
    description: desc,
    fields: i === 0 ? embed.fields : undefined,
    footer: i === parts.length - 1 ? embed.footer : undefined,
  }))
}
