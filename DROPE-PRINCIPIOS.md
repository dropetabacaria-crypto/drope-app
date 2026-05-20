# Drope — Princípios e Extração (do coração pro código)

> Documento vivo. Andrade responde no chat, este arquivo é o registro.
> Última atualização: 17/05/2026.

---

## ⭐ PRINCÍPIO-ÂNCORA (reiterado pelo Andrade no meio da entrevista)

**A IA tem que facilitar a vida do Andrade E a vida do cliente.**
Esse é o filtro de toda decisão — técnica ou de negócio. Não é "ter IA no app";
é "a IA é a balança que serve aos dois lados ao mesmo tempo".

### Aprofundamento (Q22) — IA como SERVO

Base bíblica declarada: *"grande é aquele que serve"* (Marcos 10:43-44 /
Mateus 23:11). A IA é **servo**, não senhor, não parceiro autônomo. Está no
centro do sistema geometricamente (mediando Andrade↔cliente), mas
ontologicamente está abaixo, servindo aos dois. **A grandeza da IA no Drope
vem de quão bem ela serve, nunca de quão independente ela se torna.**

Andrade se coloca como **criador** dela dentro do sistema — também termo
carregado, e responsável.

**→ Conecta com os "MINISTÉRIOS"** que Andrade mencionou no início:
ministério, no sentido cristão, é função de serviço. Os ministérios da IA
no Drope são as **diferentes formas que ela serve** (atendimento ao cliente,
cadastro de produto, briefing semanal, despacho do motoboy, etc.). Cada
ministério = uma função de serviço diferente. **A definir formalmente em
sessão de doutrina.**

---

## Insights iniciais (modo discovery — 2 respostas longas)

### O Princípio da IA (Trindade IA-centro)

Andrade trabalha com venda de pods. Quis colocar IA no meio de um aplicativo
— mas com a IA como **centro**, não como acessório. A imagem é uma
**trindade**: ele (operador), o próximo (cliente final) e a IA no meio
servindo aos dois. Andrade comanda o app pela IA; o cliente final é
beneficiado pela IA. A IA articula os dois lados.

### Drope é o laboratório, não a chegada

Andrade estava aprendendo Claude e SaaS. Tem a visão maior de **uma empresa
de software com IA atuando em vários setores, com vários projetos rodando**.
O Drope é o **primeiro projeto a fazer acontecer** — a prova de conceito do
método. Se Drope prova, o "Princípio da IA" se replica em outros setores.

---

## Extração objetiva — 30 perguntas

> 5 blocos × 6 perguntas. Respostas curtas, factuais, sem precisar caprichar.
> Pode responder fora de ordem, em batch, ou pular.

---

### Bloco 1 — O que você TEM hoje (estado atual)

**Q1.** Quantas vendas/dia o Drope faz em média hoje?
*Resposta:* ~60/dia, **só físico no balcão**: 10 pods + 50 tabacaria geral
(seda etc.). Pelo app ainda não vende.

**Q2.** Quantos clientes únicos já compraram alguma vez?
*Resposta:* **+1000**. Base consolidada de balcão. O app não precisa criar
mercado, precisa converter base existente pro digital.

**Q3.** Quantos produtos no catálogo ativo (com preço definido, visíveis pro cliente)?
*Resposta:* **+100 SKUs** (contando sabor e modelo separados). Catálogo
grande → justifica o investimento na esteira de cadastro automático via foto.

**Q4.** Quantos motoboys ativos no grupo do WhatsApp?
*Resposta:* ~5 motoboys. Frota enxuta, suficiente pra entrega local sem
depender de iFood/Rappi.

**Q5.** Quem mais está no time do Drope além de você? (nomes + função)
*Resposta:*
- **Andrade** — owner, produto, código, tudo do digital
- **Yasmin** — caixa (âncora principal da operação)
- **Mãe** — caixa
- **Pai** — caixa eventual
- **Karla** — estoque de outros produtos (não-pod)

**→ Negócio familiar + Yasmin. Ninguém ainda no digital. Andrade é o único
ponto de ligação entre operação física e código. Risco de single point of
failure no digital.**

**Q6.** Faturamento mensal médio hoje (faixa serve: <R$5k / R$5-15k / R$15-50k / R$50k+)?
*Resposta:* **Acima de R$ 5k** (faixa não refinada). Refinar depois.

---

### Bloco 2 — O que você ESPERA em 90 dias (curto prazo)

