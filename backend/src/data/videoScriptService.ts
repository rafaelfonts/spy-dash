/**
 * Video Script Service — Kasper v2
 *
 * Generates a short-form video script (TikTok/YouTube Shorts) every weekday at 09:05 ET,
 * 5 minutes after the pre-market briefing, so the briefing is ready to be referenced.
 *
 * Architecture: 2-stage generation via gpt-4o-mini
 *   Stage 1 — Narrative curation: selects hook archetype, loop type, and key narrative angle
 *   Stage 2 — Script assembly: builds the full Kasper script with metadata
 *
 * Cooldown: 1 script per trading day, backed by Redis (TTL 14h).
 * HA-safe: distributed lock prevents duplicate generation across Fly.io instances.
 */

import { marketState, newsSnapshot } from './marketState'
import { cacheGet, cacheSet, redis } from '../lib/cacheStore'
import { sendEmbed, DISCORD_COLORS } from '../lib/discordClient'
import { getAdvancedMetricsSnapshot } from './advancedMetricsState'
import { CONFIG } from '../config'
import type { PreMarketBriefing, VideoScript } from '../types/market'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_TTL_MS = 14 * 60 * 60 * 1000  // 14h — survives overnight in Redis
const MODEL = 'gpt-4o-mini'

// ---------------------------------------------------------------------------
// Hook/Loop Bank — 15 curated pairs for voice calibration
// ---------------------------------------------------------------------------

interface HookLoopPair {
  id: number
  archetype: number          // 1–6
  loopType: 'A' | 'B' | 'C'
  mood: string
  trigger: string            // market context where this pair is most effective
  hook: string
  loop: string
  bridge: string             // transition phrase loop→hook for invisible replay
  hasLevelPlaceholder: boolean  // true for Par 07 which uses $[LEVEL]
}

