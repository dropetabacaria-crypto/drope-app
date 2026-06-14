# DROPE — Fricções/Melhorias identificadas no Teste E2E

Lista crua do que Andrade quer mudar/melhorar no app, capturada durante teste E2E em 02/06/2026.

**Modo:** captura primeiro, análise depois. Cada item é registrado como foi reportado, sem julgamento de prioridade ainda. Quando o Andrade sinalizar "mandei tudo", a gente revisa item a item em conjunto.

---

## Status de execução (02/06/2026)

Decisão tomada: resolver os 9 itens antes do lançamento. Nova data alvo: 12/06/2026.

| # | Item | Status |
|---|---|---|
| 4-bugs | "null puffs" + "r$ 0" | ✅ Resolvido (detail + tile + botão) |
| 5 | Indicador de estoque na detalhe | ✅ Resolvido |
| 7 | ViaCEP autocomplete + UF select | ✅ Resolvido (overwrite + select 27 estados + compat com endereços antigos) |
| 2 | Chips de vibe → catálogo fluido | ⏳ Pendente |
| 3 | Filtro inteligente do catálogo | ⏳ Pendente |
| 8 | Erro no Pix rápido | ⏳ Pendente (precisa debug) |
| 6 | Fluxo pós-add (modal vs catálogo) | ⏳ Pendente (precisa decisão) |
| 4-conteúdo | Mais info no produto | ⏳ Pendente (precisa redação) |
| 9 | Modo teste pro dono | ⏳ Pendente |
| 1 | Logo splash | 📌 Postergado (pós-lançamento) |

---

## #001 — Tela de logotipo (splash)

Andrade quer reavaliar a logo atual e ver se há algo melhor. Anotação dele: *"Tela logotipo, trocar e ver se ese é bom."*

---

## #002 — Chips de vibe (home) devem filtrar catálogo fluidamente

Os chips no topo da home — "frutado", "doce", "gelado", "mentol" — atualmente parecem não conectar com a seção "Catálogo" logo abaixo. Andrade quer que ao clicar num desses chips, o catálogo abaixo já filtre/flua mostrando os produtos daquela vibe de forma fluida.

Anotação dele: *"Quero que aqui, ao clicar la em cima, frutado, gelado, doce, mentol, tenha a opção de ja fluir o catalogo desses que foram escolhidos no card em baixo, logo abaixo como algo fluido entende?"*

Evidência: screenshot da home mostrando chips no topo + catálogo separado com filtros próprios embaixo, sem ligação entre os dois.

---

## #003 — Filtro do Catálogo: trocar duplicação de vibe por filtro inteligente

Logo abaixo do título "Catálogo / o que dropou hoje" tem uma fileira de chips (tudo / frutado / mentolado / gelado / [ícone de filtro]) que basicamente replica os chips de vibe do topo. Andrade quer trocar isso por um **filtro inteligente e simples** com critérios mais úteis pro cliente decidir: **marcas, quantidade de puffs, modelos, sabor**.

Anotação dele: *"Embaixo onde esta escrito catalogo, tem o o mesmo card do que esta acima? Poderia ser um filtro, entre marcas, quantidade de puffs, modelos, sabor, um filtro inteligente que ajudasse o cliente e que fosse simples o mecanismo de busca."*

Relacionado: este item dialoga com o #002 (se a vibe já vier dos chips de cima, o catálogo embaixo não precisa repetir e pode focar em filtros mais granulares).

---

## #004 — Tela de detalhe do produto está muito enxuta de informação

A tela de detalhe (ex.: "ELFBAR BC PRO Grape Twist") mostra hoje só: imagem, nome, 3 tags (marca, puffs, sabor), preço, badge de pagamento, stepper de quantidade. Andrade quer mais informação sobre o **modelo, sabor, uma pitada de curiosidade/storytelling** — algo que complemente sem ficar pesado. Princípio: simples MAS virtuoso, com qualidade.

Anotação dele: *"Aqui acho já muita pouca informação poderia ter mais informações a respeito do modelo a respeito do sabor é um pouquinho de curiosidade sei lá fomos estudar pra ver o que pode ser complementar pra deixar simples mas também virtuoso uma coisa com qualidade."*

Bugs adicionais visíveis no mesmo screenshot (talvez devam virar items próprios depois, mas anoto aqui pra não perder):
- **"null puffs"** aparece como tag (campo vazio sendo renderizado literalmente)
- **"r$ 0"** preço aparece zero (produto sem preço cadastrado vazando pro cliente)