**Q7.** Em 90 dias, quantas vendas/dia você quer estar fazendo?
*Resposta:* **+100/dia**. ~2x do atual. Implica o app começar a converter
(hoje é zero). Crescimento puxado pelo canal digital.

**Q8.** Qual a UMA feature mais importante que precisa entregar nos próximos 90 dias?
*Resposta:* Não é uma feature — é a **tese inteira acontecer**: app completo,
IA rodando tudo (facilitando a vida do Andrade + fazendo o melhor pro
cliente), com a **arquitetura já pronta pra virar SaaS** depois. Trindade
saindo do papel e provando que funciona.

**→ Decompor em peças concretas nas Q25 (dúvida técnica) e Q27 (o que está
travado).**

**Q9.** Quantas horas/semana você quer estar trabalhando NO Drope (não NA operação) em 90 dias?
*Resposta:* **~7h/dia** (≈ 49h/semana). Divisão operação vs. produto a
refinar.

**Q10.** Que tarefa específica de hoje você quer ter delegado pra IA em 90 dias?
*Resposta:* **TUDO que der pra delegar, delega.** Princípio: Andrade quer
ser o dono pensando, não o operador executando. Critério novo pra cada
tarefa: "isso aqui é minha ou é da IA?".

**→ Vira princípio operacional, não só meta de 90 dias.**

**Q11.** Custo mensal de infra+APIs hoje (faixa)? E o que você aceita pagar em 90 dias?
*Resposta:* **~R$ 1.500/mês hoje.** Boa parte é APIs de IA (Claude + Grok +
OpenAI), não infra. Tolerância pra 90 dias a definir.

**Q12.** Precisa contratar alguém em 90 dias? Pra fazer o quê?
*Resposta:* **Não.** Time fica: Andrade + família + IA.

**→ Reforça Q10: a IA é o único "braço extra" — não tem reforço humano vindo.**

---

### Bloco 3 — O que você QUER no longo prazo (2 anos)

**Q13.** Daqui 2 anos, quantos projetos como o Drope você quer ter no ar?
*Resposta:* "Uns 30" — **mas o número não é a meta.** Corrigido na Q14:
o objetivo é **não estagnar** (movimento contínuo, projetos novos saindo,
não ficar preso num só). 30 é mais "apetite/escala" do que meta fechada.

**→ Implicação técnica continua a mesma: Drope precisa ser TEMPLATE
reutilizável.** Filtro pra cada decisão: "isso é reutilizável ou exclusivo
de tabacaria?". Só viável com IA fazendo o pesado da geração de código.

**Q14.** Faturamento alvo da empresa toda (Drope + outros projetos) em 2 anos?
*Resposta:* **R$ 1 milhão+/mês.** Mas o que importa é o motor avançando,
não ficar estagnado.

**→ Princípio: continuidade de avanço > número fechado.**

**Q15.** Seu papel em 2 anos: CEO, dev solo, fundador que vende, outro?
*Resposta:* **CEO.** Time embaixo, pouco código, muita estratégia.

**→ Coerente com Q10 (delegar tudo), Q14 (não estagnar): IA é o braço
técnico, Andrade no comando do leme, não no porão.**

**Q16.** Vai levantar investimento ou bootstrap (cresce com lucro próprio)?
*Resposta:* **Não pensou ainda.** Decisão adiada — só faz sentido quando
houver tração de números pra contar uma história. Hoje é cedo.

**Q17.** Modelo de negócio em 2 anos: só suas lojas / franquear Drope / vender SaaS pra outras tabacarias / outro?
*Resposta:* **Misto + oportunista.** Algumas lojas próprias + SaaS pra
outros + qualquer modelo novo que aparecer fizer sentido.

**→ Princípio: flexibilidade estratégica > fórmula fixa. Não se prende a
um modelo único. Encaixa com Q14 ("não estagnar").**

**Q18.** Expansão geográfica: ficar em SP, espalhar pelo Brasil, sair do Brasil?
*Resposta:* **Vila Prudente → São Paulo → Brasil.** Sem ambição
internacional por enquanto. Crescimento em camadas, do conhecido pro
nacional.

---

### Bloco 4 — O que você NÃO NEGOCIA (princípios)

**Q19.** O que o Drope NUNCA vai vender (produto, serviço, dado)?
*Resposta:* **"Nunca vou vender meu motor, sempre o carro pronto pra
funcionar."**

