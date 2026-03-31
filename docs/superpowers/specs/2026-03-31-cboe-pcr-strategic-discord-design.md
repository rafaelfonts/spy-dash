# CBOE PCR — Disparos Estratégicos no Discord

**Data:** 2026-03-31  
**Status:** Aprovado  
**Arquivo afetado:** `backend/src/data/cboePCRPoller.ts` (único)

---

## Problema

O `cboePCRPoller.ts` dispara mensagens para o Discord em dois vetores não-controlados:

1. **Poll inicial 30s após startup** — chama `publishCBOEPCR()` que sempre envia para o Discord, independente de já ter publicado hoje. Cada restart do backend gera uma mensagem duplicada no `#feed`.
2. **Scheduler 16:35 ET** — tem lock Redis por data (`lock:cboe_pcr:YYYY-MM-DD`), mas o mesmo `publishCBOEPCR()` não distingue se está sendo chamado pelo scheduler ou pelo startup.

O agente IA deve continuar tendo acesso ao dado via `getLastCBOEPCR()` → Redis em qualquer cenário.

---

## Requisitos

1. **1x por dia no Discord** — somente às 16:35 ET, nunca no startup.
2. **Startup silencioso** — restaura dado ao cache Redis/memória para o agente IA, sem tocar o Discord.
3. **Detecção de virada de polaridade** — a mensagem diária das 16:35 ET embute alerta quando a polaridade muda vs. dia anterior (bullish ↔ bearish).
4. **Zero impacto em outros arquivos** — `restoreCache.ts`, `index.ts`, `openai.ts`, `sse.ts` não mudam.

---

## Design

### Separação de responsabilidades

Duas funções com responsabilidades distintas substituem o fluxo atual:

#### `restoreCBOEPCRToCache(): Promise<void>`
- Chamada no startup (substitui o `setTimeout` de 30s atual)
- Chama `fetchCBOEPCR()` para buscar o dado mais recente
- Salva no Redis via `cacheSet(CACHE_KEY, data, TTL_MS, 'cboe_pcr')`
- Emite `emitter.emit('cboe_pcr', data)` para SSE e agente IA
- **Nunca chama `sendEmbed()` ou qualquer função Discord**

#### `publishCBOEPCRToDiscord(data: CBOEPCRData): Promise<void>`
- Chamada exclusivamente pelo scheduler de 16:35 ET
- Verifica flag `cboe_pcr_published:YYYY-MM-DD` no Redis com `NX`:
  - Se flag já existe → log + return (pula Discord)
  - Se não existe → seta flag (TTL 14h) + envia embed + salva `cboe_pcr_daily_prev`
- Após publicação bem-sucedida, salva dado atual em `cboe_pcr_daily_prev` (TTL 48h) para referência do dia seguinte

### Detecção de polaridade

```typescript
function getPolarityGroup(label: CBOEPCRData['label']): 'bullish' | 'bearish' | 'neutral' {
  if (label === 'greed' || label === 'extreme_greed') return 'bullish'
  if (label === 'fear' || label === 'extreme_fear') return 'bearish'
  return 'neutral'
}
```

- Ao publicar, lê `cboe_pcr_daily_prev` do Redis
- Compara `getPolarityGroup(prev.label)` vs `getPolarityGroup(current.label)`
- Virada ocorre quando: `prev !== 'neutral' && current !== 'neutral' && prev !== current`
- `neutral` nunca dispara alerta de virada (não tem polaridade definida)

### Embed Discord

**Sem virada** — embed padrão existente (título, Total/Equity/Index PCR, sentimento, notas de interpretação).

**Com virada** — embed padrão + bloco adicional no topo da description:
```
[!] Virada de Sentimento: BULLISH → BEARISH
Ontem: Ganância (0.48) | Hoje: Medo (0.82)
```
Cor do embed muda para `DISCORD_COLORS.signalAvoid` (vermelho) em virada bearish, `DISCORD_COLORS.signalProceed` (verde) em virada bullish. Sem virada mantém `DISCORD_COLORS.cboePCR` (roxo).

### Chaves Redis

| Chave | TTL | Uso |
|---|---|---|
| `cboe_pcr_daily` | 14h | Cache do dado atual — lido por `getLastCBOEPCR()` |
| `cboe_pcr_daily_prev` | 48h | Dado do dia anterior — referência para detecção de polaridade |
| `cboe_pcr_published:YYYY-MM-DD` | 14h | Flag de "já publicado hoje" — evita duplo disparo Discord |
| `lock:cboe_pcr:YYYY-MM-DD` | 14h | Lock existente do scheduler — mantido sem alteração |

### Fluxo do scheduler (16:35 ET)

```
setInterval (60s)
  → hhmm === '16:35' && dia útil
  → lock:cboe_pcr:YYYY-MM-DD (NX) — adquirido?
    → não: return (outro processo já rodou)
    → sim:
      → fetchCBOEPCR()
      → restoreCBOEPCRToCache(data)   ← atualiza cache/memória
      → publishCBOEPCRToDiscord(data) ← verifica flag, detecta polaridade, envia
```

### Fluxo do startup

```
setTimeout (30s)
  → fetchCBOEPCR()
  → restoreCBOEPCRToCache(data)  ← só cache, sem Discord
```

---

## O que NÃO muda

- `getLastCBOEPCR()` — assinatura e comportamento inalterados
- `fetchCBOEPCR()` — lógica de fetch e fallback de 5 dias inalterada
- `startCBOEPCRScheduler()` — assinatura pública inalterada (chamada em `index.ts`)
- Todos os outros arquivos do projeto

---

## Critérios de sucesso

- Backend pode reiniciar N vezes no mesmo dia sem gerar mensagem duplicada no Discord
- Às 16:35 ET em dia útil, exatamente 1 mensagem é enviada ao `#feed`
- Se polaridade mudou vs. dia anterior, a mensagem contém o bloco `[!] Virada de Sentimento`
- `getLastCBOEPCR()` retorna dado válido após qualquer restart (agente IA não perde contexto)
