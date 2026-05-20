# Drope — Motor Desmontado

> Inventário completo do que existe no repositório `~/Projetos/drope-app`,
> escrito por uma IA depois de ler o código todo, com os campos
> "**PRECISO QUE VOCÊ COMPLEMENTE**" marcados para você preencher.
>
> Última desmontagem: 17/05/2026 (commit `0694362`).

---

## 0. O esqueleto em uma frase

Drope é uma **tabacaria/pod shop Gen Z de Vila Prudente-SP**, com loja PWA
(`index.html`), painel admin, PDV de balcão, app de motoboy e um agente
WhatsApp que faz cadastro de produto por foto, gera arte, atende cliente
e controla a operação inteira. Stack: **HTML/JS puro no front + Vercel
Functions no back + Supabase no banco + Claude/Grok/OpenAI pra IA + UazAPI
pro WhatsApp + InfinitePay/Mercado Pago pro Pix**.

---

## 1. Frentes de UI (cada arquivo HTML é uma porta)

| Arquivo                  | Linhas | Pra quem                              | O que faz                                                                                  |
|--------------------------|-------:|---------------------------------------|--------------------------------------------------------------------------------------------|
| `index.html`             |  8.761 | **cliente final**                     | PWA da loja: catálogo, carrinho, checkout Pix, rastreio. IA conversa no canto. Tom Gen Z. |
| `pdv.html`               |  1.250 | **caixa do balcão**                   | Tela de venda presencial. Leitura de barcode, baixa de estoque, conferência.              |
| `receber.html`           |  1.704 | **cliente recebendo**                 | Fluxo de entrega/retirada com PWA próprio (`manifest-receber.json`).                      |
| `admin.html`             |  1.383 | **Andrade (dono)**                    | Painel admin clássico: produtos, preços, pedidos.                                          |
| `admin-pending.html`     |    221 | **Andrade (revisão)**                 | Fila de aprovação rápida — produtos cadastrados via foto, aguardando OK.                   |
| `feedback-bubble.js`     |    354 | (injetado nas páginas)                | Bolha flutuante de feedback do cliente, gravando em `drope_feedback`.                      |

E o **admin_hub** propriamente dito **não é HTML estático** — é gerado
dinamicamente por `GET /api/webhook?action=admin_hub` (linha ~12876
do `api/webhook.js`). É um portal com tiles que leva pros outros painéis
(esteira, gallery, balanço, briefings…).

---

## 2. Backend — endpoints Vercel (`api/*.js`)

Total: **12 functions** (encaixando exato no limite do plano Hobby).

| Arquivo                                  | Função no sistema                                                                  |
|------------------------------------------|------------------------------------------------------------------------------------|
| `api/webhook.js` (~14.000 linhas, 732KB) | **O agente.** Recebe UazAPI, despacha por modo (cliente/Lucas/caixa) e por action. Ele também serve os painéis HTML do admin. |
| `api/save-order.js`                      | Cliente confirma pedido no app → cria registro em `drope_orders` + decrementa estoque atomicamente (reserva). |
| `api/get-order.js`                       | Cliente abre link de rastreio (`?token=...`) → status + timeline.                  |
| `api/check-stock.js`                     | Catálogo público / validação rápida antes do checkout.                             |
| `api/cron-release-expired-reservations.js` | Roda periodicamente: pedido `created/waiting_proof/pending_pickup` há mais de 30min sem evoluir → devolve estoque, marca `expired`. |
| `api/pdv-sale.js`                        | Venda no balcão: busca barcode → registra venda → baixa estoque.                   |
| `api/admin-list-stock.js`                | Lista TODOS produtos (inclusive `hidden=true`) pro painel.                         |
| `api/admin-update-stock.js`              | Atualiza qty / hidden / price / badge. Também cria produto.                        |
| `api/admin-list-pending.js`              | Lista produtos `status='pending'` com box_photo + ref + arte gerada lado a lado.  |
| `api/admin-approve-product.js`           | Approve / reject / regenerate_art / set_price / approve_all em lote.               |
| `api/admin-orders.js`                    | Lista pedidos com filtro de status + janela temporal.                              |
| `api/admin-update-order.js`              | Avança status: `preparing → out_for_delivery → delivered`. Trigger registra audit log. Devolve estoque se cancela. |

Mais um arquivo solto: `webhook.js` na **raiz** (não no `api/`). É a v5
antiga, **não está roteada no `vercel.json`** — código morto.

---

## 3. As ~50 "actions" do `api/webhook.js`

`api/webhook.js` é um **monolito por query string**. Toda funcionalidade
de admin / cron / painel cai em `?action=...`. Agrupadas por domínio:

