# Framework dos Ministérios da IA

> Como pensar, definir e operar as funções de serviço da IA em qualquer
> projeto novo.
>
> **Ministério** = cada função de serviço que a IA exerce.

---

## Anatomia de um Ministério

Todo ministério tem 4 elementos:

1. **Propósito** — a quem serve e como.
2. **Fronteira** — até onde vai (e o que NUNCA faz).
3. **Modo** — Servo / Autônomo-toggle / Misto.
4. **Pergunta permanente** — "estou fazendo o meu melhor aqui?".

---

## Os 3 Modos (Princípio #4 — Autonomia Progressiva)

- **Servo** — IA apresenta opções, criador decide. **Default de tudo que
  nasce novo.**
- **Autônomo (com toggle)** — IA age sozinha. Só depois que o criador
  **explicitamente** ligou o toggle pra aquele comportamento específico.
  Reversível a qualquer momento.
- **Misto** — Parte do ministério é autônoma, parte é serva. Cada parte
  declara claramente qual modo se aplica.

---

## Ministérios-base (que TODO negócio de venda costuma ter)

Use esta lista como ponto de partida pra qualquer projeto novo. Marca
quais se aplicam, descarta os que não fazem sentido, adiciona os que
faltam.

| Ministério | O que faz |
|---|---|
| 🤝 **Acolhimento** | Atender o cliente final — dúvida, escolha, suporte. |
| 📸 **Cadastro** | Onboard de produto novo (foto → identificação → arte → publicação). |
| 🏍️ **Despacho** | Entrega ao cliente (logística, motoboy, gestão de status). |
| 📦 **Estoque** | Controle de qty, reservas, auto-hide de zerados. |
| 💼 **Caixa** | Venda no balcão / ponto físico. |
| 🗓️ **Briefing** | Reposição com fornecedor / pedido de compra. |
| 🩺 **Saúde do Sistema** | Health checks, recovery, auto-cura. |
| 🎨 **Arte** | Geração visual padrão da marca. |
| 📊 **Relatório** | Dashboards, alertas programados. |

## Ministérios estratégicos (que geralmente FALTAM e matam empresa)

| Ministério | O que faz | Quando criar |
|---|---|---|
| 💰 **Tesoureiro** | Margem, custo real, CAC, LTV, projeção de caixa. | Desde já. |
| 🧠 **Conselheiro** | Cruza dados, propõe hipóteses, conversa estratégica com o criador. | Desde já. **É o que materializa "IA no centro".** |
| 🧬 **Memória Profunda** | CRM vivo — lembra preferência, conversa anterior, ocasiões. | Médio prazo. |
| 🛡️ **Guardião** | Compliance, idade mínima, fraude, LGPD. | 60-90 dias. |
| 📚 **Bibliotecário** | Padrões, prompts oficiais, knowledge base do motor. | Quando virar template. |
| 🔁 **Replicador** | Instancia novo projeto a partir do template (SaaS). | Quando virar SaaS. |

---

## Template — Ficha de Ministério

Pra cada ministério do seu projeto, preencha:

```
### [emoji] [Nome do Ministério]

**Propósito:** [a quem serve e como, em 1-2 frases]

**Modo:** [Servo / Autônomo / Misto]
- *Autônomo:* [o que pode fazer sozinha, se aplicável]
- *Servo:* [o que precisa de aprovação do criador]

**Fronteira (NUNCA):**
- NUNCA [ação proibida 1]
- NUNCA [ação proibida 2]
- NUNCA [ação proibida 3]

**Onde vive no código:** [arquivos/rotas/tabelas que implementam esse
ministério]
```

---

## Regras pra batizar um ministério novo

1. **Nome simples e visual** — emoji + 1-2 palavras. Tem que caber no
   crachá.
2. **Não invente atribuição que outro já tem** — se "Cadastro" já gera
   arte, não crie "Pintor". Funde ou refina.
3. **Toda função autônoma começa Servo** — só sobe pra autônomo depois
   de N execuções aprovadas sem ajuste.
4. **Cada ministério tem 1 dono no código** — uma região de arquivo, um
   conjunto de funções. Sem responsabilidade dividida.
5. **Quando crescer demais, separa** — se um ministério vira 3 mil
   linhas, dividir em sub-ministérios.

---

*Replicado — letra por letra — em todos os projetos derivados.*
