# MIRA — Blueprint do Projeto (a planta, antes do código)

> Nome provisório: **MIRA** — a mira que aponta a hora de puxar o gatilho.
> Documento vivo. Andrade decide no chat, este arquivo é o registro.
> Projeto derivado do **motor do Drope** — outro carro, mesmo motor.
> Criado em: 09/06/2026.

---

## O que é (a visão, na voz do Andrade)

Um **conselheiro de operação com opções**. Todo dia ele estuda o gráfico (diário e
semanal), as notícias, o fundamento e o histórico da empresa, cruza tudo, reconhece
os padrões que no passado precederam **explosões direcionais**, e te diz:

> "Hoje, pelo que o gráfico e os dados mostram, compensa entrar aqui — está alinhado
> com a estratégia, no passado isso deu tal movimento, então você tem X% de chance,
> e o risco-retorno é de pelo menos 3 pra 1."

E não para na entrada: **fica de olho todos os dias pra te avisar a hora de sair.**

Ele é **copiloto** — sugere, você decide. Serve **só o Andrade** (sem cliente do outro
lado; é um sistema pessoal, como o Ministério do Conselheiro do Drope).

---

## Princípios herdados do Drope (a constituição replicada)

A **Constituição da IA-Servo** é replicada aqui letra por letra. Em especial:

1. **IA-Servo** — a IA apresenta, o Andrade decide. Grandeza vem da qualidade do serviço.
2. **Qualidade > velocidade** — planta bem feito antes de rápido.
3. **Motor vs. carro** — o motor (método, arquitetura) é do Andrade, sempre.
4. **Autonomia progressiva** — tudo nasce no modo Servo; autonomia só por toggle granular.
5. **Motor vivo** — o sistema se pergunta *"estou fazendo o meu melhor aqui?"*.
6. **Plantar sem parar** — aqui isso vira o **modo sombra**: planta (testa sem dinheiro)
   antes de colher (operar de verdade). Não inverte como aconteceu no Drope.

---

## As 8 camadas (o pipeline: dado bruto → decisão confiável)

### Camada 0 — Propósito & Sucesso
- **A decisão que ele existe pra ajudar:** entrar ou não numa operação, e quando sair.
- **Sucesso (a medir):** track record honesto do modo sombra — taxa de acerto real,
  retorno médio por tiro, e se o "X%" prometido bate com a realidade (calibração).
- **Papel:** copiloto. Pode ganhar autonomia em pontos específicos por toggle, com o tempo.

### Camada 1 — Dados (a matéria-prima)
- **Mercado:** Brasil primeiro. Arquitetura **plugável** pra adicionar mercado
  internacional e outras fontes depois, sem refazer (camadas, igual Drope: local → nacional).
- **Ativos:** começar pelos de opção líquida na B3 (PETR4, VALE3, índice via BOVA11,
  alguns bancos). *A escolher o primeiro alvo.*
- **Histórico:** o **máximo** que se conseguir achar (quanto mais fundo, mais padrão).
- **Os 4 tipos de dado:** preço/gráfico, notícia, fundamentalista, **e a cadeia de opções
  com volatilidade implícita (IV)** — adicionada por blindagem do veterano.
- **Cadência:** notícia monitorada com frequência alta (explode a qualquer hora);
  gráfico lido nos momentos certos (fechamento do dia, virada da semana, espiadas no pregão).
- ⚠️ **Ponto de maior custo do projeto.** Dado histórico bom e confiável custa, e dado
  ruim ensina padrão errado. *Fonte e teto de gasto a definir.*

### Camada 2 — Análise (o cérebro, com a fronteira juízo-vs-conta)
Quatro motores + a regra de ouro de projeto-IA:

- **Técnico** — padrões de gráfico diário/semanal que precederam explosões.
- **Notícia** — o sistema **descobre dos dados** o que de fato move o preço (cruza tipo
  de notícia × movimento seguinte). Não chuta filtro.
- **Fundamento** — contabilidade/fundamentalista da empresa.
- **Padrão histórico** — analogias com momentos passados parecidos.
- **Volatilidade (IV)** — *blindagem crítica:* pra quem compra opção, IV importa mais que
  direção. Comprar IV cara (véspera de resultado) faz perder mesmo acertando a direção.
  O sistema mira **volatilidade barata + catalisador + setup técnico**, os três juntos.

**Fronteira juízo-vs-conta (regra de ouro):**
- A **IA (Claude)** faz o que é juízo: lê notícia, resume fundamento, sintetiza as frentes,
  explica o "porquê" em linguagem humana.
- O **código determinístico** faz o que é conta: probabilidade, gregas, IV, P&L, backtest.
- **A IA nunca calcula o número.** Ela opina e explica; a engine calcula. Isso é o que
  torna o veredito confiável.

### Camada 3 — Decisão & Probabilidade (o veredito)
- **Estratégia:** construída **a partir dos dados e do histórico** — não copiada de guru.
- **Modelo de risco do Andrade:** tiros de **R$100**, tudo-ou-nada, alvo **≥ 3 pra 1**.
- **A matemática que casa:** num 3:1, basta acertar **1 a cada 4** pra empatar. O sistema
  caça tiro com chance **bem acima** disso.
- **Probabilidade honesta (blindagem):** nada de "80%" com falsa precisão. Mostra **taxa
  de acerto real, com tamanho de amostra**, e os casos que furaram junto. Calibra com a vida.