### Agente WhatsApp (entrada do UazAPI)
- *(sem action: POST cru do webhook do UazAPI cai no handler default)*
- `infinitepay_webhook` — confirmação Pix InfinitePay
- `infinitepay_checkout` — gera checkout InfinitePay
- `mp_webhook` — confirmação Pix Mercado Pago

### Cadastro / esteira (Lucas manda foto)
- `analyze_photo` — Claude Vision lê uma foto
- `enrich_product` — completa marca/modelo/sabor/preço
- `auto_search_ean`, `cross_ean_batch`, `link_orphan_ean`, `check_barcode`
- `busca_referencia` — Serper procura foto da caixa real
- `mass_kickoff_search` — retry de produtos travados
- `approve_reference`, `skip_reference`, `admin_upload_reference`
- `generate_art`, `generate_arts_batch`, `generate_all_pending_pod`
- `generate_pending` — gera arte do que tem ref mas não tem arte ainda
- `art_status` — consulta status de uma geração
- `notify_pending_pod`, `pending_pod_photos`, `upload_pod_photo`, `skip_pod_photo`
- `complete_unidentified` — fluxo "foto sem sabor"
- `pending_references` — fila de fotos que ainda não viraram ref
- `retry_search`
- `save_specs` — fixa nome/marca/modelo/sabor/preço final
- `quick_register`, `batch_create`, `auto_close_batches`
- `remove_pending` — descarta cadastro em andamento
- `backfill_flavors`

### Painéis HTML (admin_hub e satélites)
- `admin_hub` — portal principal com tiles
- `admin` — painel admin web (≠ `admin.html`)
- `admin_counts`, `admin_diag`
- `esteira` — pipeline visual horizontal dos produtos
- `gallery`, `gallery_action`
- `balance_panel` — conferência de estoque por foto
- `feedback`, `feedback_list`
- `customer_profile`, `home_personalized` — IA-first cliente (osso 21)
- `catalog`
- `cost_report`

### Crons (chamadas pelo Vercel no horário agendado)
- `daily_dashboard` (12h todo dia)
- `run_followups` (14h todo dia)
- `run_reorder` (13h todo dia)
- `run_drop_notifications` (13h domingo) + `queue_drop_notifications`
- `system_health` (11h todo dia)
- `weekly_health` (12h segunda)
- `friday_briefing` (21h sexta)
- `briefing_reminder` (13h sábado)
- `saturday_dispatch` (9h sábado)
- `weekly_imune_report` (13h domingo)
- `art_stuck_recovery` (15h todo dia)

---

## 4. Banco — tabelas Supabase (cruzando as 19 migrations + schema CRM)

### Tabelas principais (CRM base)
| Tabela              | O que guarda                                                              | Origem            |
|---------------------|---------------------------------------------------------------------------|-------------------|
| `drope_customers`   | Base única de clientes (dedup por telefone). Total gasto, total pedidos.  | `schema-crm.sql`  |
| `drope_orders`      | Cada pedido. Status, timeline, items JSONB, valor, audit log.             | `schema-crm.sql` + ossos 7, 14 |
| `drope_products`    | Catálogo. Slug, qty, hidden, image_status, ref_status, preço, sabor.      | osso 8 (base) + 9, 11, 17, 19, 21, 34 |

### Tabelas operacionais (cada osso uma nova)
| Tabela                         | Propósito                                                         | Osso |
|--------------------------------|-------------------------------------------------------------------|------|
| `drope_tasks`                  | Painel de tarefas Andrade↔Rafa↔Code                                | 10   |
| `drope_price_rules`            | Preço por (marca, modelo) → herdado pelos sabores                  | 13   |
| `drope_dedup`                  | Dedup persistente cross-instance Vercel                            | 15   |
| `drope_perdas`                 | Pods defeituosos baixados no PDV (controle de perdas)              | 16   |
| `drope_pending_state`          | Estado de cadastro do Lucas (sobrevive a cold start)               | 18   |
| `drope_corridas`               | Cards de corrida no grupo motoboy (lock atômico "PEGO")            | 31   |
| `drope_reposicao_alvo`         | Produtos que precisam de reposição (qty < qty_minima)              | 32   |
| `drope_reposicao_snapshot`     | Snapshot semanal do que comprar                                    | 32   |
| `drope_pedidos_fornecedor`     | Pedido enviado pro fornecedor via WhatsApp                          | 32   |
| `drope_briefings`              | Ciclo briefing-sexta → andrade autoriza → executa sábado            | 33   |
| `webhook_dedup`                | Dedup de eventos UazAPI                                            | (no `webhook.js`) |