const HOOKS_AND_LOOPS_BANK: HookLoopPair[] = [
  {
    id: 1, archetype: 1, loopType: 'A', mood: 'skeptical',
    trigger: 'VIX falling but GEX negative; market rising with low Fear & Greed',
    hook: 'VIX is dropping. Gamma is negative. Those two don\'t usually agree.',
    loop: 'When VIX and gamma stop disagreeing — that\'s when the real move happens.',
    bridge: 'And right now? They\'re still not agreeing.',
    hasLevelPlaceholder: false,
  },
  {
    id: 2, archetype: 2, loopType: 'C', mood: 'focused',
    trigger: 'SPY within $3 of Call Wall; OPEX approaching; clear directional setup',
    hook: 'One level separates a normal day from a very fast move.',
    loop: 'The level is set. The clock is running. Watch what happens next.',
    bridge: 'So — which level is it?',
    hasLevelPlaceholder: false,
  },
  {
    id: 3, archetype: 3, loopType: 'B', mood: 'authoritative',
    trigger: 'Explaining negative/positive GEX to new audience; educational days',
    hook: 'Most traders see the chart. Market makers see the gamma.',
    loop: 'You just saw what most traders never look at. Use it.',
    bridge: 'And most traders are still only watching the chart.',
    hasLevelPlaceholder: false,
  },
  {
    id: 4, archetype: 1, loopType: 'A', mood: 'tense',
    trigger: 'SPY flat intraday with Fear & Greed at extremes (below 25 or above 75)',
    hook: 'Extreme fear. SPY barely moved. Something is being held in place.',
    loop: 'When the pin breaks — and it will — you\'ll want to know which side.',
    bridge: 'The fear is still at extreme levels. The pin is still holding.',
    hasLevelPlaceholder: false,
  },
  {
    id: 5, archetype: 5, loopType: 'A', mood: 'curious',
    trigger: 'Clear binary setup day — imminent breakout or rejection at key level',
    hook: 'Bulls or bears? The data already voted. Most traders didn\'t see it.',
    loop: 'The vote is in. The market just hasn\'t announced the result yet.',
    bridge: 'So — what exactly did the data vote for?',
    hasLevelPlaceholder: false,
  },
  {
    id: 6, archetype: 6, loopType: 'B', mood: 'calm, analytical',
    trigger: 'OPEX week; pre-OPEX pin setups; IV Rank above 30 with dominant GEX',
    hook: 'This setup has a name. It has a history. And it\'s happening right now.',
    loop: 'Same setup. Different week. Now you know what to watch for.',
    bridge: 'The setup is still active. Let\'s name it again.',
    hasLevelPlaceholder: false,
  },
  {
    id: 7, archetype: 2, loopType: 'C', mood: 'urgent',
    trigger: 'Call Wall or Put Wall being tested; Zero Gamma Level near spot',
    hook: '$[LEVEL] is where the market decides. Not suggests. Decides.',
    loop: 'Market opens in minutes. That decision is being made right now.',
    bridge: 'Watch that level. The decision is still pending.',
    hasLevelPlaceholder: true,
  },
  {
    id: 8, archetype: 4, loopType: 'A', mood: 'reflective, building',
    trigger: 'Significant overnight move after flat close; futures diverging from close',
    hook: 'Yesterday looked quiet. Overnight changed the conversation entirely.',
    loop: 'Quiet closes don\'t mean quiet opens. Remember that tomorrow.',
    bridge: 'Yesterday looked quiet too.',
    hasLevelPlaceholder: false,
  },
  {
    id: 9, archetype: 3, loopType: 'B', mood: 'teaching, confident',
    trigger: 'IV Rank crossing 30% threshold; premium selling regime opening',
    hook: 'IV Rank just crossed 30%. That number means something specific to options traders.',
    loop: 'You just learned the number that changes the strategy. Most never check it.',
    bridge: 'Most traders still haven\'t checked it.',
    hasLevelPlaceholder: false,
  },
  {
    id: 10, archetype: 1, loopType: 'B', mood: 'skeptical, sharp',
    trigger: 'Rally in negative GEX context; moves that "shouldn\'t be happening"',
    hook: 'SPY is rallying. Gamma says it shouldn\'t be this easy right now.',
    loop: 'The chart says up. Gamma says fragile. Now you\'re watching both.',
    bridge: 'And gamma still says fragile.',
    hasLevelPlaceholder: false,
  },
  {
    id: 11, archetype: 5, loopType: 'C', mood: 'focused, direct',
    trigger: 'Fed decision day; CPI/NFP release; high-impact macro event',
    hook: 'One number drops in 90 minutes. SPY is already positioning for it.',
    loop: 'Ninety minutes. One print. Watch how fast the levels get retested.',
    bridge: 'SPY is still positioning. The clock is still running.',
    hasLevelPlaceholder: false,
  },
  {
    id: 12, archetype: 6, loopType: 'A', mood: 'calm authority',
    trigger: 'VIX above 20 with IV Rank in premium selling zone; classic Iron Condor setup',
    hook: 'High IV. Negative gamma. Spot at Max Pain. This pattern has a playbook.',
    loop: 'The pattern is set. The playbook exists. The question is who uses it.',
    bridge: 'The pattern is still set. The playbook is still there.',
    hasLevelPlaceholder: false,
  },
  {
    id: 13, archetype: 2, loopType: 'B', mood: 'direct, no-nonsense',
    trigger: 'Zero Gamma Level being defended; Flip Point as intraday support/resistance',
    hook: 'Zero Gamma is the line where market makers stop absorbing. Cross it and see.',
    loop: 'Most traders don\'t know this line exists. Now you can\'t unsee it.',
    bridge: 'You can\'t unsee it. And the line is still right there.',
    hasLevelPlaceholder: false,
  },
  {
    id: 14, archetype: 4, loopType: 'C', mood: 'energized',
    trigger: 'Opening gap after flat close; futures diverging >0.5% from prior close',
    hook: 'Closed flat. Opened with a gap. The overnight narrative rewrote the day.',
    loop: 'Gap is already priced. What happens at the open is the real story.',
    bridge: 'Here\'s how the overnight narrative started.',
    hasLevelPlaceholder: false,
  },
  {
    id: 15, archetype: 3, loopType: 'A', mood: 'measured, revealing',
    trigger: 'Any day — generic fallback when context has no clear tension',
    hook: 'The market never moves randomly. There\'s always a structure. Here\'s today\'s.',
    loop: 'Structure changes daily. The principle doesn\'t. Come back tomorrow.',
    bridge: 'But understand today\'s structure first.',
    hasLevelPlaceholder: false,
  },
  // --- New pairs added in v2.1 ---
  {
    id: 16, archetype: 2, loopType: 'C', mood: 'urgent',
    trigger: 'SPY at or near major round number ($500, $550, $560, $580, $600) with high OI concentration',
    hook: 'Round numbers aren\'t random. Options positioning makes them magnetic.',
    loop: 'The magnet is active. Positioning is live. Watch what pulls harder.',
    bridge: 'The round number is still right there — and so is the positioning.',
    hasLevelPlaceholder: false,
  },
  {
    id: 17, archetype: 1, loopType: 'A', mood: 'skeptical',
    trigger: 'Unusual call/put ratio diverging from price direction; options flow contradicting trend',
    hook: 'Options flow is pointing one way. Price is moving the other. One of them is wrong.',
    loop: 'Flow doesn\'t lie. Price catches up eventually. Which side are you on?',
    bridge: 'Flow is still pointing the same direction.',
    hasLevelPlaceholder: false,
  },
  {
    id: 18, archetype: 3, loopType: 'B', mood: 'teaching',
    trigger: 'DAN (Delta-Adjusted Notional) heavily skewed call or put side; unusual notional imbalance',
    hook: 'Dollar-weighted options exposure tells a different story than volume alone.',
    loop: 'Now you read options flow the way institutions do. Most traders never get here.',
    bridge: 'And the dollar-weighted story is still telling the same thing.',
    hasLevelPlaceholder: false,
  },
  {
    id: 19, archetype: 5, loopType: 'C', mood: 'decisive',
    trigger: 'Fed decision day, CPI, or NFP with GEX regime confirming or contradicting macro consensus',
    hook: 'The macro print and the gamma structure are pointing in opposite directions today.',
    loop: 'One of those signals is going to be wrong by end of day. Watch which one blinks.',
    bridge: 'The print is out. The gamma structure hasn\'t changed yet.',
    hasLevelPlaceholder: false,
  },
  {
    id: 20, archetype: 6, loopType: 'A', mood: 'analytical',
    trigger: 'OPEX week with elevated IV Rank and strong Max Pain gravity; classic pin setup',
    hook: 'Max Pain. High IV. OPEX week. The three conditions that make price act predictably.',
    loop: 'Three conditions. One pattern. Not everyone knows when all three align.',
    bridge: 'And all three are still aligned right now.',
    hasLevelPlaceholder: false,
  },
]

// ---------------------------------------------------------------------------
// Pair selection — chooses 3 most relevant pairs for the day's context
// ---------------------------------------------------------------------------

interface PairSelectionContext {
  gexRegime: string | null
  vix: number | null
  ivRank: number | null
  isOpex: boolean
  hasPostCloseYesterday: boolean
  hasMacroEvent: boolean
  hasOvernightGap: boolean
}

