# CBOE PCR — Disparos Estratégicos no Discord — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir o `cboePCRPoller.ts` para que o Discord receba exatamente 1 mensagem por dia (16:35 ET), o startup nunca dispare para o Discord, e a mensagem embute alerta de virada de polaridade bullish ↔ bearish quando ocorre.

**Architecture:** Único arquivo modificado — `backend/src/data/cboePCRPoller.ts`. O `publishCBOEPCR()` atual é decomposto em `restoreCBOEPCRToCache()` (startup, sem Discord) e `publishCBOEPCRToDiscord()` (scheduler, com flag Redis anti-duplo). Detecção de polaridade via `cboe_pcr_daily_prev` (TTL 48h).

**Tech Stack:** TypeScript, ioredis, Fastify EventEmitter, `sendEmbed` do `discordClient.ts`.

---

## Arquivos

| Ação | Arquivo |
|---|---|
| Modificar | `backend/src/data/cboePCRPoller.ts` |

Nenhum outro arquivo é tocado.

---

### Task 1: Adicionar `getPolarityGroup()` e `restoreCBOEPCRToCache()`

**Files:**
- Modify: `backend/src/data/cboePCRPoller.ts`

- [ ] **Step 1: Abrir o arquivo e localizar as funções existentes**

Abrir `backend/src/data/cboePCRPoller.ts`. As referências são:
- `publishCBOEPCR()` começa na linha 88
- `getLastCBOEPCR()` começa na linha 120
- `startCBOEPCRScheduler()` começa na linha 128

- [ ] **Step 2: Adicionar `getPolarityGroup()` logo após `parseEquityLabel()`**

Inserir após a função `parseEquityLabel` (linha 29), antes de `toETDateString`:

```typescript
function getPolarityGroup(label: CBOEPCRData['label']): 'bullish' | 'bearish' | 'neutral' {
  if (label === 'greed' || label === 'extreme_greed') return 'bullish'
  if (label === 'fear' || label === 'extreme_fear') return 'bearish'
  return 'neutral'
}
```

- [ ] **Step 3: Adicionar `restoreCBOEPCRToCache()` após `getLastCBOEPCR()`**

Inserir logo após `getLastCBOEPCR()` (após linha 122):

```typescript
/**
 * Restaura o dado mais recente ao cache Redis e emite via SSE.
 * Nunca publica no Discord — apenas garante que o agente IA tenha o dado disponível.
 */
export async function restoreCBOEPCRToCache(): Promise<void> {
  try {
    const data = await fetchCBOEPCR()
    if (!data) {
      console.warn('[CBOE PCR] restoreCBOEPCRToCache: nenhum dado disponível')
      return
    }
    await cacheSet(CACHE_KEY, data, TTL_MS, 'cboe_pcr')
    emitter.emit('cboe_pcr', data)
    console.log('[CBOE PCR] Cache restaurado (sem Discord)')
  } catch (err) {
    console.warn('[CBOE PCR] restoreCBOEPCRToCache falhou:', (err as Error).message)
  }
}
```

- [ ] **Step 4: Verificar que o TypeScript compila sem erros**

```bash
cd /Users/rafaelfontes/Documents/SPY\ Dash/backend && npx tsc --noEmit 2>&1 | head -30
```

Esperado: nenhuma linha de erro relacionada a `cboePCRPoller.ts`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash"
git add backend/src/data/cboePCRPoller.ts
git commit -m "feat(cboe-pcr): adicionar getPolarityGroup e restoreCBOEPCRToCache (sem Discord)"
```

---

### Task 2: Adicionar `publishCBOEPCRToDiscord()` com flag anti-duplo e detecção de polaridade

**Files:**
- Modify: `backend/src/data/cboePCRPoller.ts`

- [ ] **Step 1: Adicionar a constante da chave `_prev` e a função `publishCBOEPCRToDiscord()`**

Inserir logo após `restoreCBOEPCRToCache()` (antes de `startCBOEPCRScheduler`):

```typescript
const CACHE_KEY_PREV = 'cboe_pcr_daily_prev'
const TTL_PREV_MS = 48 * 60 * 60 * 1000  // 48h

/**
 * Publica o PCR diário no Discord.
 * Protegida por flag Redis cboe_pcr_published:YYYY-MM-DD — dispara no máximo 1x/dia.
 * Detecta virada de polaridade bullish ↔ bearish vs. dia anterior.
 */