### Stored procedures (lógica que vive no banco)
- `drope_consume_stock(slug, qty)` — decremento atômico (osso 8)
- `drope_release_stock(slug, qty)` — devolução (osso 8)
- `drope_consume_stock_force(slug, qty)` — versão PDV que ignora estoque zero (osso 12)
- `drope_check_dedup(phone, sig, ttl)` — dedup com TTL (osso 15)
- `drope_aceitar_corrida(...)` — lock atômico de motoboy (osso 31)
- `drope_increment_total_sold(slug, qty)` — popularidade (osso 21)
- `drope_log_status_change()` (trigger) — audit log de pedido (osso 7)
- `drope_tasks_log_completion()` — audit de tarefas (osso 10)

---

## 5. Integrações externas (quem fala com quem)

| Serviço              | Pra que serve                                       | Env var                                   |
|----------------------|-----------------------------------------------------|-------------------------------------------|
| **Supabase**         | Banco + Storage de imagens                          | `SUPABASE_URL`, `SUPABASE_KEY` / `SUPABASE_ANON_KEY` |
| **UazAPI**           | Recebe/envia mensagem WhatsApp                      | `UAZAPI_SERVER`, `UAZAPI_TOKEN`           |
| **Anthropic Claude** | Vision (foto → produto), OCR EAN, atendimento       | `CLAUDE_KEY`, `ANTHROPIC_API_KEY`         |
| **xAI Grok**         | Geração de arte do pod (Padrão A+ híbrido)          | `XAI_API_KEY`                             |
| **OpenAI**           | `gpt-image-1` (geração de arte alternativa)         | `OPENAI_API_KEY`                          |
| **Serper**           | Busca imagem de referência da caixa real            | `SERPER_API_KEY`                          |
| **remove.bg**        | Tirar fundo das fotos                               | `REMOVEBG_API_KEY`                        |
| **InfinitePay**      | Checkout Pix + webhook                              | `INFINITEPAY_WEBHOOK_SECRET`              |
| **Mercado Pago**     | Pix alternativo                                     | `MP_ACCESS_TOKEN`                         |
| **Vercel**           | Hospedagem + cron                                   | `VERCEL_ENV`, `VERCEL_URL`, etc.          |

E as env vars de identidade/permissão:
`ADMIN_LUCAS` (telefone, `5511962443565`), `ADMIN_CAIXA`, `PDV_PHONES`,
`PDV_PIN`, `ADMIN_TOKEN`, `CRON_TOKEN`, `EXPIRY_MINUTES`,
`STORE_WHATS_NUMBER`, `GRUPO_MOTOBOY_JID`, `GRUPO_PDV_JID`.

---

## 6. Fluxos completos

### 6.1 Fluxo cliente (pedido na loja)
```
PWA carrega → check-stock → cliente escolhe → confirmOrder()
  → POST /api/save-order (cria pedido + reserva estoque atomicamente)
  → cliente paga Pix (InfinitePay ou MP)
  → webhook do gateway entra: ?action=infinitepay_webhook ou mp_webhook
  → marca status=paid → dispara card de corrida no grupo motoboy (drope_corridas)
  → primeiro motoboy responde PEGO no grupo → drope_aceitar_corrida()
  → motoboy passa status (saiu/entregou) via WhatsApp → admin-update-order
  → se cliente abandona: cron-release-expired-reservations devolve estoque
```

### 6.2 Fluxo Lucas (cadastrar produto por foto)
```
Lucas manda foto da caixa no WhatsApp → UazAPI POSTa no webhook
  → handleAdminLucas / cadastro flow
  → ?action=analyze_photo (Claude Vision)
  → cascata EAN: OFF → UPCitemDB → Serper (?action=auto_search_ean)
  → ?action=busca_referencia (Serper imagem da caixa real)
  → preview pro Lucas → ele confirma sabor / preço / modelo
  → drope_pending_state guarda estado (sobrevive cold start)
  → ?action=generate_art (Grok ou gpt-image-1)
  → Vision QA da arte → aprovada → image_status=approved
  → vai pra fila pending → admin-pending.html
  → Andrade aprova preço (set_price) → hidden=false → cliente vê
```

### 6.3 Fluxo caixa (PDV balcão)
```
Caixa abre pdv.html → bipa barcode → /api/pdv-sale (GET ?barcode=...)
  → registra venda (POST) → drope_consume_stock_force (osso 12)
  → drope_orders.created_via='pdv' (osso 11)
  → se produto não cadastrado: drope_orders.metadata.has_unregistered=true (osso 14)
  → pod defeituoso: registra em drope_perdas (osso 16)
```