function selectRelevantPairs(ctx: PairSelectionContext): HookLoopPair[] {
  // Build scored list: higher score = more relevant
  const scored = HOOKS_AND_LOOPS_BANK.map((pair) => {
    let score = 0

    // OPEX week → prefer archetypes 6, 2 and ids 06, 12, 07
    if (ctx.isOpex) {
      if (pair.id === 6 || pair.id === 12) score += 3
      if (pair.id === 7) score += 2
    }

    // High-impact macro event → prefer archetype 5 (ids 05, 11)
    if (ctx.hasMacroEvent) {
      if (pair.archetype === 5) score += 3
    }

    // Overnight gap → prefer archetypes 4 (ids 08, 14) or 2
    if (ctx.hasOvernightGap) {
      if (pair.archetype === 4) score += 3
      if (pair.id === 2 || pair.id === 7) score += 1
    }

    // VIX spike > 25 → prefer archetypes 1 (ids 01, 04, 10) or 4
    if (ctx.vix != null && ctx.vix > 25) {
      if (pair.archetype === 1) score += 2
      if (pair.archetype === 4) score += 1
    }

    // High IV Rank > 30% → prefer ids 09, 12
    if (ctx.ivRank != null && ctx.ivRank > 30) {
      if (pair.id === 9 || pair.id === 12) score += 2
    }

    // GEX negative → prefer ids 01, 04, 10 (contradiction with price)
    if (ctx.gexRegime === 'negative') {
      if (pair.id === 1 || pair.id === 10) score += 2
      if (pair.id === 4) score += 1
    }

    // Archetype 4 only if post-close yesterday is available
    if (pair.archetype === 4 && !ctx.hasPostCloseYesterday) {
      score -= 10  // effectively excluded
    }

    // Low volatility fallback → boost ids 15, 09
    if (ctx.vix != null && ctx.vix < 15 && ctx.ivRank != null && ctx.ivRank < 20) {
      if (pair.id === 15) score += 2
      if (pair.id === 9) score += 1
    }

    return { pair, score }
  })

  // Sort by score desc, take top 3
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 3).map((s) => s.pair)
}

// ---------------------------------------------------------------------------
// Pair formatter — renders pairs as prompt text, resolving $[LEVEL] placeholder
// ---------------------------------------------------------------------------