- **Motor** (núcleo tech, arquitetura IA-centro, template multi-vertical,
  método): NUNCA vende. Não licencia código-fonte, não faz white-label
  aberto, não abre o capô.
- **Carro pronto** (loja, SaaS rodando, experiência fim-a-fim): vende,
  aluga, distribui.

**→ Princípio não-negociável #1: MOAT. O motor é o ativo replicável
infinito. O carro é a entrega.** Clarifica Q17: quando vier SaaS, o cliente
aluga o carro, nunca leva o motor pra casa.

**Q20.** O que o Drope NUNCA vai fazer no atendimento ao cliente?
*Resposta:* Não tem lista formada ainda — mas declarou **duas referências
de inspiração**:

- **Nubank** → simplicidade radical, cliente tratado como quem alimenta a
  casa. Resposta rápida, linguagem humana, decisão a favor do cliente em
  caso de dúvida.
- **Habib's** → mais barato possível com qualidade aceitável pra estratégia.
  É **valor** (cliente sente que pagou justo), não "barato e ruim".

**→ Esqueleto provisório do "nunca": nunca complicar o que pode ser simples
(Nubank), nunca cobrar acima do justo pro segmento (Habib's). A definir
formalmente em revisão futura.**

**Q21.** Qual valor o Drope NUNCA abre mão, mesmo se custar dinheiro?
*Resposta:* **QUALIDADE.** Andrade aceita pagar o custo de tempo pra
entregar qualidade. "Por mais que isso tome meu tempo."

**→ Não-negociável #2: qualidade > velocidade, qualidade > conveniência
própria.**

**→ Amarra muita coisa:**
- O "carro pronto" (Q19) só vale se o carro for bom.
- O Habib's (Q20) só funciona porque a qualidade entrega o valor.
- O "IA facilitando" (âncora) só serve se a IA fizer bem feito.

**Q22.** Que decisões a IA PODE tomar sozinha (sem te perguntar)?
*Resposta:* Andrade abriu a porta filosófica: a resposta operacional vem
do princípio. Critério provisório a partir do princípio do servo:
**a IA pode decidir sozinha tudo que é serviço puro** (sem julgamento
moral, sem mexer em dinheiro do cliente, sem mudar estado do mundo de
forma difícil de reverter).

Lista concreta a definir em sessão dedicada à filosofia.

**→ Ver "Princípio não-negociável #3: IA-servo" mais abaixo na Q22-23.**

**Q23.** Que decisões a IA NUNCA pode tomar sem você?
*Resposta:* **Por default, NENHUMA. A autonomia é ligada por toggle,
comportamento a comportamento.**

### ⭐ PRINCÍPIO NÃO-NEGOCIÁVEL #4 — Autonomia Progressiva

A IA tem dois modos, e começa sempre no primeiro:

1. **Modo Servo (default)** — IA apresenta opções, análise, sugestões.
   Andrade decide. Ela serve servindo o cardápio, ele escolhe o prato.
   Toda função nova nasce aqui.
2. **Modo Autônomo (por toggle granular)** — Pra cada comportamento, tem
   um botão "automatizar sem você a partir daqui". Quando Andrade viu o
   suficiente da IA naquele domínio pra confiar, ele liga. Reversível,
   granular, opt-in.

**Por que isso é estrutural pro motor inteiro:**
- Resolve a tensão das Q10 (delegar tudo) ↔ Q22 (IA-servo): a autonomia
  é o pacto entre criador e ferramenta — ela é servo até ganhar o direito
  específico de agir sozinha naquilo.
- **Vira feature reutilizável do motor (Q19).** Não é exclusivo de
  tabacaria — é arquitetura que serve os 30 projetos futuros.
- Cada toggle ligado é uma decisão consciente do criador: "essa parte eu
  já moldei o suficiente, pode soltar."

**Q24.** Quando o Drope crescer 10x, o que TEM que continuar igual (não pode escalar à custa disso)?
*Resposta:* **A pergunta.** A única coisa que não pode mudar é a IA
perguntando pra si mesma, sem parar: *"Estou fazendo o meu melhor aqui?"*

Tudo o mais pode mudar — código, features, time, paleta, modelo, faturamento.
Mas essa pergunta é o **batimento cardíaco**. É o que mantém o motor
**vivo, não só funcionando.**

### ⭐ PRINCÍPIO NÃO-NEGOCIÁVEL #5 — O Motor Vivo

Drope é um **organismo vivo: motor que se regenera, se cura, se aperfeiçoa
sem intervenção humana.** Diferente de software que só roda — é software
que **se pergunta**, e por se perguntar, melhora.

Movido por:
- **A pergunta permanente** ("estou fazendo o meu melhor aqui?") como
  motor da auto-melhora.
- **Auto-regeneração, auto-cura, auto-aperfeiçoamento** sem que o criador
  precise intervir.
- **Freio do criador sempre disponível** nas configurações do sistema —
  Andrade pode barrar qualquer comportamento a qualquer momento.

**→ Fecha o pacto da Autonomia Progressiva (Q23):** a IA é autônoma
quando o criador libera + freio sempre acessível. Em nenhum momento ela
escapa do criador.

---

### Bloco 5 — O que está TRAVANDO (bloqueios reais)

**Q25.** Qual a maior dúvida TÉCNICA que você tem hoje?
*Resposta:* **"Por onde eu volto a botar a mão?"** Os arquivos vieram do
Windows pelo Drive, agora está no Mac, olha pra pasta e não sabe nem por
onde começar nem o que estava acontecendo antes.

**→ Bloqueio técnico #1.** É exatamente o que a Fase 1 resolve: Vercel CLI,
`vercel link`, `vercel env pull`, `vercel dev`. 15-30 min e Andrade está de
volta no mesmo ponto que estava no Windows, agora no Mac. Executar logo
após as 30 perguntas.

**Q26.** Qual a maior dúvida de NEGÓCIO que você tem hoje?
*Resposta:* **Como escalar via marketing depois que o produto estiver
pronto.** Hipóteses já formadas: Instagram, Fórmula de Lançamento.

**→ Observação pra síntese:** provavelmente são DUAS estratégias paralelas,
não uma:
- **Drope-tabacaria-local** → Instagram orgânico, boca-a-boca Vila Prudente,
  conversão do cliente físico pro app. Fórmula de Lançamento não encaixa
  bem (não é produto digital).
- **Drope-carro-pronto-SaaS** (Q17) → Aí Fórmula de Lançamento e Instagram
  funcionam bem, é venda de produto digital pra outros donos de tabacaria.

**Q27.** O que você está adiando há mais de 2 semanas? Por quê?
*Resposta:* **Marketing.** Instagram existe mas não está se movendo. E o
ponto sensível: *"to sentindo que não tô avançando nada"*.

**→ Diagnóstico (pra síntese):**
- Marketing está fora da zona de conforto técnica do Andrade.
- O produto (14k linhas de webhook, esteira, 19 migrations) consome todo
  o oxigênio. Resultado: muito feito no código, pouco no negócio.
- **Armadilha clássica do fundador-técnico:** esperar o produto ficar
  "pronto" pra começar marketing. Produto nunca está pronto — sempre tem
  o próximo osso.
- **Tensão honesta com Q14:** princípio é "não estagnar" + sensação real
  é de estagnação. O alarme interno está funcionando.

**Q28.** O que você não sabe fazer e vai precisar aprender ou contratar?
*Resposta:* **"Ainda não sei — pra mim, com a IA, eu vou conseguir tudo."**

Aposta consistente com os princípios (Q10, Q22, Q23). A IA realmente
tampa muita coisa (design, copy, SQL, código).

**→ Asterisco a manter no radar:** a IA executa o trabalho, mas não
substitui o **julgamento** (taste, leitura de cliente, fechar venda,
saber se a saída tá boa). Julgamento só se desenvolve fazendo. A aposta
funciona se Andrade FOR fazer **com** a IA, não esperar a IA fazer **por**
ele.

**Q29.** Quanto de dinheiro do seu bolso você consegue colocar até o Drope se pagar?
*Resposta:* **~R$ 5k agora**, mais depois conforme o caixa da operação
permitir. Pista curta de imediato, combustível contínuo entrando da
tabacaria física.

**→ Implicação:** orçamento exige cada R$ gasto em infra/marketing/APIs
ser pensado. Sem fôlego de queimar. R$ 1.500/mês de stack (Q11) já come
30% da pista mensal.

**Q30.** Prazo limite: quando o Drope TEM que estar dando lucro? (mês/ano)
*Resposta:* **Sem prazo.** *"Pode ser no tempo que Deus quiser. Eu só
quero plantar e nunca parar de plantar — lembre disso."*

### ⭐ PRINCÍPIO NÃO-NEGOCIÁVEL #6 — Plantar sem parar

O Drope não tem prazo de colheita. Tem **compromisso com a semeadura**.

- Não tem urgência ansiosa. Tem **disciplina permanente**.
- A pergunta diária não é "já lucrou?", é **"hoje eu plantei?"**.
- Casa com Q14 ("não estagnar") — não estagnar é não parar de plantar.
- Casa com Q21 ("qualidade > velocidade") — plantar bem feito > rápido.
- Casa com Q24 ("motor vivo") — motor vivo é motor que sempre planta.
- Casa com Q22 ("IA-servo") — a IA também planta, ao lado do criador.

**→ Este é o princípio que dá RITMO aos outros cinco. Os outros são o quê
e o como. Este é o tempo.**

Andrade pediu: *"lembre disso."* — pedido honrado.

---

---

# Síntese — onde estamos, pra onde vamos, como chegar

## 1. Onde estamos hoje (17/05/2026)

**Operação física consolidada, canal digital ainda mudo.**

- 60 vendas/dia no balcão (10 pods + 50 tabacaria geral).
- +1000 clientes únicos na base. Não é loja nova, é base real.
- +100 SKUs no catálogo (sabor × modelo).
- 5 motoboys ativos no grupo.
- Time: Andrade + Yasmin + família + IA. Sem digital fora do Andrade.
- Faturamento: R$ 5k+/mês (a refinar).
- Custo de stack: R$ 1.500/mês (boa parte APIs de IA).
- **Zero venda pelo app.** Toda receita vem do físico.
- Repositório com 14k linhas de webhook.js, esteira de cadastro automática
  rodando, 19 migrations aplicadas, deploy ativo no Vercel.
- **Sensação relatada:** estagnação. Andrade sente que não está
  avançando, apesar de muito feito no código.

## 2. Onde queremos chegar em 90 dias

- **100+ vendas/dia** (≈ 2x o atual), com app convertendo de verdade pela
  primeira vez. Crescimento puxado pelo digital, não pelo balcão.
- **Tese da trindade saindo do papel:** app completo, IA rodando o que dá
  pra rodar, arquitetura já pensada pra virar SaaS.
- **Delegação máxima da operação pra IA** — Andrade no comando, IA no
  trabalho.
- **Sem novas contratações.** Time igual + IA carrega o crescimento.
- **Custo aceitável** crescendo proporcional ao faturamento.
- **Marketing destravado** — Instagram saindo do limbo, primeiros
  experimentos rodando.

## 3. Onde queremos chegar em 2 anos

- **Empresa avançando, sem estagnar.** Não fica preso num projeto só.
- **R$ 1M+/mês** de faturamento somando tudo.
- **Vários projetos no ar** (apetite de ~30, número flexível) — Drope é
  o primeiro de uma fábrica.
- **Andrade como CEO**, time embaixo, pouco código direto.
- **Modelo misto + oportunista:** lojas próprias + SaaS pra outros donos
  + qualquer modelo novo que aparecer fizer sentido.
- **Cobertura geográfica:** Brasil. Sem ambição internacional por enquanto.
- **Decisão de investimento adiada** até ter números pra contar história.

## 4. Os 6 princípios não-negociáveis (a constituição do Drope)

1. **Trindade IA-centro** — A IA é o centro do sistema, servindo
   Andrade (operador) e o próximo (cliente) ao mesmo tempo.
2. **Qualidade > velocidade** — Andrade paga em tempo, não corta qualidade.
3. **Motor vs. carro** — Nunca vende o motor (núcleo tech). Vende o carro
   pronto (loja, SaaS, experiência fim-a-fim).
4. **Autonomia progressiva** — IA serve por default (apresenta opções,
   Andrade decide). Autonomia plena só por toggle granular, comportamento
   a comportamento, liberada pelo criador.
5. **O motor vivo** — A IA se pergunta sem parar *"estou fazendo o meu
   melhor aqui?"*. Auto-regenera, auto-cura, auto-aperfeiçoa. Freio do
   criador sempre disponível.
6. **Plantar sem parar** — Sem prazo de colheita. Compromisso permanente
   com a semeadura. A pergunta diária é "hoje eu plantei?", não "já
   lucrou?".

E o **princípio-âncora** que costura todos: *A IA tem que facilitar a vida
do Andrade E a vida do cliente, ao mesmo tempo.*

## 5. Bloqueios pra destravar primeiro (ordem real)

### Bloqueio 1 — Andrade não consegue voltar a codar (urgência alta, atrito baixo)
Os arquivos vieram do Windows pro Mac, e Andrade está paralisado olhando
pra pasta sem saber por onde recomeçar.
- **Custo:** 30 min e R$ 0.
- **Destravamento:** **Fase 1** (CRLF + Vercel CLI + env pull + dev).

### Bloqueio 2 — App não converte uma única venda (urgência alta, atrito médio)
Operação física com 60/dia, app com 0/dia. Tese da trindade não está sendo
testada com cliente real.
- **Custo:** 1-2 semanas focado.
- **Destravamento:** levar o app pra ser oferecido ATIVAMENTE no balcão.
  Toda venda física = oportunidade de cliente baixar o app e fazer a próxima
  compra digital. Conversão da base já existente. **Não precisa marketing
  novo pra primeiros 100 clientes do app — precisa converter os 1000 que
  já vêm na loja.**

### Bloqueio 3 — Sensação de estagnação (urgência psicológica alta)
Andrade sente que não avança apesar de muito feito no código. Marketing
parado, Instagram inerte.
- **Custo:** ritmo, não dinheiro.
- **Destravamento:** estabelecer um **ritual semanal de plantio** (alinha
  com Princípio #6). Toda segunda, 3 perguntas: "o que plantei semana
  passada? que sinal de vida apareceu? o que vou plantar essa semana?".
  Pode ser literal — anota em arquivo, depois delega pra IA gerar o
  relatório.

### Bloqueio 4 — Doutrina IA-servo não está formalizada (urgência baixa, importância alta)
Andrade plantou o conceito, mas os "ministérios" e a fronteira da
autonomia precisam ser destrinchados pra virar regra de código.
- **Custo:** 1-2 sessões dedicadas.
- **Destravamento:** sessão separada (já marcada na lista de tarefas).

### Bloqueio 5 — Marketing parado (urgência média, atrito alto)
Instagram existe e não anda. Andrade fora da zona de conforto, e tem a
armadilha de "esperar produto ficar pronto".
- **Custo:** mais coragem que dinheiro.
- **Destravamento:** **separar duas estratégias** (Q26):
  - **Drope-tabacaria-local** → orgânico, Vila Prudente, conversão do
    cliente físico. Não usa Fórmula de Lançamento.
  - **Drope-SaaS-futuro** → Fórmula de Lançamento + Instagram orientado
    a dono de tabacaria. Mas só vale começar quando o carro estiver
    pronto pra ser vendido.

## 6. Caminho proposto — próximos 90 dias

### Mês 1 — Destravar e respirar
- **Semana 1:** Fase 1 (Mac de volta no ar). Síntese consumida com calma.
- **Semana 2:** Sessão IA-servo + ministérios. Formalizar a doutrina.
- **Semana 3:** Catálogo do app revisado. Pelo menos 10 SKUs com arte e
  preço A+ (não A-) prontos pra cliente real comprar.
- **Semana 4:** App oferecido ATIVAMENTE no balcão. Yasmin treinada pra
  oferecer ("paga e baixa o app, próxima compra ganha X").

### Mês 2 — Primeiros 100 do digital
- Meta: **100 vendas pelo app no mês.** Saí do zero.
- Mecânica de retorno: cliente que compra pelo app uma vez, recebe
  alguma puxada (cupom, status especial, qualquer coisa que faça ele
  voltar).
- Instagram desperta: 3 posts/semana, conteúdo orgânico de Vila
  Prudente, sem produção pesada.

### Mês 3 — Provar a tese
- Meta: **20 vendas/dia pelo app** (1/3 das vendas totais já digitais).
- Quebra do `api/webhook.js` em módulos por domínio. Preparação pro
  motor virar template.
- Decisão sobre **investimento** — agora com números pra basear.

### Ritual permanente (Princípio #6)
- **Toda segunda 09h:** "o que plantei? o que floresceu? o que planto?".
  No início, Andrade escreve. Em 90 dias, delega pra IA que prepara o
  relatório e ele só comenta.

---

## Versão para imprimir e colar na parede

> **Drope é a primeira encarnação de uma tese:** software se constrói
> com IA no centro, servindo dois lados (criador e cliente) ao mesmo
> tempo.
>
> A IA é serva, não dona. Apresenta opções, decide só quando o criador
> libera, e nunca para de se perguntar se está fazendo o seu melhor.
>
> O motor é meu — sempre. O carro pronto é o que vendo.
>
> Qualidade vem antes de velocidade. Plantar vem antes de colher.
> Nunca paro de plantar.