### 6.4 Fluxo briefing semanal (osso 33)
```
sexta 21h: friday_briefing
  → calcula reposição (drope_reposicao_alvo)
  → snapshot em drope_reposicao_snapshot
  → manda whats pro Andrade com texto + lista
  → registra drope_briefings status='pending'
Andrade responde no whats → interpretAuthorizations parseia
  → drope_briefings.status='authorized' + autorizações JSONB
sábado 9h: saturday_dispatch
  → manda pedidos pros fornecedores (drope_pedidos_fornecedor)
sábado 13h: briefing_reminder (se ainda 'pending')
domingo 13h: weekly_imune_report (health check semanal)
```

---

## 7. Identidade — o tom Drope (regras escritas no código)

**System prompt do agente WhatsApp** (`api/webhook.js` ~4227):
> *"Voce e o catalogador da Drope, loja Gen Z de pods em Vila Prudente-SP.
> Tom: lo-fi authentic, Gen Z favela Vila Prudente. Minusculas. Max 1-2
> emojis por mensagem. Curto (2-4 linhas WhatsApp)."*

**System prompt do assistente da loja** (`index.html` ~8485):
> *"Você é o assistente IA da loja Drope, uma tabacaria para público Gen Z
> em São Paulo. Fale em português brasileiro informal, tom Gen Z mas
> profissional. Seja conciso. Nunca invente informações sobre produtos
> que não estão no catálogo."*

**Regra de descrição de produto** (`descricao_quebrada`):
> *"max 80 caracteres, vibe lo-fi authentic Gen Z favela Vila Prudente,
> minusculas, max 1 emoji, sensacao real do sabor. NUNCA usar 'delicioso,
> incrivel, experimente, o melhor'. Exemplos: 'menta gelada que escorre
> na garganta 🧊', 'manga doce escorrendo no calor', 'frutas vermelhas
> com soco de gelo'."*

**Padrão visual da arte** (Grok image gen):
> *"Padrão A+ híbrido (gradient acid fade + aura cyan/pink, NÃO branco
> asséptico, NÃO caos cyber). Deep shadows, desaturated midtones,
> selective neon highlights. Dark moody atmosphere — premium Gen Z vape
> culture aesthetic."*

**Paleta** (CSS vars no `index.html`):
- `--bg: #0A0A14` (quase preto)
- `--ultraviolet: #5B21B6`
- `--pink: #FF2D6F`
- `--lime: #D4FF2E`

**Mascote**: camaleão (`03_Logo/drope_logo_v5_neon_chameleon_hero.jpg`,
emoji 🦎 nos painéis internos).

**Princípios mencionados no código** (achei exatamente 1):
- **"Princípio do Volante"** (`index.html:7538`) — *"'ver tudo' sempre
  disponível"* (cliente nunca fica preso na recomendação da IA).

---

## 8. Vocabulário interno (glossário que está no código)

| Palavra      | Significado no Drope                                                          |
|--------------|-------------------------------------------------------------------------------|
| **osso**     | Cada migration/feature numerada (ossos 7 a 34). Vértebras do esqueleto.       |
| **esteira**  | Pipeline visual de cadastro: foto → ref → arte → preço → publicado.            |
| **FLC**      | Sigla que aparece nos cabeçalhos ("FLC FASE 2", "FLC FASE 5"). Provavelmente fluxo de cadastro completo. |
| **tier1 / tier2** | Camadas de validação no cadastro (tier1 = básico, tier2 = preço/edição/desfaz). |
| **imune**    | Sistema de health check semanal (cron `weekly_imune_report`).                 |
| **briefing** | Ciclo sexta→sábado de reposição com fornecedor (osso 33).                     |
| **PDV**      | Ponto de venda físico (balcão).                                                |
| **corrida**  | Pedido pago disponível pra um motoboy pegar no grupo.                          |
| **hidden**   | Flag de produto invisível pro cliente (cadastrado mas sem preço definido).     |
| **Padrão A+** | Identidade visual oficial da arte (gradient acid fade + aura cyan/pink).      |

---

## 9. Estado atual (17/05/2026)

- **Branch**: `main`, sincronizado com `origin/main` (`dropetabacaria-crypto/drope-app`).
- **Último commit**: `0694362 feat(ean): cruzamento foto + cascade online (lote EAN)`.
- **Ruído**: `git status` mostra arquivos modificados, mas é só CRLF→LF da
  migração Windows→Mac.