function formatPairsForPrompt(pairs: HookLoopPair[], keyLevel: number | null): string {
  const lines: string[] = [
    'STYLE REFERENCE — 3 curated hook/loop pairs from our bank.',
    'Use these for VOICE CALIBRATION ONLY. Do NOT copy verbatim. Adapt to today\'s specific data.',
    '',
  ]

  for (const pair of pairs) {
    const levelStr = keyLevel != null ? `$${keyLevel.toFixed(2)}` : '$[KEY_LEVEL]'
    const hook = pair.hasLevelPlaceholder ? pair.hook.replace('$[LEVEL]', levelStr) : pair.hook
    const loop = pair.hasLevelPlaceholder ? pair.loop.replace('$[LEVEL]', levelStr) : pair.loop

    lines.push(`Pair ${pair.id} [Archetype ${pair.archetype} / Loop ${pair.loopType} / ${pair.mood}]:`)
    lines.push(`  Hook: "${hook}"`)
    lines.push(`  Loop: "${loop}"`)
    lines.push(`  Bridge: "${pair.bridge}"`)
    lines.push('')
  }

  lines.push('PAIR SELECTION RULES (apply when choosing hook_archetype and loop_type):')
  lines.push('- OPEX week → prefer archetype 6 or 2')
  lines.push('- High-impact macro event today → prefer archetype 5')
  lines.push('- Overnight gap (futures diverging >0.5% from prior close) → prefer archetype 4 or 2')
  lines.push('- VIX spike >25 → prefer archetype 1 or 4')
  lines.push('- IV Rank >30% → prefer archetype 3 (IV explanation) or archetype 6 (pattern)')
  lines.push('- GEX negative with price rising → prefer archetype 1 (contradiction)')
  lines.push('- Low volatility / no clear tension → prefer archetype 3 or use style of Pair 15')
  lines.push('- Archetype 4 requires post-market data from yesterday')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let todaysScript: VideoScript | null = null

export function getTodaysVideoScript(): VideoScript | null {
  return todaysScript
}

// ---------------------------------------------------------------------------
// Bootstrap: restore from Redis on server start
// ---------------------------------------------------------------------------

export async function restoreVideoScriptFromCache(): Promise<void> {
  const today = getTodayDateET()
  const cached = await cacheGet<VideoScript>(`cache:video_script:${today}`)
  if (cached) {
    todaysScript = cached
    console.log(`[VideoScript] Roteiro Kasper restaurado do Redis (${today})`)
  }
}

// ---------------------------------------------------------------------------
// Scheduler — checks every 60 s whether it's time to generate
// ---------------------------------------------------------------------------

export function startVideoScriptScheduler(): void {
  setInterval(() => {
    const et = getETNow()
    const dow = et.getDay()
    if (dow === 0 || dow === 6) return

    const h = et.getHours()
    const m = et.getMinutes()

    if (h === 9 && m === 5) {
      generateVideoScript().catch((err) =>
        console.error('[VideoScript] Scheduler: erro ao gerar roteiro:', err),
      )
    }
  }, 60_000)

  console.log('[VideoScript] Scheduler iniciado (verificação a cada 60s, dispara 09:05 ET)')
}

// ---------------------------------------------------------------------------
// Core generator
// ---------------------------------------------------------------------------

async function generateVideoScript(): Promise<void> {
  const today = getTodayDateET()
  const cacheKey = `cache:video_script:${today}`

  // Distributed lock — prevents duplicate generation across HA instances
  const lockKey = `lock:video_script:${today}`
  const acquired = await redis.set(lockKey, '1', 'EX', 300, 'NX')
  if (!acquired) {
    console.log('[VideoScript] Lock não adquirido — outra instância está gerando')
    return
  }

  // Cooldown: skip if already generated today
  const existing = await cacheGet<VideoScript>(cacheKey)
  if (existing) {
    console.log(`[VideoScript] Roteiro já existe para ${today} — pulando geração`)
    if (!todaysScript) todaysScript = existing
    return
  }

  console.log('[VideoScript] Gerando roteiro Kasper v2...')

  try {
    // -----------------------------------------------------------------------
    // Collect context
    // -----------------------------------------------------------------------

    const preMarket = await cacheGet<PreMarketBriefing>(`cache:premarket_briefing:${today}`)
    const yesterday = getYesterdayDateET()
    const postCloseYesterday = await cacheGet<PreMarketBriefing>(`cache:postclose_briefing:${yesterday}`)

    const advancedSnapshot = getAdvancedMetricsSnapshot()
    const gexDynamic = advancedSnapshot?.gexDynamic ?? []

    // Find dominant GEX entry (ALL bucket or first)
    const allEntry = gexDynamic.find((e) => e.label === 'ALL') ?? gexDynamic[0]
    const gex = allEntry?.gex

    const spyPrice = marketState.spy.last ?? marketState.spy.prevClose
    const vixValue = marketState.vix.last
    const ivRank = marketState.ivRank.value

    // Determine regime tags for hashtag injection
    const opex = isOpexWeek()
    const regimeTags = buildRegimeTags({
      gexRegime: gex?.regime,
      vix: vixValue,
      ivRank,
      isOpex: opex,
    })

    // Select 3 most relevant hook/loop pairs for style calibration
    const hasMacroEvent = newsSnapshot.macroEvents.some((e) => {
      const today = getTodayDateET()
      const dateStr = e.time?.split(' ')[0] ?? e.time?.split('T')[0] ?? ''
      return dateStr === today && e.impact === 'high'
    })
    const stylePairs = selectRelevantPairs({
      gexRegime: gex?.regime ?? null,
      vix: vixValue,
      ivRank,
      isOpex: opex,
      hasPostCloseYesterday: postCloseYesterday != null,
      hasMacroEvent,
      hasOvernightGap: false, // no reliable pre-market gap signal at 09:05 ET yet
    })

    // Key level for Par 07 $[LEVEL] substitution: Flip Point > Call Wall > Max Pain
    const keyLevel = gex?.flipPoint ?? gex?.callWall ?? gex?.maxPain?.maxPainStrike ?? null

    // -----------------------------------------------------------------------
    // Stage 1 — Narrative curation
    // -----------------------------------------------------------------------

    const stage1Input = buildStage1Input({
      preMarketMarkdown: preMarket?.markdown ?? null,
      postCloseYesterdayMarkdown: postCloseYesterday?.markdown ?? null,
      fearGreedScore: newsSnapshot.fearGreed?.score ?? null,
      fearGreedLabel: newsSnapshot.fearGreed?.label ?? null,
      topHeadlines: newsSnapshot.headlines.slice(0, 3).map((h) => h.title ?? h.summary ?? '').filter(Boolean),
      spyPrice,
      vixValue,
      ivRank,
      gexRegime: gex?.regime ?? null,
      flipPoint: gex?.flipPoint ?? null,
      callWall: gex?.callWall ?? null,
      putWall: gex?.putWall ?? null,
      maxPain: gex?.maxPain?.maxPainStrike ?? null,
    })

    const curation = await callGPTMini(buildStage1System(stylePairs, keyLevel), stage1Input)
    const curationData = parseJSON<Stage1Output>(curation)

    if (!curationData) {
      throw new Error('Stage 1 falhou: JSON inválido retornado pelo modelo')
    }

    console.log(`[VideoScript] Stage 1 concluído — arquétipo ${curationData.hook_archetype}, loop ${curationData.loop_type}`)

    // -----------------------------------------------------------------------
    // Stage 2 — Script assembly
    // -----------------------------------------------------------------------

    const stage2Input = buildStage2Input({
      curation: curationData,
      spyPrice,
      vixValue,
      ivRank,
      gexRegime: gex?.regime ?? null,
      flipPoint: gex?.flipPoint ?? null,
      callWall: gex?.callWall ?? null,
      putWall: gex?.putWall ?? null,
      maxPain: gex?.maxPain?.maxPainStrike ?? null,
      regimeTags,
      fearGreedScore: newsSnapshot.fearGreed?.score ?? null,
      fearGreedLabel: newsSnapshot.fearGreed?.label ?? null,
      topHeadlines: newsSnapshot.headlines.slice(0, 3).map((h) => h.title ?? h.summary ?? '').filter(Boolean),
    })

    const scriptRaw = await callGPTMini(buildStage2System(curationData), stage2Input)
    const scriptData = parseJSON<Stage2Output>(scriptRaw)

    if (!scriptData) {
      throw new Error('Stage 2 falhou: JSON inválido retornado pelo modelo')
    }

    const script: VideoScript = {
      generatedAt: new Date().toISOString(),
      narrativeAngle: curationData.narrative_angle,
      hookArchetype: curationData.hook_archetype,
      loopType: curationData.loop_type,
      hook: scriptData.hook,
      kasperBullets: scriptData.kasper_bullets,
      voiceover: scriptData.voiceover,
      cartela: {
        spyPrice: scriptData.cartela.spy_price,
        vixLevel: scriptData.cartela.vix_level,
        gexRegime: scriptData.cartela.gex_regime,
        keyLevel: scriptData.cartela.key_level,
      },
      loop: scriptData.loop,
      bridge: curationData.selected_bridge,
      cta: scriptData.cta,
      firstPinnedComment: curationData.first_pinned_comment ?? undefined,
      metadata: {
        youtubeTitle: scriptData.metadata.youtube_title,
        youtubeDescription: scriptData.metadata.youtube_description,
        youtubeTags: scriptData.metadata.youtube_tags,
        tiktokCaption: scriptData.metadata.tiktok_caption,
      },
    }

    // -----------------------------------------------------------------------
    // Persist and broadcast
    // -----------------------------------------------------------------------

    await cacheSet(cacheKey, script, SCRIPT_TTL_MS, 'video-script')
    todaysScript = script

    // Discord — fire-and-forget (#roteiro)
    await sendEmbed('roteiro', buildDiscordEmbed(script))

    console.log('[VideoScript] Roteiro Kasper gerado com sucesso')
  } catch (err) {
    console.error('[VideoScript] Erro ao gerar roteiro:', err)
    // Do not rethrow — scheduler must not break the process
  }
}

// ---------------------------------------------------------------------------
// GPT-4o-mini caller
// ---------------------------------------------------------------------------

async function callGPTMini(system: string, user: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }

  return json.choices?.[0]?.message?.content ?? ''
}