---

## #005 — Tela de detalhe não indica estoque disponível

Na tela do produto, o stepper (+/-) permite aumentar a quantidade indefinidamente sem mostrar quanto tem em estoque. Cliente pode tentar levar 10 unidades sem saber que só tem 2 disponíveis, e só descobre depois (no checkout? ao tentar pagar?) que não tem.

Anotação dele: *"Não há nada indicando quantas quantidade o pessoal tem no estoque do produto então eu tô colocando várias quantidades aqui vou levar várias quantidades mas não tem nada indicando que tem estoque."*

Evidência: screenshot do ELFBAR BC15K Blue Razz Ice com stepper em "3" e nenhum indicador de estoque visível.

---

## #006 — Fluxo após "quero levar" — questionar o modal de confirmação

Hoje ao clicar em "quero levar" abre um modal/sheet com confirmação ("ELFBAR BC15K Blue Razz Ice adicionado ✓ — 4 itens no carrinho ✦ r$ 239,96") e dois botões: "continuar comprando" e "ir pro pagamento ✦".

Andrade tá em dúvida sobre a UX certa aqui:
- Forçar o cliente a voltar pra outra tela pra continuar comprando?
- Renomear o botão "quero levar" pra algo como "adicionar ao carrinho" (sem modal) vs "comprar direto" (vai pro checkout)?
- Voltar automaticamente pro catálogo após adicionar?

Ele mesmo escreveu: *"tem que pensar nisso daí entendeu"* — ou seja, isto vai exigir uma reflexão de design quando a gente entrar na fase de análise. Não é decisão tomada ainda.

Anotação dele: *"Clique em quero levar a apareceu essa tela não sei mas eu fiquei pensando e se obrigasse o cliente ia voltar pra outra tela pra fazer mais compras não sei se funciona assim não sei se essa estratégia funcionar ele só voltasse pra lá tem que pensar o que acontece teria que pensar se quando ele coloca quero levar se eu coloco na tela algo como adicionar o carrinho ou já adicionar aí pra compra direto não forçando ele a voltar pra tela onde tem mais produtos eu tô pensando ele deve voltar pra tela onde tem mais produtos que eu tenho que pensar nisso daí entendeu."*

---

## #007 — Cadastro de endereço: autocomplete por CEP + campos pré-selecionados

Na tela "Novo endereço", quando o cliente preenche o CEP, os campos Rua, Bairro, Cidade e UF deveriam **auto-preencher** automaticamente (via integração tipo ViaCEP ou BrasilAPI). Hoje o cliente tem que digitar tudo manualmente mesmo depois de informar o CEP.

Complemento do Andrade (segunda mensagem reforçando o ponto): também quer **campos com seleção** (dropdowns/selects) em vez de só texto livre — ele citou que ninguém deveria ter que escrever "São Paulo" do zero; UF também tinha que ter seletor. A ideia geral é: depois do CEP, tudo já vem preenchido E os campos que sobrarem (UF, talvez Cidade) são selects, não input livre.

Anotações dele:
- *"Não sei se é possível mas quando eu colocar o cep já automaticamente vir o endereço completo do cliente."*
- *"Pensei em Campos já selecionados entendeu que a gente tem que escrever São Paulo não tem os campos pra pra selecionar ela também aparecer com a pessoa colocou o cep entendeu."*

Evidência: screenshots do formulário "Novo endereço" com CEP 02122-990 preenchido mas Rua, Bairro, Cidade e UF todos em estado de placeholder/digitado manualmente ("rua tralalala", "vila luz", "sao paulo", "sp").

---

## #008 — Erro no "Pagar direto" (Pix rápido)

Na tela de pagamento, o fluxo "Pagar direto" (recomendado, Pix/cartão/saldo sem sair do app) tá com erro. O sistema detectou e fez fallback gracioso pro Pix manual com a mensagem **"erro no pagamento rápido — usa o Pix manual"** mostrada como toast/aviso no rodapé.

Cliente ainda consegue completar a compra via Pix manual (QR code + copia e cola + botão "já paguei, mandar comprovante"), mas o fluxo "premium" tá quebrado.

Anotação dele: *"Erro no pagamento"*