- **Bug pequeno conhecido**: `manifest.json` aponta `start_url` pra
  `./drope-app.html` que não existe.
- **Código morto**: `webhook.js` na raiz (versão antiga, não roteada).
- **Sem `.env.example`**.
- **Foco recente das ~20 últimas commits**: estabilizar a esteira de
  cadastro automático (EAN cascade, QA visual da arte, recovery de
  travados, consolidação pra caber em 12 functions Vercel).

---

## 10. O que eu NÃO sei (preciso que você complemente)

Estas são as lacunas reais. Marca `[X]` quando for verdadeiro, e escreve
do lado o que está na sua cabeça que não está no repo.

### 10.1 Conceitos/doutrina internos
- [ ] **"Princípio da IA"** — você mencionou. No código só existe
  "Princípio do Volante" (cliente sempre tem escape). Você tem mais
  princípios documentados em algum lugar?
  - escreva aqui: ___
- [ ] **"Ministérios"** — não acho menção nenhuma no código. O que são?
  - escreva aqui: ___
- [ ] **"FLC"** — aparece nos cabeçalhos de algumas funções. Significa o
  quê pra você?
  - escreva aqui: ___
- [ ] Outros vocabulários internos que você usa mas não escreveu no
  código:
  - ___

### 10.2 Visão de produto
- [ ] O Drope é só Vila Prudente ou tem plano de escalar pra outras
  cidades?
  - escreva aqui: ___
- [ ] Tem outras categorias planejadas além de pod/tabacaria?
  - ___
- [ ] Qual o roadmap dos próximos 3 meses na sua cabeça?
  - ___
- [ ] Tem investidor / sócio / time além de você + Rafa + (Code)?
  - ___

### 10.3 Operação
- [ ] Quantas vendas/dia hoje? Qual a meta?
  - ___
- [ ] Quantos motoboys ativos? Quantos clientes na base?
  - ___
- [ ] Quantos produtos cadastrados? Quantos pendentes na esteira?
  - ___
- [ ] Custo mensal atual de infra (Vercel + Supabase + APIs)?
  - ___

### 10.4 Migrations
- [ ] As 19 migrations `osso*` foram **todas** aplicadas no Supabase de
  produção? (Eu não tenho como confirmar daqui.)
  - escreva quais já rodaram: ___

### 10.5 Decisões pendentes que apareceram no código
- [ ] `TODO[multi-tenant]` em `cron-release-expired-reservations.js:23`
  ("filtrar por tenant_id quando Plataforma sair do dormindo"). Existe
  plano de virar plataforma multi-loja?
  - ___
- [ ] `webhook.js` na raiz: pode apagar?
  - ___
- [ ] `api/webhook.js` com 14k linhas — você quer quebrar em módulos
  algum dia, ou prefere deixar monolito enquanto cabe?
  - ___

### 10.6 Coisas que provavelmente existem fora do repo
- [ ] Notion / Google Doc com spec original?
- [ ] WhatsApp seu com você mesmo onde você joga ideias?
- [ ] Telas de design no Figma?
- [ ] Documento de marca (logo, paleta, voz)?
- [ ] Lista de fornecedores físicos?
- [ ] Planilha financeira?

Se você cola o link / texto / print de qualquer um desses aqui embaixo, eu
incorporo no documento.

---

## 11. Próximos passos sugeridos (em ordem)

1. **Hoje, 15 min — Mac setup.** Normalizar CRLF (`.gitattributes` + `git
   add --renormalize`), instalar Vercel CLI, `vercel login`, `vercel link`,
   `vercel env pull .env.local`.
2. **Hoje, 30 min — Limpeza cosmética.** Apagar `webhook.js` da raiz,
   corrigir `manifest.json start_url`, criar `.env.example`.
3. **Esta semana — Confirmar migrations no Supabase.** Rodar `select
   count(*)` em cada uma das 19 tabelas pra ter certeza que todas estão
   no ar.
4. **Esta semana — Preencher seção 10 deste documento.** O que você sabe
   e o código não documenta vira ouro.
5. **Próximas semanas — Trabalho de produto** (esteira / EAN / QA da arte
   / quebrar `api/webhook.js`).

---

## 12. Como manter este documento vivo

- Edita direto no Mac (qualquer editor de texto serve).
- Quando você adicionar info na seção 10, me pede pra reler — eu reescrevo
  as outras seções incorporando.
- Quando rodar uma migration nova ou subir uma feature nova, anota aqui
  (não precisa nem ser bonito; uma linha basta).
- Se um dia você quiser virar isso em README oficial pro repo, é só
  pedir.

---

*Fim do motor desmontado.*