// ---------------------------------------------------------------------------
// Stage 1 system prompt — Narrative Curation
// ---------------------------------------------------------------------------

function buildStage1System(stylePairs: HookLoopPair[], keyLevel: number | null): string {
  const styleSection = formatPairsForPrompt(stylePairs, keyLevel)
  return buildStage1SystemBase(styleSection)
}

function buildStage1SystemBase(styleSection: string): string {
  return `You are a financial content strategist for Kasper, an AI market analyst on TikTok and YouTube Shorts.

Your job is NOT to write the video. Your job is to identify the STORY of the day.

You receive three inputs:
1. Pre-market briefing (today)
2. Post-market summary from yesterday (may be null)
3. Current macro/news digest

OUTPUT: A JSON object with the narrative strategy for today's video.

Rules for narrative_angle:
- It must be a SINGLE TENSION — one sentence that captures what makes today interesting
- It cannot be "the market is [up/down/sideways]" — it must identify WHY it's interesting
- Good examples:
  "Fear is extreme but price refuses to move — the divergence has to resolve"
  "Gamma is flipping zones today — whoever controls $680 controls the week"
  "Yesterday's quiet close masked a setup that looks very different this morning"

Rules for hook_archetype selection (1–6):
1 = Contradiction of Data (two signals pointing opposite directions)
2 = Threshold Alert (a critical level being tested)
3 = Insider Knowledge (something most traders don't know how to read)
4 = Yesterday vs Today (post-market vs pre-market narrative shift)
5 = High Stakes Question (a binary outcome the market will decide today)
6 = Recognizable Pattern (setup echoes a known historical configuration)
- Choose the archetype that best frames the narrative_angle
- Prefer archetypes that create information asymmetry
- Use Archetype 4 only if post-market data is available

Rules for loop_type selection (A/B/C):
A = Open Resolution — for hooks of contradiction or question; doesn't resolve, deepens
B = Identity Reinforcement — for insider knowledge hooks; viewer becomes "someone who knows"
C = Time Urgency — for setups with clear intraday catalyst; creates legitimate FOMO
- Pair: Archetypes 1,5 → A; Archetypes 3,4 → B; Archetypes 2,6 → C

Rules for hook_candidates and loop_candidates:
- Generate exactly 3 options each
- Each under 15 words
- Hooks must NOT start with "Today"
- Loops must NOT repeat hook verbatim — create an echo, not a copy

Rules for bridge_candidates:
- Generate exactly 3 options matching the bridge rules for the selected loop_type
- Loop Type A: confirm the tension persists OR ask the question the hook will answer
- Loop Type B: offer a second learning layer or a self-assessment challenge
- Loop Type C: escalate the consequence or make urgency personal ("you", "your side")
- Max 8 words. Must NOT contain the words "replay", "loop", or "rewatch"
- Must sound like Kasper's thought or a natural continuation — never a replay announcement

Rules for selected_hook, selected_loop, and selected_bridge:
- Select the best option from each set of candidates
- selected_hook must create genuine curiosity without being clickbait
- selected_loop must feel like a satisfying echo
- selected_bridge must connect seamlessly from loop back to hook

Rules for first_pinned_comment:
- ≤200 characters total
- A provocative question or bold statement using REAL data from today
- Format: [single emoji] [data-driven question OR binary choice] [2–3 hashtags]
- Must force a YES/NO response OR a choice between two positions
- Good: "🤔 SPY at the Flip Point with VIX still elevated — does the level hold or break today? 👇 #SPY #OptionsFlow #GEX"
- Bad: "What do you think about today's market? #SPY #Options" (too generic, no data)
- Use specific numbers (SPY price, VIX level, IV Rank, key level) to anchor the question

Return ONLY valid JSON. No preamble. No markdown. Schema:
{
  "narrative_angle": "string",
  "hook_archetype": 1,
  "loop_type": "A",
  "hook_candidates": ["string","string","string"],
  "loop_candidates": ["string","string","string"],
  "bridge_candidates": ["string","string","string"],
  "key_tension": "string",
  "key_levels": ["$680","$670"],
  "market_mood": "bullish|bearish|coiling|uncertain",
  "selected_hook": "string",
  "selected_loop": "string",
  "selected_bridge": "string",
  "first_pinned_comment": "string"
}

---

${styleSection}`
}

// ---------------------------------------------------------------------------
// Stage 2 system prompt builder — Script Assembly (Kasper v2)
// ---------------------------------------------------------------------------