export async function publishCBOEPCRToDiscord(data: CBOEPCRData): Promise<void> {
  // Atualiza cache/memória primeiro (independente do Discord)
  await cacheSet(CACHE_KEY, data, TTL_MS, 'cboe_pcr')
  emitter.emit('cboe_pcr', data)

  // Flag anti-duplo
  const now = new Date()
  const etDate = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const flagKey = `cboe_pcr_published:${etDate}`
  const acquired = await redis.set(flagKey, '1', 'EX', 14 * 60 * 60, 'NX')
  if (!acquired) {
    console.log(`[CBOE PCR] Já publicado hoje (${etDate}) — Discord ignorado`)
    return
  }

  // Detecção de polaridade vs. dia anterior
  const prev = await cacheGet<CBOEPCRData>(CACHE_KEY_PREV)
  const currentPolarity = getPolarityGroup(data.label)
  const prevPolarity = prev ? getPolarityGroup(prev.label) : 'neutral'
  const polarityFlip =
    prevPolarity !== 'neutral' &&
    currentPolarity !== 'neutral' &&
    prevPolarity !== currentPolarity

  // Monta embed
  const labelEmoji: Record<CBOEPCRData['label'], string> = {
    extreme_fear: '[!!] Medo Extremo — proteção sistemica comprada',
    fear: '[!] Medo — premio de put elevado',
    neutral: '[ ] Neutro',
    greed: '[+] Ganancia — premio de put baixo',
    extreme_greed: '[++] Ganancia Extrema — complacencia',
  }

  const polarityLabel: Record<'bullish' | 'bearish', string> = {
    bullish: 'BULLISH',
    bearish: 'BEARISH',
  }

  const prevEquityStr = prev ? `${prev.equityPCR.toFixed(2)}` : '—'
  const flipBlock = polarityFlip && prev
    ? [
        `[!] Virada de Sentimento: ${polarityLabel[prevPolarity as 'bullish' | 'bearish']} → ${polarityLabel[currentPolarity as 'bullish' | 'bearish']}`,
        `Ontem: ${prev.label === 'greed' || prev.label === 'extreme_greed' ? 'Ganancia' : 'Medo'} (${prevEquityStr}) | Hoje: ${data.label === 'greed' || data.label === 'extreme_greed' ? 'Ganancia' : 'Medo'} (${data.equityPCR.toFixed(2)})`,
        ``,
      ].join('\n')
    : ''

  const description = [
    flipBlock,
    `**Total PCR:** ${data.totalPCR}`,
    `**Equity PCR:** ${data.equityPCR}  <- principal indicador`,
    `**Index PCR:** ${data.indexPCR}`,
    ``,
    `**Sentimento:** ${labelEmoji[data.label]}`,
    ``,
    `> Equity PCR > 0.8 = medo -> favoravel para Put Spread (premio alto)`,
    `> Equity PCR < 0.5 = complacencia -> cautela com sizing`,
  ].join('\n')

  const embedColor = polarityFlip
    ? currentPolarity === 'bearish'
      ? DISCORD_COLORS.signalAvoid      // vermelho — virou bearish
      : DISCORD_COLORS.signalProceed    // verde — virou bullish
    : DISCORD_COLORS.cboePCR            // roxo — sem virada

  await sendEmbed('feed', {
    title: `CBOE Put/Call Ratio — ${now.toLocaleDateString('pt-BR', { timeZone: 'America/New_York' })}`,
    description,
    color: embedColor,
    footer: { text: 'Fonte: CBOE · Publicado apos fechamento do mercado' },
    timestamp: now.toISOString(),
  })

  // Salva dado atual como referência para amanhã
  await cacheSet(CACHE_KEY_PREV, data, TTL_PREV_MS, 'cboe_pcr_prev')
  console.log(`[CBOE PCR] Publicado no Discord (${etDate})${polarityFlip ? ' — virada de polaridade!' : ''}`)
}
```

- [ ] **Step 2: Verificar que o TypeScript compila sem erros**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend" && npx tsc --noEmit 2>&1 | head -30
```

Esperado: nenhuma linha de erro relacionada a `cboePCRPoller.ts`.

