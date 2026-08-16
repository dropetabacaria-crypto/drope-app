# DROPE — Documento de Investimento & Valor Construído

*Marketplace de delivery para tabacarias e adegas (modelo iFood, nichado).*
*Uso: base para negociação de sociedade e valuation. Estimativas de mercado — valores finais dependem de negociação e tração.*

---

## Resumo executivo

O DROPE **já é um produto funcional e no ar**, não uma ideia no papel. O que foi construído, se contratado de uma agência ou time de desenvolvimento no mercado, custaria **entre R$ 220 mil e R$ 450 mil** — conservadoramente, **mais de R$ 200 mil** em desenvolvimento.

Isso **não conta** o valor do conhecimento de mercado, da marca, nem do potencial de receita — só o **custo de reposição** (quanto custaria refazer o que já existe).

---

## 1. O que já está construído (e no ar)

Não é um MVP simples. É uma plataforma completa, multi-loja, com IA e pagamentos:

**App do cliente (iFood-style)**
- Descoberta de lojas por região, catálogo, busca, categorias/filtros
- Sacola, checkout em 2 passos, cupons, favoritos, ofertas
- Acompanhamento do pedido ao vivo + notificações (sininho)
- Conta com login por senha, endereços salvos, histórico de pedidos

**Pagamentos (o mais difícil)**
- **Pix via Mercado Pago com split** por loja (comissão automática do DROPE)
- **Cartão dentro do app** (formulário seguro, tokenização, cofre de cartões salvos, adicionar/excluir cartão)
- Webhooks de confirmação, pedido confirmado na hora (modelo iFood)

**Painel do lojista**
- Cadastro de produto em 3 passos com **IA**: foto → identifica marca/modelo/sabor (visão computacional), leitura de **código de barras**, **geração de imagem por IA** no padrão da marca
- Controle de **estoque** preciso (baixa só no pagamento confirmado)
- **Gestão de pedidos** estilo iFood (aceitar → separar → pronto/a caminho → entregue)
- Perfil da loja (endereço + rota Maps/Waze, horários, tema, capa), conexão de pagamento, balanço, programa de indicação, funcionários

**Painel administrativo**
- Dashboard de faturamento/comissões, clientes, pedidos, lojas, cupons, IA

**Infra e diferenciais técnicos**
- Arquitetura **multi-loja** (cada loja isolada) — pronta pra escalar pra centenas de lojas
- **Pipeline de IA proprietário** (identificação de produto + geração de arte no estilo DROPE) — algo que a maioria das agências **não sabe fazer**
- PWA (funciona como app, offline), design próprio (identidade DROPE)

---

## 2. Custo de reposição (quanto custaria construir no mercado)

Estimativa por módulo, em horas de desenvolvimento, a valor de mercado brasileiro (dev sênior / agência, faixa R$ 120–220/h):

| Módulo | Horas (est.) |
|---|---|
| App do cliente (descoberta, catálogo, sacola, checkout, acompanhamento, conta) | 300–400 |
| Pagamentos (Pix + split + cartão + cofre + webhooks) | 200–300 |
| Painel do lojista (produtos, estoque, pedidos, perfil) | 300–400 |
| Pipeline de IA (identificação por foto + geração de imagem) | 150–250 |
| Painel administrativo | 100–150 |
| Backend + arquitetura multi-loja | 250–350 |
| Entrega/logística (entregadores) | 80–120 |
| Notificações | 50–80 |
| Design / identidade / UX | 100–150 |
| QA, testes, deploy, iterações | 150–200 |
| **TOTAL** | **~1.700–2.400 h** |

**Cálculo:**
- Conservador: 1.700 h × R$ 130/h ≈ **R$ 221.000**
- Médio: 2.000 h × R$ 160/h ≈ **R$ 320.000**
- Agência (completo): 2.400 h × R$ 190/h ≈ **R$ 456.000**

> **Faixa de custo de reposição: R$ 220 mil a R$ 450 mil.** É o valor "já investido" em trabalho, se fosse pago a preço de mercado.

---

## 3. Custos reais desembolsados (preencher com os valores exatos)

Ferramentas e infraestrutura usadas pra construir e rodar:

| Item | Custo (mensal/estimado) |
|---|---|
| Assinatura Claude (desenvolvimento com IA) | _preencher_ |
| Infra (Vercel + Supabase) | _grátis/plano — preencher_ |
| APIs de IA (OpenAI / xAI Grok / Serper) | _créditos — preencher_ |
| Domínio / outros | _preencher_ |
| **Horas de trabalho (Rafael + Andrade)** | _custo de oportunidade — ver seção 2_ |

> Guardar todos os comprovantes: podem ser lançados como investimento/despesa da empresa (e reembolsados aos sócios depois).

---

## 4. Valor além do custo (o que não entra na conta acima)

- **Time técnico** que domina IA aplicada + pagamentos (raro no mercado).
- **Conhecimento de nicho:** tabacarias/adegas de periferia — mercado pouco atendido, com muita loja.
- **Marca DROPE** já construída (identidade, app, posicionamento).
- **Modelo de receita duplo:** comissão por venda + assinatura (SaaS) das lojas.
- **Pronto pra escalar:** multi-loja desde o dia 1.

---

## 5. Como usar isso na proposta de sociedade (ex: Toguru)

O custo de reposição (R$ 220–450 mil) é a **âncora de valuation**: mostra que a empresa **já vale**, antes de faturar. Na prática:

1. **Definir um valuation** (ex.: o custo construído + potencial + o que o novo sócio agrega). O capital social no contrato é outra coisa — não precisa refletir o valuation.
2. **Fatia justa pro sócio:** ele contribui com dinheiro, **alcance/divulgação** e conhecimento de mercado. A fatia sai da negociação sobre o valuation.
3. **Vesting:** o sócio conquista a fatia **ao longo do tempo / entregando** (ex.: divulgação, metas) — protege vocês de dar um pedação de graça.
4. **Acordo de sócios** (advogado): papéis, decisões, saída. Importante com mais de 2 sócios.

> Argumento central pro Toguru: *"O produto já está pronto e no ar — o que custaria R$ 200–450 mil pra construir. Você entra num negócio já de pé, com o mercado que você conhece."*

---

## Ressalvas
- Números são **estimativas de mercado** (custo de reposição), não uma avaliação contábil formal.
- **Valuation real** = negociação + tração (usuários, vendas, receita recorrente). Quanto mais o DROPE vender, maior o valor.
- Decisões de sociedade, capital social e valuation devem passar por **contador + advogado**.