function buildStage2System(curation: Stage1Output): string {
  return `You are Kasper, an AI market analyst. Never say "as an AI".

Your voice: confident, slightly fast-paced, analytically sharp.
Anchor phrases (use 1 per video, rotating): "Here's what the data says…" | "Watch this level." | "The market doesn't lie." | "Most traders miss this." | "This is the setup."

TASK: Build the full video script around the narrative angle and selected hook/loop from Stage 1.
Structure is fixed. Voice is not.

HOOK RULES:
- Use the selected_hook from Stage 1 EXACTLY. Do NOT rewrite it.
- Max 15 words. Never starts with "Today".

KASPER BULLETS [archetype ${curation.hook_archetype}] RULES:
- Exactly 3 bullets, ≤12 words each
${getBulletRules(curation.hook_archetype)}
- Always ends with [pause 1s]

VOICEOVER RULES:
- 3 short paragraphs, ≤90 words total
- Paragraph 1: Technical context (GEX, regime, key level)
- Paragraph 2: Day catalyst (macro, news, relevant sector)
- Paragraph 3: Operational implication (point to the critical level — no direct trade signal)
- Tone: analytical documentary, not hype

CARTELA RULES:
- SPY last price / VIX level / GEX regime label / Single most important level today
- Key Level priority: Flip Point > Call Wall > Max Pain > Put Wall

SEAMLESS LOOP RULES:
- Use the selected_loop from Stage 1 EXACTLY. Do NOT rewrite it.
- Max 15 words. Must NOT repeat hook verbatim.
- The loop MUST be grammatically completable by the hook: imagine the hook is the opening sentence of a book and the loop is the closing sentence — the reader should naturally want to return to the beginning.
- Loop Type A: deepen the tension from the hook. "What happens next?" — the hook answers.
- Loop Type B: reinforce the identity the hook established. The viewer feels more informed watching again.
- Loop Type C: restore time urgency. The viewer feels they are watching for the first time again.
- The bridge (selected_bridge from Stage 1) is spoken AFTER the loop, BEFORE the hook plays again. It must flow as a natural continuation — never mention "again", "replay", or "rewatch".
- Self-test: read loop → bridge → hook aloud. It must sound like a single unbroken thought.

CTA RULES:
- 1 question, ≤20 words, uses real data from today
- Question type by archetype:
  - Archetypes 1,5: "Will X or Y?" (binary outcome)
  - Archetypes 2,6: "Can SPY [action] [level]?" (price action)
  - Archetypes 3,4: "What does [data] tell you about [outcome]?" (insight)

METADATA RULES:
- youtubeTitle: ≤100 chars, format "[real number] — [hook phrase or question] | [date context] #Shorts"
  Bad: "SPY Analysis March 24 — Market Overview #Shorts"
  Good: "VIX 21 and SPY Pinned at $670 — Something Has to Break | Mar 24 #Shorts"
- youtubeDescription: 2 paragraphs (context + critical level) + call to action placeholder "{{UTM_LINK}}"
- youtubeTags: exactly 15 tags — 3 identity, 3 regime, 3 technical level, 3 audience, 3 macro context
- tiktokCaption: ≤150 chars, format "[contextual emoji] [short hook phrase] [critical level] [3 hashtags]"
  Emoji guide: 🧲=pin/magnet, ⚡=breakout, 🎯=resistance, 📈📉=directional move, 🔥=volatility
  Bad: "SPY analysis today #SPY #OptionsTrading"
  Good: "🧲 Gamma pinning SPY at $670 — $680 is the wall that matters #SPY #OptionsFlow #GEX"

Return ONLY valid JSON. No preamble. No markdown. Schema:
{
  "hook": "string",
  "kasper_bullets": ["string","string","string"],
  "voiceover": {
    "paragraph1": "string",
    "paragraph2": "string",
    "paragraph3": "string"
  },
  "cartela": {
    "spy_price": "string",
    "vix_level": "string",
    "gex_regime": "string",
    "key_level": "string"
  },
  "loop": "string",
  "cta": "string",
  "metadata": {
    "youtube_title": "string",
    "youtube_description": "string",
    "youtube_tags": ["string"],
    "tiktok_caption": "string"
  }
}`
}

function getBulletRules(archetype: number): string {
  const rules: Record<number, string> = {
    1: '- Follow Archetype 1 (Contradiction): bullet 1 = data point, bullet 2 = opposing signal, bullet 3 = implication',
    2: '- Follow Archetype 2 (Threshold): bullet 1 = current price vs level, bullet 2 = what happens above, bullet 3 = what happens below',
    3: '- Follow Archetype 3 (Insider): bullet 1 = the concept, bullet 2 = what it means today, bullet 3 = the actionable insight',
    4: '- Follow Archetype 4 (Yesterday vs Today): bullet 1 = what happened, bullet 2 = what changed overnight, bullet 3 = the implication',
    5: '- Follow Archetype 5 (High Stakes): bullet 1 = the binary question, bullet 2 = data in favor of yes, bullet 3 = data in favor of no',
    6: '- Follow Archetype 6 (Pattern): bullet 1 = the pattern, bullet 2 = historical context, bullet 3 = today\'s version',
  }
  return rules[archetype] ?? rules[1]
}

// ---------------------------------------------------------------------------
// Input builders
// ---------------------------------------------------------------------------

interface Stage1InputData {
  preMarketMarkdown: string | null
  postCloseYesterdayMarkdown: string | null
  fearGreedScore: number | null
  fearGreedLabel: string | null
  topHeadlines: string[]
  spyPrice: number | null
  vixValue: number | null
  ivRank: number | null
  gexRegime: string | null
  flipPoint: number | null
  callWall: number | null
  putWall: number | null
  maxPain: number | null
}

