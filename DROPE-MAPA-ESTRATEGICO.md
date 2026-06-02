# DROPE — Mapa Estratégico

> Posição honesta do projeto, atualizada periodicamente.
> Documento de leitura obrigatória antes de qualquer decisão grande.

**Última atualização:** 29/05/2026
**Autor:** Conselheiro/Arquiteto (Claude)
**Para:** Andrade (fundador)

---

## Diagnóstico atual

Drope é hoje um **produto tecnicamente sofisticado sem tração comercial**.

A sofisticação técnica está vários degraus à frente da validação de mercado. Isso é o sintoma clássico do fundador-técnico: refúgio no terreno conhecido (código) pra evitar o terreno desconhecido (vendas, marketing, posicionamento).

**Sinais quantitativos:**
- 8 arquivos de doutrina/estratégia (~3.000 linhas)
- 15.000 linhas de código no motor principal (webhook.js)
- 12 ministérios funcionando
- Constituição IA-Servo deployada e validada em produção
- 80+ produtos físicos no estoque
- 5 clientes recorrentes validados como compradores potenciais
- **0 vendas processadas pelo app**

**Conclusão:** o motor existe e funciona. O carro tá na garagem com tanque cheio. Falta sair pra rua.

---

## Pirâmide de Prioridades (4 semanas)

```
                    SEMANA 4
                  ╱           ╲
                ╱   ESCALAR     ╲   ← Marketing pago, Instagram orgânico,
              ╱___________________╲    parcerias, expansão de catálogo
            ╱                       ╲
          ╱         SEMANA 3          ╲   ← Loop de retenção, sistema de
        ╱        RETER & MEDIR         ╲    cupons, métricas reais
      ╱___________________________________╲
    ╱                                       ╲
  ╱             SEMANA 2                     ╲   ← Onboarding manual dos 5,
╱      ATIVAR (5 → 50 clientes)               ╲    coleta de feedback, ajustes
╲_________________________________________________╲
                                                   
              SEMANA 1 — AGORA
        VENDER PRA UM (1 sale by 05/06)
   ↑
   |
   └── Tu tá AQUI. Tudo o resto é prematuro.
```

**Regra de ouro:** não pula degrau. Vender pra UM é a porta. Sem ela, todo o resto é decoração.

---

## O Caminho Crítico pra Semana 1

A meta única é: **1 cliente real fechando 1 compra pelo app até sexta 05/06.**

Tudo o que NÃO contribui pra isso é distração nesta semana.

### O que CONTRIBUI:
1. **Catálogo populado** (mesmo que MVP com 5-10 produtos) — sem isso, nada acontece
2. **Conversa com os 5 clientes** ("tô lançando, quer ser o primeiro?")
3. **Cupom de lançamento** (motivo concreto pra cliente USAR app em vez de WhatsApp)
4. **Teste end-to-end** (tu mesmo simular uma compra completa antes de chamar cliente)
5. **Aviso de chegada** (a feature que ELES PEDIRAM — sem isso, eles voltam pro WhatsApp)

### O que NÃO contribui (pode esperar):
- Refatorar webhook.js
- Construir os 6 ministérios faltantes
- Auth admin via Supabase (segurança)
- Estoque omnichannel iFood
- Instagram polido
- Loja com 80 produtos perfeitamente catalogados
- Imagens reais dos produtos (emoji resolve)
- Mais features no app

---

## Stack de Decisões Cortantes (o que cortar agora)

Pra cumprir Semana 1, estas decisões PRECISAM ser tomadas hoje/amanhã:

| Decisão | Cortar | Manter |
|---|---|---|
| Quantos produtos no catálogo de lançamento? | 80 perfeitos | **10 imperfeitos** (os mais vendidos no balcão) |
| Imagem dos produtos? | Foto profissional | **Emoji** (🍋🍑🌿🍓...) |
| Quem é o público da Semana 1? | "Vila Prudente Gen Z" | **Os 5 que tu já conversou** |
| Como avisar os 5? | Post Instagram | **WhatsApp pessoal teu, 1 a 1** |
| Por que eles vão usar app em vez de WhatsApp? | "É melhor" | **Cupom 30-50% off de pioneiro** |
| Quando lança? | "Quando tiver pronto" | **Quarta 03/06** (dá margem de erro) |

---

## Ações Imediatas (próximas 24h)

Em ordem de leverage decrescente:

**1. Mensagem aos 5 clientes — leva 30 min, leverage máximo**

Template pessoal de WhatsApp:
> "E aí, [nome]. Lembra que a gente conversou sobre o app do Drope?
> Tô lançando essa quarta (03/06). Tu lembra que falou que ia querer comprar pelo app com desconto e aviso de chegada? Tô fazendo isso.
> Quer ser um dos 5 pioneiros? Cupom 50% off na primeira compra, só pros 5 que validaram comigo.
> Se topar, te mando o link na quarta de manhã."

Isso cria: comprometimento dos 5 + pressão saudável em ti pra lançar quarta + social proof.

**2. Listar os 10 produtos top — leva 30 min com a menina do caixa**

Não os 80. Os 10 mais vendidos no balcão (ela sabe de cor). Esses entram no app de lançamento. Resto vem depois.

Formato: nome, preço, estoque. Eu converto pra JSON.

**3. Teste end-to-end como cliente — leva 1h**

Tu, no celular, abre o app, faz 1 compra completa (Pix). Anota TODO atrito que aparecer. Não conserta agora — só lista. Esses bugs viram tickets pra terça/quarta.

**4. Aviso de chegada — feature crítica que eles pediram**

Verificar se já existe no app. Se não existe, é a ÚNICA feature que se justifica construir essa semana. (As outras 14 ministérios podem esperar.)

---

## Coisas que vão te puxar pra distração (alerta)

Tu vai sentir vontade de fazer estas coisas. **Resista.**

- "Vou refatorar o webhook.js antes" — não. Funciona. Lança.
- "Vou colocar foto bonita em todo produto" — não. Emoji. Lança.
- "Vou postar no Instagram pra atrair tráfego novo" — não. Os 5 já existem. Lança pra eles.
- "Vou construir o Ministério X primeiro" — não. Já tem 12. Lança.
- "Vou esperar acabar de aprender Y" — não. Tu já sabe o suficiente. Lança.

Cada uma dessas é a muralha que o Conselheiro identificou.

---

## Métricas de sucesso da Semana 1

- ✅ 1 venda real pelo app até sexta (05/06)
- ✅ 5 clientes pioneiros foram avisados pessoalmente
- ✅ Catálogo MVP de 10 produtos no ar
- ✅ Bug crítico identificado pelo teste end-to-end → consertado

Se hit os 4: vai pra Semana 2 (ativar 5 → 50).
Se hit 1-3: replanejar Semana 2.
Se hit 0: Conselheiro de emergência — algo grande tá faltando do diagnóstico.

---

## Princípios que regem este Mapa

1. **Plantar antes de colher** (Princípio #6 da Doutrina) → tá invertido hoje, corrigir
2. **Construir o carro, não o motor** (princípio do projeto Drope) → motor pronto, falta vender o carro
3. **Validação > preferência pessoal** → o cliente disse "preço + aviso", entrega isso, nada mais
4. **Quantidade gera qualidade** → 10 vendas reais ensinam mais que 100 horas de polimento

---

## Próximas revisões deste mapa

- Semanal, todo domingo, junto da sessão de Plantio do Conselheiro.
- Mover degrau na pirâmide só quando o degrau atual estiver cumprido.
- Atualizar Diagnóstico se a foto mudar (ex: depois de 5 vendas, "0 vendas processadas" vira "5 vendas processadas").