Evidência: screenshot do checkout em "2. pagamento" mostrando:
- Total: r$ 239,96
- Botão amarelo "pagar agora" (recomendado, com texto "dados já preenchidos ✦")
- QR Code do Pix manual com chave CNPJ 32486582000154 (Lucas de Andrade Sousa)
- Aviso no rodapé: "erro no pagamento rápido — usa o Pix manual"

Provavelmente relacionado a alguma integração com InfinitePay ou Mercado Pago que está falhando/sem token. Requer investigação no webhook.js / endpoint de geração de link de pagamento.

---

## #012 — Dashboard admin precisa de auditoria UX (tirar ruído, deixar só essencial)

Reportado em 03/06 durante cadastro pelo scanner.

**O que:** o dashboard admin tem muitos botões, alguns redundantes ou pouco usados. Andrade quer:
- Tirar o que não importa
- Deixar só o essencial pro fluxo dele
- Adicionar atalhos pro que ele USA de verdade (ex.: gallery de aprovar artes — hoje é só URL solta)

**Exemplo concreto mencionado por ele:** "esse negócio agora de ver a arte e aceitar ela é importante de estar aqui pra mim poder escolher, entendeu, mas não tá".

**Ação futura:**
1. Auditar todos os botões do dashboard (linha ~3860-3902 do index.html)
2. Conversar com Andrade pra mapear: usa MUITO / usa às vezes / nunca usa
3. Reorganizar: tier 1 (botões grandes/destaque), tier 2 (botões médios), tier 3 (esconder em "mais opções")
4. Adicionar **"🎨 aprovar artes pendentes"** com badge mostrando quantas tem (similar ao "4 dropes com estoque baixo")
5. Link direto pra gallery com token já embutido

**Não fazer agora.** Andrade explicitamente disse pra deixar pra depois pra não distrair do cadastro em andamento.

---

## #010 — Vision: nome do sabor em PT precisa ser MARKETING, não tradução literal

Reportado em 02/06 durante cadastro pelo scanner.

**O que:** quando a Vision identifica o sabor de uma caixa em inglês (ex "Sour Apple Ice"), ela traduz literal demais ("Maçã Verde Azeda Gelada"). Andrade quer nome com vibe atrativa, marketing Gen Z brasileiro.

**Onde corrigir:** prompt do `analyzeProductImage` em `api/webhook.js` linha 4250.

Anotação dele: *"Eu acho que na hora que o claude vision identificar, o nome do sabor precisa ser pesquisado, pra poder colocar de uma maneira atraente, não a tradução do sabor, mas o sabor real em linguagem atraente."*

**Mitigação por hora:** Andrade edita o campo "sabor" na tela do scanner antes de confirmar, deixando mais atrativo manualmente.

---

## #011 — Auto-transformação de preço pra .99 (psicológico)

Reportado em 02/06 durante cadastro pelo scanner.

**O que:** quando preço digitado for redondo (80, 90, 100), transformar automaticamente em 79.99, 89.99, 99.99 antes de salvar. Truque clássico de pricing psicológico.

**Regra exata:** se `price === Math.floor(price)` (sem decimais), subtrair 0.01.

**Onde implementar:** 2 lugares
- Frontend (`receber.html` `confirmRegister()`) — transforma antes do POST, mostra no preview
- Backend (`api/webhook.js` `quick_register` handler) — defesa, transforma se vier redondo

Anotação dele: *"sempre quando eu digitar o preço cheio de 80, 90, transformar automaticamente para 79,99 ou 89,99 no catálogo."*

**Mitigação por hora:** Andrade já digita .99 manual no scanner.

---

## #009 — Sem modo teste — não dá pra simular fluxo até confirmação sem pagar de verdade

Andrade conseguiu chegar até a tela de pagamento Pix (passo 2 do checkout) mas não conseguiu testar as telas seguintes (passo 3 "confirmar" + tela final) porque o avanço depende de pagamento real (clicar "já paguei, mandar comprovante" presumivelmente exige comprovante real OU validação no backend de que o Pix chegou).

Isso bloqueia o teste E2E completo do dono — quem quiser auditar o fluxo do app **precisa de um modo teste / bypass de pagamento** OU precisa fazer 1 compra real de verdade (mesmo que seja R$ 1 simbólico).

Anotação dele: *"depois nao consigui ir pra proxima tela por que nao deu pra testar o pagamento."*

Sugestão prévia (não decisão): criar um cupom mágico tipo `TESTE100OFF` que zera o total e libera fluxo até confirmação, OU detectar pelo admin token / IP e dar passe livre.

---