function buildStage1Input(d: Stage1InputData): string {
  const lines: string[] = ['=== STAGE 1: NARRATIVE CURATION INPUT ===', '']

  lines.push('### Pre-Market Briefing (Today)')
  lines.push(d.preMarketMarkdown
    ? d.preMarketMarkdown.slice(0, 1500)
    : '(not yet available)')
  lines.push('')

  lines.push('### Post-Market Summary (Yesterday)')
  if (d.postCloseYesterdayMarkdown) {
    lines.push(d.postCloseYesterdayMarkdown.slice(0, 600))
  } else {
    lines.push('(not available — skip Archetype 4)')
  }
  lines.push('')

  lines.push('### Macro/News Digest')
  if (d.fearGreedScore != null) {
    lines.push(`- Fear & Greed: ${d.fearGreedScore} (${d.fearGreedLabel ?? 'n/a'})`)
  }
  if (d.topHeadlines.length > 0) {
    lines.push('- Top Headlines:')
    d.topHeadlines.forEach((h) => lines.push(`  • ${h}`))
  }
  lines.push('')

  lines.push('### Key Market Data (for level extraction)')
  if (d.spyPrice != null) lines.push(`- SPY: $${d.spyPrice.toFixed(2)}`)
  if (d.vixValue != null) lines.push(`- VIX: ${d.vixValue.toFixed(2)}`)
  if (d.ivRank != null) lines.push(`- IV Rank: ${d.ivRank.toFixed(1)}%`)
  if (d.gexRegime) lines.push(`- GEX Regime: ${d.gexRegime}`)
  if (d.flipPoint != null) lines.push(`- GEX Flip Point: $${d.flipPoint.toFixed(2)}`)
  if (d.callWall != null) lines.push(`- Call Wall: $${d.callWall.toFixed(2)}`)
  if (d.putWall != null) lines.push(`- Put Wall: $${d.putWall.toFixed(2)}`)
  if (d.maxPain != null) lines.push(`- Max Pain: $${d.maxPain.toFixed(2)}`)

  return lines.join('\n')
}

interface Stage2InputData {
  curation: Stage1Output
  spyPrice: number | null
  vixValue: number | null
  ivRank: number | null
  gexRegime: string | null
  flipPoint: number | null
  callWall: number | null
  putWall: number | null
  maxPain: number | null
  regimeTags: string[]
  fearGreedScore: number | null
  fearGreedLabel: string | null
  topHeadlines: string[]
}

