# Metodologia — Plantar o DNA num projeto novo

> 5 passos pra pegar um projeto novo do zero (ou um projeto em andamento)
> e fazer ele nascer/renascer com o DNA da IA-Servo.
>
> Tempo total: ~2 horas de conversa entre você e a IA (não precisa codar).

---

## Passo 1 — Motor Desmontado (30 min)

**Objetivo:** mapear tudo que existe (ou tudo que se planeja) no projeto,
peça por peça.

Pergunta a si mesmo (ou pede pra IA te entrevistar):

- O que esse projeto faz? (1 frase)
- Quem é o cliente? Quem é o criador?
- Que telas / endpoints / integrações existem (ou vão existir)?
- Que dados precisam ser guardados?
- Que serviços externos entram (pagamento, mensagem, IA, etc.)?

**Saída:** arquivo `MOTOR-DESMONTADO.md` listando UI, backend, banco,
integrações, fluxos, vocabulário interno.

---

## Passo 2 — Princípios (1 hora)

**Objetivo:** extrair o que está no coração do criador sobre o projeto.

Use o questionário das **30 perguntas** (a estrutura está no projeto
Drope, em `DROPE-PRINCIPIOS.md`):

- **Bloco 1 (6 perguntas):** o que VOCÊ TEM hoje.
- **Bloco 2 (6 perguntas):** o que ESPERA em 90 dias.
- **Bloco 3 (6 perguntas):** o que QUER em 2 anos.
- **Bloco 4 (6 perguntas):** o que NÃO NEGOCIA (princípios).
- **Bloco 5 (6 perguntas):** o que está TRAVANDO.

Cada projeto pode ter princípios próprios além dos 6 universais. O que
NÃO MUDA são os 6 universais (estão na Constituição).

**Saída:** arquivo `PRINCIPIOS.md` com as 30 respostas + síntese
(onde estamos / onde vamos / caminho).

---

## Passo 3 — Constituição (5 min)

**Objetivo:** instalar a constituição da IA-Servo no projeto.

1. Copia `01-CONSTITUICAO-IA-SERVO.md` desta pasta pra dentro do projeto.
2. Substitui `[CRIADOR]` pelo seu nome.
3. Substitui `[PROJETO]` pelo nome do projeto.
4. Pronto. Esse documento é lei dentro do projeto.

**Saída:** arquivo `CONSTITUICAO.md` no projeto.

---

## Passo 4 — Ministérios (30 min)

**Objetivo:** mapear as funções de serviço da IA no setor específico.

1. Abre `02-FRAMEWORK-MINISTERIOS.md` desta pasta.
2. Olha a lista de ministérios-base + estratégicos.
3. Pra cada um, decide: **fica / não se aplica / muda o nome**.
4. Adiciona ministérios específicos do setor que não estão na lista.
5. Pra cada ministério, preenche a ficha (propósito + modo + fronteira).

**Saída:** arquivo `MINISTERIOS.md` no projeto, com cada ministério
descrito.

---

## Passo 5 — Plugar no código (variável)

**Objetivo:** fazer a doutrina virar realidade no software.

1. **System prompt da IA:** começa SEMPRE com os 10 artigos da
   Constituição. Sem exceção. (Pode ser uma referência curta tipo
   "Você opera sob a Constituição da IA-Servo. Artigos relevantes
   hoje: ..." pra não estourar token.)
2. **Cada feature nova nasce no modo Servo.** Toggle pra autônomo só
   depois de N execuções aprovadas.
3. **Cada ministério tem sua região clara no código.** Não mistura.
4. **Implementa a pergunta permanente** — antes de qualquer ação
   importante, log do raciocínio: "estou fazendo o meu melhor aqui?".
5. **Freio do criador.** Em algum lugar das configurações, painel com
   toggles pra cada ministério (modo + ativo/inativo).

**Saída:** código rodando com IA-servo de verdade.

---

## Checklist final — o projeto novo está com o DNA?

- [ ] Tem `CONSTITUICAO.md` na raiz do projeto.
- [ ] Tem `MINISTERIOS.md` listando cada função da IA.
- [ ] Tem `PRINCIPIOS.md` com a síntese estratégica.
- [ ] System prompts referenciam a Constituição.
- [ ] Toda feature nova começa em modo Servo.
- [ ] Tem painel/config com toggle por ministério.
- [ ] Criador pode revogar qualquer autonomia a qualquer momento.

Se os 7 itens estão marcados, o DNA está plantado. Pode crescer.

---

*Replicado — letra por letra — em todos os projetos derivados.*
