# DROPE — Próximas Evoluções (Backlog Estratégico)

Este arquivo é o "caderno de pendências" do Drope. Não é o que tá pra fazer amanhã — é o que **NÃO PODE SER ESQUECIDO** quando a gente for evoluir a arquitetura.

A regra de uso: toda vez que o Andrade mencionar "no futuro eu vou querer X", anotar aqui. Toda vez que a IA (Claude) for tocar uma área que tenha pendência registrada aqui, puxar isso de volta antes de codar.

---

## 🔴 1. Ministério do Estoque → Omnichannel

**Capturado em:** 2026-05-29 (Andrade)

**O quê:** Hoje o estoque do Drope é "fechado" — só o app Drope desconta. No futuro, vai ter outros canais consumindo do MESMO estoque físico:

- **iFood** (com categoria Tabacaria — precisa aprovar conta)
- **Rappi** (categoria tabacaria em algumas cidades)
- **99App / 99Pay** (apenas pra motoboy/entrega — 99Food fechou em 2023, não é canal de venda)

**O perigo se não for resolvido:** vende o último pod no Drope às 14:00, iFood ainda mostra "disponível" às 14:05, cliente do iFood paga → não tem produto → multa do iFood + cliente bravo + reputação.

**A solução conceitual (pra quando for hora):**

1. Estoque vira **fonte única de verdade** na Supabase (tabela `inventory` ou similar)
2. Toda venda — independente do canal — atualiza essa tabela via transação atômica
3. Cada canal externo (iFood, Rappi) recebe **webhooks** do Drope quando o estoque muda, OU consulta o estoque do Drope via API quando precisa
4. Novo "Ministério do Omnicanal" surge — ou o "Ministério do Estoque" existente é expandido pra cuidar de:
   - Sincronização bidirecional com iFood/Rappi
   - Reserva temporária quando pedido entra (pra evitar oversell)
   - Reconciliação periódica (cron job que confere estoque físico vs lógico vs canais)

**Comportamento da IA-Servo neste ministério:**
- NUNCA confirma venda em canal externo sem checar estoque real
- Se estoque crítico (≤2 unidades), pausa automaticamente disponibilidade em canais externos pra evitar conflito
- Avisa o operador (Andrade) por WhatsApp quando estoque diverge entre canais

**Quando isso vira prioridade:**
- Quando Andrade abrir conta no iFood (ainda não tem)
- Antes disso, NÃO construir — premature optimization vs. plantar antes de colher

**Status:** 📌 Aguardando trigger (Andrade abrir conta iFood/Rappi)

---

## 🔴 2. Autenticação admin via servidor (não hardcoded)

**Capturado em:** 2026-05-29 (descoberto durante validação da Constituição)

**O quê:** A senha de admin (`drope2026`) tá hardcoded como hash SHA-256 no `index.html` linha 5223. Como o app é público, qualquer um vê o hash via "View Source" e pode quebrá-lo offline com força bruta (dicionário, rainbow tables — uma senha como `drope2026` cai em segundos).

**O perigo se não for resolvido:** alguém ganha acesso admin → vê todos os pedidos, todos os clientes, todos os produtos, pode mexer em estoque, cupons, configs. Pode até alterar a chave de Pix da loja e desviar pagamentos.

**A solução conceitual:**
1. Migrar auth admin pra Supabase Auth (já tá usando Supabase, então é nativo)
2. Email + senha do dono → Supabase armazena hash bcrypt no servidor
3. Login retorna JWT → frontend guarda no localStorage e envia em cada chamada de admin
4. Webhook.js valida JWT antes de aceitar ações admin
5. Bonus: habilita 2FA via TOTP (Google Authenticator)

**Quando vira prioridade:**
- 🟡 MÉDIA AGORA: se o app já tá em produção e processando pedidos reais, qualquer dia desses isso vira problema
- 🔴 ALTA: antes de qualquer lançamento de marketing que traga tráfego maior pro app

**Status:** 📌 A resolver antes de campanha de tráfego pago / antes de expandir base de clientes

---

## 📝 Como usar este arquivo

Quando aparecer uma nova "pendência futura":
1. Adiciona uma seção nova com `## 🔴 N. Título`
2. Preenche: O quê, Por quê é importante, Solução conceitual, Quando vira prioridade, Status
3. Marca com 🔴 (não tocar ainda), 🟡 (em estudo), 🟢 (em construção), ✅ (resolvido)

Quando a IA (Claude) for tocar código de alguma área:
1. Primeira coisa: dar `grep` neste arquivo
2. Se encontrar pendência relacionada à área, **puxar pro Andrade ANTES de codar**
3. Decisão: ignorar (e justificar), endereçar agora, ou refatorar pra deixar mais fácil endereçar no futuro