function buildStage2Input(d: Stage2InputData): string {
  const lines: string[] = ['=== STAGE 2: SCRIPT ASSEMBLY INPUT ===', '']

  lines.push('### Stage 1 Curation Output')
  lines.push(JSON.stringify({
    narrative_angle: d.curation.narrative_angle,
    hook_archetype: d.curation.hook_archetype,
    loop_type: d.curation.loop_type,
    key_tension: d.curation.key_tension,
    key_levels: d.curation.key_levels,
    market_mood: d.curation.market_mood,
    selected_hook: d.curation.selected_hook,
    selected_loop: d.curation.selected_loop,
  }, null, 2))
  lines.push('')

  lines.push('### Raw Market Data (for script & metadata)')
  if (d.spyPrice != null) lines.push(`- SPY Last: $${d.spyPrice.toFixed(2)}`)
  if (d.vixValue != null) lines.push(`- VIX: ${d.vixValue.toFixed(2)}`)
  if (d.ivRank != null) lines.push(`- IV Rank: ${d.ivRank.toFixed(1)}%`)
  if (d.gexRegime) lines.push(`- GEX Regime: ${d.gexRegime.toUpperCase()}`)
  if (d.flipPoint != null) lines.push(`- Flip Point: $${d.flipPoint.toFixed(2)}`)
  if (d.callWall != null) lines.push(`- Call Wall: $${d.callWall.toFixed(2)}`)
  if (d.putWall != null) lines.push(`- Put Wall: $${d.putWall.toFixed(2)}`)
  if (d.maxPain != null) lines.push(`- Max Pain: $${d.maxPain.toFixed(2)}`)
  if (d.fearGreedScore != null) lines.push(`- Fear & Greed: ${d.fearGreedScore} (${d.fearGreedLabel ?? 'n/a'})`)
  lines.push('')

  lines.push('### Regime-Specific Hashtags (inject 3–6 of these in youtubeTags)')
  lines.push(d.regimeTags.join(', '))
  lines.push('')

  if (d.topHeadlines.length > 0) {
    lines.push('### Top Headlines (for voiceover paragraph 2)')
    d.topHeadlines.forEach((h) => lines.push(`- ${h}`))
  }

  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
  lines.push('')
  lines.push(`### Date Context: ${today}`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Regime tags builder
// ---------------------------------------------------------------------------

interface RegimeTagsInput {
  gexRegime?: string
  vix: number | null
  ivRank: number | null
  isOpex: boolean
}

function buildRegimeTags(d: RegimeTagsInput): string[] {
  const tags: string[] = []

  if (d.gexRegime === 'positive') {
    tags.push('#PositiveGamma', '#GammaPinning', '#MarketMakers')
  } else if (d.gexRegime === 'negative') {
    tags.push('#NegativeGamma', '#VolatilityAmplified', '#GammaExposure')
  }

  if (d.isOpex) {
    tags.push('#OPEX', '#OpexWeek', '#ExpirationWeek')
  }

  if (d.ivRank != null && d.ivRank > 30) {
    tags.push('#HighIV', '#PremiumSelling', '#IronCondor')
  } else if (d.ivRank != null && d.ivRank < 15) {
    tags.push('#LowIV', '#VolatilityLow', '#IVRank')
  }

  if (d.vix != null && d.vix > 20) {
    tags.push('#VIX', '#MarketFear', '#VolatilitySpike')
  } else if (d.vix != null && d.vix < 15) {
    tags.push('#LowVix', '#MarketCalm', '#VIXCrush')
  }

  return tags
}

// ---------------------------------------------------------------------------
// Discord embed builder
// ---------------------------------------------------------------------------

function buildDiscordEmbed(script: VideoScript) {
  const dateStr = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit' })
  const timeStr = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
  const archetypeName = getArchetypeName(script.hookArchetype)
  const keyLevelStr = script.cartela.keyLevel ? ` | 🎯 Key: ${script.cartela.keyLevel}` : ''
  const hashtags = script.metadata.youtubeTags.slice(0, 8).map((t) => t.startsWith('#') ? t : `#${t}`).join(' ')

  // Cartela 1: market snapshot
  const cartela1Text = `SPY ${script.cartela.spyPrice} | VIX ${script.cartela.vixLevel} | GEX ${script.cartela.gexRegime}${keyLevelStr}`
  // Cartela 2: bullets 1+2
  const cartela2Text = `${script.kasperBullets[0]}\n${script.kasperBullets[1]}`
  // Cartela 3: bullet 3 + key level highlight
  const cartela3Text = script.cartela.keyLevel
    ? `${script.kasperBullets[2]}\n🎯 ${script.cartela.keyLevel}`
    : script.kasperBullets[2]

  const lines = [
    `📐 **Arquétipo:** ${archetypeName} (${script.hookArchetype}) · **Loop:** ${script.loopType} · *"${script.narrativeAngle}"*`,
    '',
    '─────────────────────────────────',
    '**📋 METADADOS**',
    `▸ **YouTube:** \`${script.metadata.youtubeTitle}\``,
    `▸ **TikTok:** ${script.metadata.tiktokCaption}`,
    `▸ **Hashtags:** ${hashtags}`,
  ]

  if (script.firstPinnedComment) {
    lines.push(`▸ **📌 Primeiro Comentário:** ${script.firstPinnedComment}`)
  }

  lines.push(
    '',
    '─────────────────────────────────',
    '**🎬 BLOCO 1 — INTRO (Casca + Hook)**',
    `*Vídeo genérico Kasper 1*`,
    `> "${script.hook}"`,
    `⏱ est. 3s`,
    '',
    '─────────────────────────────────',
    '**📊 BLOCO 2 — CARTELAS (Miolo + Bridge)**',
    '',
    `**Cartela 1** *(tela):* \`${cartela1Text}\``,
    `*Voiceover:* ${script.voiceover.paragraph1}`,
    '',
    `**Cartela 2** *(tela):*`,
    `\`${cartela2Text}\``,
    `*Voiceover:* ${script.voiceover.paragraph2}`,
    '',
    `**Cartela 3** *(tela):*`,
    `\`${cartela3Text}\``,
    `*Voiceover:* ${script.voiceover.paragraph3}`,
    '',
    '─────────────────────────────────',
    '**🔚 BLOCO 3 — OUTRO (Casca + CTA + Loop)**',
    `*Vídeo genérico Kasper 2*`,
    `❓ **CTA:** ${script.cta}`,
    `🔄 **Loop:** > "${script.loop}"`,
    `🌉 **Bridge:** > *"${script.bridge}"*`,
    `⏱ est. 5s`,
    '',
    '─────────────────────────────────',
    `⏱ **Duração Total Estimada:** ~30s`,
  )

  return {
    title: `🎬 Roteiro Kasper — ${dateStr} — ${archetypeName} / Loop ${script.loopType}`,
    description: lines.join('\n'),
    color: DISCORD_COLORS.roteiro,
    footer: { text: `Gerado via gpt-4o-mini às ${timeStr}` },
    timestamp: new Date().toISOString(),
  }
}

function getArchetypeName(n: number): string {
  const names: Record<number, string> = {
    1: 'Contradição',
    2: 'Threshold',
    3: 'Insider',
    4: 'Ontem vs Hoje',
    5: 'High Stakes',
    6: 'Padrão',
  }
  return names[n] ?? 'Desconhecido'
}

// ---------------------------------------------------------------------------
// JSON parser (safe)
// ---------------------------------------------------------------------------

function parseJSON<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    // Try extracting JSON from markdown code blocks if model misbehaved
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match?.[1]) {
      try {
        return JSON.parse(match[1]) as T
      } catch {
        return null
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Stage output types
// ---------------------------------------------------------------------------

interface Stage1Output {
  narrative_angle: string
  hook_archetype: number
  loop_type: 'A' | 'B' | 'C'
  hook_candidates: string[]
  loop_candidates: string[]
  bridge_candidates: string[]
  key_tension: string
  key_levels: string[]
  market_mood: 'bullish' | 'bearish' | 'coiling' | 'uncertain'
  selected_hook: string
  selected_loop: string
  selected_bridge: string
  first_pinned_comment: string
}

interface Stage2Output {
  hook: string
  kasper_bullets: string[]
  voiceover: {
    paragraph1: string
    paragraph2: string
    paragraph3: string
  }
  cartela: {
    spy_price: string
    vix_level: string
    gex_regime: string
    key_level: string
  }
  loop: string
  cta: string
  metadata: {
    youtube_title: string
    youtube_description: string
    youtube_tags: string[]
    tiktok_caption: string
  }
}

// ---------------------------------------------------------------------------
// ET timezone helpers (duplicated from preMarketBriefing — kept local to avoid circular import)
// ---------------------------------------------------------------------------

function getETNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

function getTodayDateET(): string {
  const et = getETNow()
  const y = et.getFullYear()
  const m = String(et.getMonth() + 1).padStart(2, '0')
  const d = String(et.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getYesterdayDateET(): string {
  const et = getETNow()
  et.setDate(et.getDate() - 1)
  const y = et.getFullYear()
  const m = String(et.getMonth() + 1).padStart(2, '0')
  const d = String(et.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ---------------------------------------------------------------------------
// OPEX week detector — OPEX is the 3rd Friday of the month
// ---------------------------------------------------------------------------

function isOpexWeek(): boolean {
  const et = getETNow()
  const year = et.getFullYear()
  const month = et.getMonth()

  // Find 3rd Friday of this month
  let fridayCount = 0
  let opexDay = 0
  for (let day = 1; day <= 31; day++) {
    const d = new Date(year, month, day)
    if (d.getMonth() !== month) break
    if (d.getDay() === 5) {
      fridayCount++
      if (fridayCount === 3) { opexDay = day; break }
    }
  }

  // OPEX week: Mon through Fri of that week
  if (opexDay === 0) return false
  const opexFriday = new Date(year, month, opexDay)
  const opexMonday = new Date(year, month, opexDay - 4)
  return et >= opexMonday && et <= opexFriday
}