- **Filtro de sinal:** abaixo de um limiar de qualidade, nem avisa. *Limiar a calibrar.*
- **Saída tão importante quanto a entrada:** ele também diz quando sair e quando **não** operar.

### Camada 4 — Interface & Entrega (onde você vê)
- **Painel web no computador** (reaproveita Vercel + Supabase do motor Drope).
- **Aviso ativo** quando aparece oportunidade quente — **notificação no PC** (canal principal).
- No veredito, mostra o **porquê destrinchado** (o raciocínio das frentes), não só a recomendação.

### Camada 5 — Aprendizado, Memória & Modo Sombra
- **Modo sombra (inegociável, primeiro passo):** 2-3 meses só **anotando** o que ele teria
  feito, montando track record honesto. Dinheiro real só entra quando os números provarem.
  É o Princípio #6 aplicado, e também a **bancada de avaliação da própria IA**.
- **Memória:** registra o resultado real de cada sinal e mede o próprio acerto no tempo.
- **Aprendizado:** *a decidir* — aprende com os trades e ajusta, ou fica fixo nas regras
  até o Andrade mandar mudar.

### Camada 6 — Governança (o espírito Drope)
- **Modos:** tudo nasce Servo; sobe pra autônomo só por toggle granular.
- **Gestão de banca:** banca inicial **R$3.000** (~30 tiros). **Dobra o tiro quando a banca
  dobra** — e o sistema acompanha a curva, mas **nunca sobe sozinho** (sugere, você confirma).
- **Freio (a calibrar):** botão de segurança ajustável — pausa e avisa após N perdas
  seguidas ou queda de X% da banca, com tempo de "esfriar a cabeça". *Parâmetros a definir.*
- **Limites duros (nunca, em hipótese alguma):**
  - **Nunca executa ordem sozinho** — quem clica na corretora é o Andrade.
  - Nunca movimenta dinheiro real.
  - Nunca mostra probabilidade inventada (sempre lastreada em dado).
  - Nunca esconde os casos que deram errado.

### Camada 7 — Motor, Custo & Sequência (como sai do papel)
- **Reaproveita o motor do Drope** — Supabase + Vercel + a arquitetura de ministérios.
  Custo marginal perto de zero. (Era o pedido original: economizar ao máximo.)
- **Custo de IA controlado:** código barato roda o tempo todo; a IA só é acionada quando
  há juízo a fazer (interpretar notícia, montar parecer). Evita estourar a conta de API.
- **Fatia fininha primeiro:** **um ativo, um setup, modo sombra.** Prova, depois expande.

---

## Os ministérios do MIRA (a mesma linguagem do Drope)

- 📊 **Acompanhamento** — puxa preço, cadeia de opções, IV, vigia notícia.
- 🧮 **Analista** — calcula P&L, payoff, gregas, probabilidade (conta determinística).
- 🧠 **Parecerista** — a IA que lê, sintetiza e explica o "porquê" (juízo).
- 🛡️ **Guardião** — liquidez, risco, freios, limites de perda.
- 📔 **Diário** — registra a tese e o resultado de cada tiro; alimenta a calibração.
- 📈 **Relatório** — track record do modo sombra e, depois, do real.

Todos nascem em **modo Servo**, com a pergunta permanente: *"estou fazendo o meu melhor aqui?"*

---

## O que já está FECHADO (decidido pelo Andrade)

- É um conselheiro de entrada **e** saída, copiloto, só pra ele.
- Estratégia construída dos dados, não de guru.
- Brasil primeiro, expansível.
- Histórico: o máximo possível.
- Risco: R$100/tiro, tudo-ou-≥3:1, banca R$3.000, dobra o tiro quando a banca dobra.
- Painel web no PC, com aviso por notificação no PC.
- Nunca executa ordem — quem clica é o Andrade.

## O que está A CALIBRAR / DECIDIR

- Primeiro ativo e primeiro setup da fatia fininha.
- Fonte de dados (histórico + IV) e o teto de gasto/mês.
- Parâmetros do freio (N perdas, % de queda, tempo de pausa).
- Limiar mínimo de qualidade do sinal.
- Se o sistema aprende e se ajusta sozinho, ou fica fixo até ordem.
- Apuração de imposto (IR sobre opções) e qual corretora pra execução.
- Outros limites duros além de "não executa".

---

## Sequência sugerida (jeito Drope: plantar antes de colher)

1. **Fatia fininha** — escolher 1 ativo líquido + 1 setup simples.
2. **Dados** — plugar histórico + cadeia de opções + IV desse 1 ativo.
3. **Engine de conta** — código que calcula sinal, probabilidade honesta e R:R.
4. **Parecerista (IA)** — Claude lê notícia/fundamento e monta o "porquê".
5. **Painel + alerta no PC** — o mínimo pra você ver e ser avisado.
6. **Modo sombra (2-3 meses)** — anota tudo, mede o acerto real, calibra.
7. **Só então:** primeiro R$100 de verdade — quando os números provarem.
8. **Expandir** — mais ativos, mais setups, e depois a porta do internacional.

---

## A verdade do veterano (colada na parede)

> Amador se apaixona pela entrada. Profissional vive da gestão da saída, do tamanho da
> aposta e do diário honesto. O 3:1 no papel vira menos no extrato por causa do spread —
> então só opere o líquido. A volatilidade importa mais que a direção. E o "80%" é a
> armadilha: prove o número no escuro antes de apostar a luz.
