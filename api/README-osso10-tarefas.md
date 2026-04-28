# Deploy — Painel `drope_tasks` (Osso 10) + Cron de Expiry de Reservas

> Construído na sessão de Code 28/04/2026 (TAREFA 6 do PONTE + Decisão 1 do estoque).
> Estes 4 passos colocam tudo no ar. Tempo estimado: ~15 minutos.

---

## 1. Rodar a migration no Supabase

Abre `dashboard.supabase.com` → projeto Drope → **SQL Editor** → New Query → cola
o conteúdo do arquivo `supabase-migration-osso10-tasks.sql` inteiro → Run.

Confere que rodou:

```sql
select count(*) from drope_tasks;        -- deve retornar 9 (seed inicial)
select assignee, status, count(*) from drope_tasks group by 1, 2;
```

A migration é idempotente (pode rodar de novo sem problema; só re-cria function/trigger).

---

## 2. Adicionar env vars no Vercel

Vai em `vercel.com` → projeto `drope-app` → **Settings → Environment Variables** e
adiciona estas (todas em `Production` + `Preview`):

| Nome | Como gerar / o que colocar |
|------|----------------------------|
| `RAFA_TOKEN` | `openssl rand -hex 16` (gera token aleatório de 32 chars). Esse é o token que vai na URL `?t=...` que o Rafa salva no celular. |
| `RAFA_PHONE` | Telefone do Rafa com DDI, formato UazAPI: `5511...` (sem +, sem espaço, sem traço). Ex: `5511987654321`. |
| `CRON_TOKEN` | `openssl rand -hex 16`. Token compartilhado entre os endpoints cron-* e o agendador externo (cron-job.org). |

As que **já existem** (não precisa criar de novo): `SUPABASE_URL`, `SUPABASE_KEY`,
`ADMIN_TOKEN`, `UAZAPI_SERVER`, `UAZAPI_TOKEN`, `ADMIN_LUCAS`, `CLAUDE_KEY`.

Depois de adicionar, faz **Redeploy** do último deploy pra aplicar as env vars.

---

## 3. Push do código + auto-deploy

Os arquivos novos:

- `api/cron-release-expired-reservations.js` (Decisão 1 — modelo reserva)
- `api/supabase-migration-osso10-tasks.sql` (passo 1 acima)
- `api/tasks-list.js`
- `api/tasks-create.js`
- `api/tasks-update.js`
- `api/cron-tasks-daily-summary.js`
- `../admin.html` (nova aba **✅ tarefas**)

Commit + push no GitHub → Vercel auto-deploya.

Depois de subir, abre `drope-app.vercel.app/admin` → login com `ADMIN_TOKEN` → toca
na aba **✅ tarefas**. Você deve ver as 9 rows do seed (7 tarefas + 2 decisões).

---

## 4. Mandar o link pro Rafa

Pega o `RAFA_TOKEN` que você gerou no passo 2 e monta o link:

```
https://drope-app.vercel.app/admin?t=COLAR_AQUI_O_RAFA_TOKEN
```

Manda esse link pro Rafa no WhatsApp pedindo pra ele abrir no celular e tocar em
**Adicionar à tela inicial** (Chrome / Safari). Vira ícone tipo app. Toda vez
que ele abrir, já entra direto no painel dele (sem login, sem senha, vê só as
tarefas dele).

---

## 5. (Pendente — depois da Decisão 2) Agendar os crons

Hoje os 3 endpoints cron existem mas **ninguém chama eles automaticamente**. Quando
você decidir onde rodar (entrada `DECISÃO: onde rodar os crons agendados` no
painel), aí configura assim:

### Se escolher (B) cron-job.org — recomendação Code

Cria 3 jobs em `cron-job.org` apontando pros endpoints abaixo. Em todos: método
**POST**, header `x-cron-token: <CRON_TOKEN>`.

> **Nota (28/04/2026):** os 5 endpoints da TAREFA 6 foram **consolidados em 1 só**
> (`/api/tasks`) pra encaixar no limite de 12 funções serverless do plano Hobby do
> Vercel. As operações são despachadas via método HTTP e query param `op`.
> Comportamento idêntico, só muda a URL.

| Job | URL (POST) | Frequência sugerida |
|-----|------------|---------------------|
| Expiry de reservas | `https://drope-app.vercel.app/api/tasks?op=cron-release` | A cada 10 min |
| Resumo diário do painel | `https://drope-app.vercel.app/api/tasks?op=cron-daily` | 1×/dia, 09:00 America/Sao_Paulo |
| (futuros — quando construir) Follow-up 24h, Recompra 15d | a definir | 1×/h, 1×/dia |

### Se escolher (A2) Vercel Cron Pro

Adiciona `vercel.json` com `crons:` array apontando pros mesmos endpoints (Vercel
manda `Authorization: Bearer <CRON_SECRET>`, e os endpoints já aceitam esse formato).

---

## Checklist final

- [ ] Migration `osso10-tasks.sql` rodou no Supabase (9 rows na `drope_tasks`)
- [ ] `RAFA_TOKEN`, `RAFA_PHONE`, `CRON_TOKEN` adicionadas no Vercel
- [ ] Redeploy feito
- [ ] `/admin#tarefas` mostra as 9 tarefas do seed
- [ ] Link `?t=...` do Rafa testado no celular dele
- [ ] PWA salva como app na tela inicial (Andrade + Rafa)
- [ ] Decisão "onde rodar crons" despachada no painel
- [ ] Crons agendados conforme decisão
- [ ] Ping diário 9h chegou no WhatsApp do Andrade no dia seguinte

Quando tudo isso estiver ✅, a TAREFA 6 fecha de vez e as outras (#1-#5) viram
trabalho do Code despachado pelo painel.
