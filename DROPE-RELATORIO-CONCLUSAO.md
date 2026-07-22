# Drope — Relatório de Conclusão do App

_O que estava faltando, o que já foi feito, e o plano pra terminar._
_Baseado em auditoria completa do código (não nos docs de junho, que estavam defasados)._

---

## 1. Estado geral

O Drope é um app **tecnicamente sofisticado e ~80% pronto na superfície**, mas com o **núcleo do e-commerce desconectado**: até agora, o pedido do cliente não era gravado no servidor de forma confiável e o pagamento não fechava o ciclo. A maior parte do "backlog" antigo (docs de junho) **já estava resolvida** — o problema real era outro e não estava mapeado.

**Boa notícia:** o backend (funções serverless + Supabase) está pronto e bem-feito. O trabalho que falta é majoritariamente **conectar o front ao backend** e **corrigir pontas soltas** — nada de reescrever fundação.

---

## 2. O que já estava pronto (verificado no código)

- Modo teste (`TESTE100OFF`) — completo (zera total, pula pagamento, não mexe em estoque).
- Preços `.99` automáticos — front + backend.
- Filtros/chips de vibe no catálogo — construídos.
- Checkout InfinitePay com **fallback** de link (não quebra fácil).
- Backend de pedido (`save-order`) — upsert de cliente, **baixa de estoque atômica com rollback**, token de rastreio.
- Rastreio do cliente (`get-order`) com timeline.
- Endpoints admin (pedidos, estoque, aprovação) — com autenticação `ADMIN_TOKEN` server-side consistente.
- Fluxos de balcão: PDV, recebimento por foto/scanner, balanço/reconciliação — funcionais.

---

## 3. O que estava faltando

### 🔴 Núcleo do e-commerce (o buraco central)
1. **Pedido não era gravado no servidor** — vivia só no `localStorage` do aparelho. _(RESOLVIDO — ver seção 4.)_
2. **Pagamento InfinitePay não registra o pedido** — abre o link e para; cliente paga e nada acontece no app.
3. **Cartão é uma demo falsa** — pede dados, anima "autorizando" e marca como pago, sem cobrar nada.
4. **Taxa de entrega é mostrada mas não entra no total cobrado** — loja recebe menos.

### 🟡 Bugs de funil (cliente)
5. Cupom aplicado no carrinho é **apagado ao entrar no checkout**.
6. Cliente de nome "Lucas" fica **preso como visitante** (nome usado como sentinela).
7. Cupom de teste `TESTE100OFF` **ativo e exposto** ao cliente em produção.

### 🟠 Operação (admin / balcão)
8. `admin.html`: aba **"Tarefas" inteira morta** — endpoint `/api/tasks` não existe (404 silencioso); "modo Rafa" idem.
9. `admin.html`: botão **"🔄 arte"** chama endpoint inexistente (`/api/admin-regenerate-art`).
10. `admin.html`: preço do item do pedido **sem formatação** (`r$ 90.30000001`).
11. `receber.html`: dar entrada em produto existente **falha em silêncio no 401** — Yasmin "recebe" estoque e nada é gravado.
12. `balanco.html`: **câmera nunca é desligada** — dreno de bateria, risco de travar câmera no iOS.
13. `pdv.html`: `setInterval` do relógio **empilha** a cada login.

### 🔒 Segurança (depende de secrets / Andrade — pausado por decisão)
14. Webhook InfinitePay **aceita "pago" forjado** (sem validar assinatura; `INFINITEPAY_WEBHOOK_SECRET` não setado).
15. **IDOR** em `get-order?nsu=` — dá pra enumerar pedidos de clientes (endereço, itens, nome).
16. `save-order` aceita `status:"paid"` vindo do cliente.
17. `generate_pending` sem autenticação — dispara 3 APIs pagas por request público (custo).
18. Gate admin do `index.html` cosmético (senha `drope2026` hardcoded, checagem client-side).
19. Telefones da família/equipe hardcoded no repositório.

### 🔵 Higiene
20. `webhook.js` da raiz é **arquivo morto** (não roteado) duplicando config; versionamento confuso.
21. Módulo de geração de vídeo "implementado mas nunca chamado".
22. Código morto em `index.html`, `dashboard.html`, `filial.html`.
23. `filial.html`: autenticação fraca (senha = 4 últimos dígitos do telefone).

---

## 4. O que já foi feito

**#1 — Pedido conectado ao backend** ✅
`confirmOrder()` agora grava o pedido via `/api/save-order` (baixa de estoque atômica), aborta limpo se faltar estoque (409), guarda o token de rastreio e degrada com elegância se o backend cair. Pedido teste segue sem tocar o backend. _Sintaxe validada; verificação ponta-a-ponta pendente de secrets reais._

---

## 5. Plano pra terminar (priorizado)

### Fase 1 — Fechar o ciclo de compra (núcleo) 🔴
- [ ] InfinitePay: registrar o pedido ao voltar do pagamento (hoje paga e não registra) — itens #2.
- [ ] Decidir o cartão: integrar cobrança real **ou** remover/ocultar a demo falsa — item #3.
- [ ] Somar a taxa de entrega no total cobrado (alinhar `confirmOrder`/InfinitePay/WhatsApp) — item #4.
- [ ] Usar o `track_url` na tela de sucesso e na mensagem de WhatsApp.

### Fase 2 — Bugs de funil (cliente) 🟡
- [ ] Não apagar o cupom ao entrar no checkout — item #5.
- [ ] Corrigir a sentinela "Lucas" (usar flag de cadastro, não o nome) — item #6.
- [ ] Esconder `TESTE100OFF` do cliente em produção — item #7.

### Fase 3 — Operação (admin / balcão) 🟠
- [ ] `admin.html`: criar `/api/tasks` **ou** remover a aba Tarefas/modo Rafa — item #8.
- [ ] `admin.html`: consertar/remover botão "arte" — item #9.
- [ ] `admin.html`: formatar preço do item — item #10.
- [ ] `receber.html`: tratar 401 na entrada de estoque com aviso visível — item #11.
- [ ] `balanco.html`: liberar a câmera (`getTracks().stop()` + `beforeunload`) — item #12.
- [ ] `pdv.html`: limpar `setInterval` antes de recriar — item #13.

### Fase 4 — Segurança (com Andrade + secrets) 🔒
- [ ] `INFINITEPAY_WEBHOOK_SECRET` — validar assinatura do webhook — item #14.
- [ ] Fechar IDOR do `get-order`, travar `status` no `save-order`, autenticar `generate_pending` — itens #15–17.
- [ ] Auth admin server-side no `index.html` — item #18.
- [ ] Tirar telefones/segredos hardcoded do repo — item #19, #23.

### Fase 5 — Higiene 🔵
- [ ] Remover `webhook.js` da raiz e código morto — itens #20–22.

---

## 6. Bloqueador operacional (importante)

Os **secrets do projeto estão marcados como "Sensitive" na Vercel** → `vercel env pull` traz os nomes mas com **valor vazio** (Supabase, Claude, ADMIN_TOKEN, etc.). Por isso **funções que usam o banco não rodam localmente** (retornam `supabase not configured`). Para testar backend localmente é preciso:
- os valores reais colados no `.env.local` (só Andrade/Lucas têm), **ou**
- testar via **deploy de preview** na Vercel (onde a env existe).

O que **dá** pra desenvolver/testar sem secrets: front puro, lógica de UI, validações client-side, sintaxe/QA.

---

_Documento gerado durante a preparação do ambiente e auditoria do projeto._
