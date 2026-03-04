# prune-analyses

Chama a função SQL `prune_old_analyses()` para arquivar análises antigas e liberar espaço (`full_text = NULL` após 90 dias).

## Agendamento (02:00 UTC diário)

- **Supabase Dashboard:** Project Settings → Edge Functions → prune-analyses → Schedule → Cron `0 2 * * *` (02:00 UTC).
- **Alternativa:** Use um cron externo (ex.: cron-job.org) para fazer GET/POST na URL de invocação da função com o header `Authorization: Bearer <anon key>` ou o secret da função.

## Variáveis

A função usa `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` (definidas automaticamente no ambiente das Edge Functions).