- [ ] **Step 3: Commit**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash"
git add backend/src/data/cboePCRPoller.ts
git commit -m "feat(cboe-pcr): adicionar publishCBOEPCRToDiscord com flag anti-duplo e detecção de polaridade"
```

---

### Task 3: Refatorar `startCBOEPCRScheduler()` — startup silencioso + scheduler usa nova função

**Files:**
- Modify: `backend/src/data/cboePCRPoller.ts`

- [ ] **Step 1: Substituir o corpo de `startCBOEPCRScheduler()`**

Localizar a função `startCBOEPCRScheduler()` (linha 128 aprox.) e substituir o corpo inteiro por:

```typescript
export function startCBOEPCRScheduler(): void {
  setInterval(async () => {
    const now = new Date()
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = etTime.getDay()
    if (day === 0 || day === 6) return

    const hhmm = `${etTime.getHours()}:${String(etTime.getMinutes()).padStart(2, '0')}`

    if (hhmm === SCHEDULED_HHMM) {
      const dateET = `${etTime.getFullYear()}-${String(etTime.getMonth() + 1).padStart(2, '0')}-${String(etTime.getDate()).padStart(2, '0')}`
      const lockKey = `lock:cboe_pcr:${dateET}`
      const acquired = await redis.set(lockKey, '1', 'EX', LOCK_TTL, 'NX')
      if (!acquired) {
        console.log(`[CBOE PCR] Lock já adquirido para ${dateET} — fetch ignorado`)
        return
      }

      const data = await fetchCBOEPCR()
      if (data) await publishCBOEPCRToDiscord(data)
    }
  }, CHECK_INTERVAL_MS)

  // Startup silencioso — restaura cache para o agente IA, sem Discord
  setTimeout(() => {
    restoreCBOEPCRToCache()
      .catch((err) => console.warn('[CBOE PCR] Restore inicial:', (err as Error).message))
  }, 30_000)

  console.log('[CBOE PCR] Scheduler iniciado — disparo 16:35 ET em dias úteis')
}
```

- [ ] **Step 2: Remover a função `publishCBOEPCR()` exportada antiga (linhas 88–118)**

A função `publishCBOEPCR()` antiga deve ser removida — ela foi substituída por `restoreCBOEPCRToCache()` + `publishCBOEPCRToDiscord()`. Verificar que nenhum outro arquivo a importa:

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash" && grep -r "publishCBOEPCR" backend/src --include="*.ts" | grep -v "cboePCRPoller.ts"
```

Esperado: nenhuma linha (apenas o próprio arquivo pode aparecer). Se algum arquivo externo a importar, substituir a chamada por `publishCBOEPCRToDiscord()` nesse arquivo antes de remover.

- [ ] **Step 3: Verificar que o TypeScript compila sem erros**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend" && npx tsc --noEmit 2>&1 | head -30
```

Esperado: zero erros.

- [ ] **Step 4: Verificar que o arquivo final tem a estrutura correta**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash" && grep -n "^export\|^function\|^const " backend/src/data/cboePCRPoller.ts
```

Esperado — funções/constantes visíveis (nenhuma `publishCBOEPCR` antiga):
```
const CACHE_KEY = ...
const CBOE_CDN_BASE = ...
const TTL_MS = ...
export interface CBOEPCRData ...
function parseEquityLabel ...
function getPolarityGroup ...
function toETDateString ...
async function fetchForDate ...
export async function fetchCBOEPCR ...
export async function restoreCBOEPCRToCache ...
export async function getLastCBOEPCR ...
const CACHE_KEY_PREV = ...
const TTL_PREV_MS = ...
export async function publishCBOEPCRToDiscord ...
const SCHEDULED_HHMM = ...
const CHECK_INTERVAL_MS = ...
const LOCK_TTL = ...
export function startCBOEPCRScheduler ...
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash"
git add backend/src/data/cboePCRPoller.ts
git commit -m "refactor(cboe-pcr): startup silencioso — restoreCBOEPCRToCache no boot, publishCBOEPCRToDiscord no scheduler"
```

---

### Task 4: Build de produção e deploy

**Files:**
- Nenhum arquivo novo

- [ ] **Step 1: Build completo do backend**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend" && npm run build 2>&1 | tail -20
```

Esperado: `Build succeeded` ou similar, sem erros TypeScript.

- [ ] **Step 2: Deploy no Fly.io**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend" && fly deploy
```

Esperado: `v[N] deployed successfully`.

- [ ] **Step 3: Verificar logs após deploy — confirmar que o startup não disparou para o Discord**

```bash
cd "/Users/rafaelfontes/Documents/SPY Dash/backend" && fly logs --app spy-dash-backend-dark-log-5876 2>&1 | grep -i "cboe\|CBOE" | head -20
```

Esperado: linhas do tipo:
```
[CBOE PCR] Cache restaurado (sem Discord)
```

**Não** deve aparecer: `[CBOE PCR] Publicado no Discord` durante o startup.

---

## Checklist de verificação final

- [ ] Backend reiniciado N vezes no mesmo dia → zero mensagens Discord geradas pelo startup
- [ ] `getLastCBOEPCR()` retorna dado válido logo após restart (30s de delay)
- [ ] Às 16:35 ET em dia útil → exatamente 1 mensagem no `#feed`
- [ ] Se polaridade mudou vs. dia anterior → mensagem contém `[!] Virada de Sentimento`
- [ ] TypeScript compila sem erros
- [ ] `restoreCache.ts`, `index.ts`, `openai.ts`, `sse.ts` — inalterados
