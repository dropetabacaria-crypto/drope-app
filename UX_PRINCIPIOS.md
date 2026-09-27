# Princípios de UX do app — padrão "apps de sucesso"

> Instrução para o Claude Code: este arquivo define o padrão de experiência do sistema inteiro, com duas frentes de mesmo peso:
> - **App do cliente**: vitrine, carrinho, checkout, pagamento, acompanhamento do pedido e pós-venda (seção 3).
> - **Painel de gestão (admin)**: onde o dono e a equipe gerenciam pedidos, entregas, produtos, estoque, clientes e relatórios (seção 3B).
>
> Use este arquivo como referência obrigatória ao criar ou alterar qualquer tela, fluxo ou mensagem, nas duas frentes. Ao receber este arquivo pela primeira vez, faça a AUDITORIA descrita na seção 5 antes de escrever qualquer código, e apresente o plano priorizado para aprovação.

---

## 1. Objetivo

O app precisa passar a sensação de ser "gostoso de usar", no nível de iFood, Nubank e Mercado Livre. O cliente não compara o app com o concorrente direto. Compara com esses apps, que definem o que ele considera normal.

Regra central: **o cliente nunca precisa pensar, nunca espera e nunca leva susto.**

Toda decisão de produto passa por uma pergunta, a mesma que o Nubank usa: **"isso é bom para o cliente?"**

---

## 2. Dados que justificam as regras

- 70% dos carrinhos são abandonados em média (Baymard Institute, 50 estudos).
- Motivos principais do abandono:
  - custo extra que só aparece no final (frete, taxa): 40%
  - entrega lenta: 20%
  - desconfiança no pagamento: 19%
  - cadastro obrigatório: 18%
  - checkout longo ou confuso: 17%
- Só melhorando o checkout, a conversão pode subir cerca de 35%. O checkout médio tem 23 campos; o ideal fica entre 12 e 14.
- 53% dos usuários abandonam uma página no celular que leva mais de 3 segundos para carregar (Google).
- O 1-Click da Amazon (patente de 1999) era tão valioso que a Apple pagou licença para usar. Cada toque a menos vale dinheiro.

---

## 3. As 10 regras (obrigatórias)

### R1. Poucos toques até o objetivo
- Da abertura do app até o pedido pago: no máximo 3 a 4 telas.
- Adicionar ao carrinho sem sair da vitrine (botão "+" direto no card do produto).
- Nenhum campo que não seja indispensável para entregar ou cobrar.
- Pré-preencher tudo o que já se sabe (endereço anterior, último pagamento, nome).

### R2. Preço total visível antes do checkout
- Frete, taxa e tempo estimado de entrega aparecem ANTES de finalizar: no carrinho e, se possível, já na vitrine.
- Proibido surgir valor novo na última tela.
- Mostrar o resumo do total sempre fixo na parte de baixo do carrinho.

### R3. Comprar sem cadastro longo
- Login por telefone com código por SMS/WhatsApp, ou Google/Apple. Sem senha obrigatória.
- Pedir só o que é necessário para o primeiro pedido. Completar o perfil depois, aos poucos.
- Nunca bloquear a navegação da vitrine atrás de login. O login entra só na hora de finalizar.

### R4. Pagamento que o brasileiro já usa
- Pix como opção principal: QR Code + botão "copiar código" + confirmação automática (webhook), sem o cliente enviar comprovante.
- Cartão salvo para as próximas compras (tokenizado pelo gateway, nunca guardar número do cartão no banco).
- Tela de "aguardando Pix" com contagem regressiva e atualização automática quando o pagamento cair.

### R5. Velocidade real e percebida
- Carregamento inicial rápido. Imagens otimizadas (WebP, tamanhos corretos, lazy loading).
- Skeleton screens (esqueleto cinza) no lugar de tela branca ou spinner solto.
- UI otimista: o botão responde na hora (item aparece no carrinho imediatamente) e sincroniza com o servidor em segundo plano, revertendo com aviso se falhar.
- Todo toque deve ter feedback visual em menos de 100 ms.

### R6. Transparência em tempo real
- Status do pedido em etapas claras: Pedido recebido > Pagamento confirmado > Separando > Saiu para entrega > Entregue.
- Atualização em tempo real (Supabase Realtime ou equivalente) e notificação push a cada mudança de etapa.
- Quando houver entregador (próprio, Lalamove ou Uber), mostrar nome, veículo e link de rastreio.
- Esperar sabendo o que está acontecendo incomoda muito menos que esperar no escuro.

### R7. Controle na mão do cliente
- O cliente resolve sozinho, sem precisar chamar ninguém: cancelar pedido (dentro da regra), trocar endereço antes do envio, ver histórico, repetir pedido, baixar comprovante.
- Botão "Pedir de novo" em cada pedido do histórico, levando direto ao carrinho montado.

### R8. Microdetalhes que dão prazer
- Animação curta e elegante ao adicionar ao carrinho e ao confirmar o pedido (sem exagero, máx. ~600 ms).
- Vibração leve (haptic) em ações importantes no celular.
- Textos humanos e simples, falando como uma pessoa. Exemplos:
  - Ruim: "Erro 402: falha na transação."
  - Bom: "O pagamento não passou. Quer tentar de novo ou usar Pix?"
  - Ruim: "Carrinho vazio."
  - Bom: "Seu carrinho está vazio. Que tal dar uma olhada nos mais pedidos?"
- Toda mensagem de erro diz o que aconteceu e o que fazer em seguida.
- Estados vazios nunca são uma tela em branco: sempre sugerem uma ação.

### R9. Hábito e recompensa
- "Pedir de novo" em destaque na home para quem já comprou.
- Cupom ou benefício na segunda compra (o momento mais difícil de retenção).
- Programa de indicação: quem indica ganha e quem é indicado também, com link/código compartilhável por WhatsApp.
- Opcional: cashback ou pontos simples, visíveis no perfil.

### R10. Atendimento humano rápido
- Botão de ajuda sempre acessível dentro do pedido, abrindo WhatsApp já com o número do pedido preenchido na mensagem.
- O app resolve a maioria dos casos sozinho; quando não resolve, uma pessoa responde rápido.

---

## 3B. Painel de gestão (admin) — as 10 regras

O painel precisa ser tão fácil quanto o app do cliente. Quem opera a loja não pode perder tempo procurando pedido, digitando a mesma coisa duas vezes ou abrindo cinco telas para despachar uma entrega. Se o painel for lento ou confuso, o cliente sente no atraso. O painel é a cozinha do restaurante: se estiver bagunçada, o prato chega frio.

### A1. A tela inicial mostra o que precisa de ação agora
- Primeiro bloco: pendências. Pedidos novos, pedidos aguardando pagamento, pedidos prontos para despachar, entregas com problema, produtos com estoque baixo. Cada item é clicável e leva direto à ação.
- Segundo bloco: números do dia (vendas, quantidade de pedidos, ticket médio), comparados com o mesmo dia da semana anterior.
- Nada de tela inicial decorativa ou gráfico que não gera ação.

### A2. Fila de pedidos em um toque
- Pedidos organizados por status em colunas ou abas (Novo > Pago > Separando > Em entrega > Entregue), estilo quadro kanban.
- Pedido novo chega com alerta sonoro e notificação, sem precisar atualizar a página (tempo real).
- Cada pedido tem o botão da próxima ação em destaque ("Aceitar", "Marcar como separado", "Chamar entregador", "Marcar entregue"). Um toque avança o status.
- Toda mudança de status notifica o cliente automaticamente. O operador nunca precisa mandar mensagem manual avisando.
- Imprimir ou compartilhar o resumo do pedido (itens, endereço, observações) em um toque.

### A3. Entrega resolvida numa tela só
- Botão "Chamar entregador" dentro do pedido, mostrando lado a lado: entregador próprio, Lalamove e Uber, com preço e tempo estimado de cada um.
- Escolher em um toque. O sistema cria a entrega pela API, guarda o link de rastreio e repassa ao cliente.
- Status da entrega atualizado por webhook, sem o operador ficar conferindo em outro app.
- Endereço já vem pronto do pedido, com botão para abrir no mapa.

### A4. Cadastro de produto rápido
- Campos mínimos obrigatórios (nome, preço, foto, categoria, estoque). O resto é opcional e fica recolhido em "mais detalhes".
- Foto direto da câmera do celular, com compressão e corte automáticos.
- Botão "Duplicar produto" para cadastrar variações parecidas em segundos.
- Variações (sabor, cor, tamanho) numa grade simples, cada uma com seu estoque.
- Regra de preço da loja: preço de venda sempre terminando em ,99. O campo de preço deve sugerir/ajustar automaticamente e avisar quando não seguir a regra.
- Salvamento automático de rascunho. Nunca perder o que foi digitado.

### A5. Ações em massa
- Selecionar vários produtos e alterar preço, estoque, categoria ou ativar/pausar de uma vez.
- Reajuste de preço em lote por percentual, respeitando a regra do ,99.
- Importar e exportar produtos por planilha.

### A6. Estoque que se cuida sozinho
- Baixa automática do estoque a cada venda paga; devolução automática se o pedido for cancelado.
- Alerta de estoque baixo com limite configurável por produto.
- Produto esgotado sai da vitrine sozinho (ou aparece como "esgotado"), sem ação manual.

### A7. Busca e filtros em tudo
- Busca única que encontra pedido pelo número, cliente pelo nome ou telefone, produto pelo nome.
- Filtros rápidos salvos ("pedidos de hoje", "aguardando pagamento", "estoque baixo").

### A8. Funciona no celular
- O painel precisa ser usável no celular, com uma mão, no balcão ou na rua. Mobile-first também para o operador.
- Ações principais com botões grandes; tabelas viram cartões em tela pequena.

### A9. Segurança sem atrito
- Preferir "Desfazer" (por alguns segundos) em vez de janela de confirmação para ações comuns. Confirmação só para ações irreversíveis (excluir, estornar).
- Permissões por usuário (sócio, funcionário, entregador): cada um vê e faz só o que precisa.
- Histórico de atividades: quem alterou o quê e quando (preço, estoque, status do pedido). Essencial com mais de uma pessoa operando.

### A10. Relatórios que respondem perguntas
- Vendas do dia, semana e mês; produtos mais vendidos; ticket médio; clientes novos versus recorrentes; custo de entrega por pedido.
- Cada relatório responde uma pergunta clara em linguagem simples ("Quanto vendi esta semana?", "O que mais sai?").
- Exportar para planilha.

### Ficha do cliente (liga o painel ao encantamento)
- Histórico de pedidos, total gasto, endereço, observações internas.
- Marcação automática de "primeiro pedido", para a operação incluir brinde ou bilhete (o "momento uau" da seção 4).
- Botão para falar com o cliente no WhatsApp já com o contexto do pedido.

---

## 4. Identidade e encantamento (lição Nubank)

O Nubank nasceu em 2013 porque o fundador, David Vélez, passou por porta giratória, fila e burocracia para abrir uma conta. A estratégia foi remover o atrito e a humilhação de uma experiência que todo mundo odiava:

- Um produto só, muito bem feito (cartão sem anuidade, controlado pelo app).
- Identidade marcante: o cartão roxo virou propaganda ambulante.
- Crescimento por boca a boca e convites (cerca de 80-90% dos clientes vieram por indicação, segundo análises de mercado).
- Atendimento sem roteiro, com gestos de encantamento (ex.: cartão novo enviado junto com um ossinho para o cachorro que mastigou o antigo).
- Resultado: 139 milhões de clientes e mais de 83% usando o app todo mês (2º tri 2026).

Aplicação no app:
- Uma cor/identidade forte e consistente em todas as telas (botões principais, confirmação, embalagem).
- Um "momento uau" planejado: tela de confirmação caprichada, mensagem personalizada com o nome do cliente, campo interno para a operação incluir brinde ou bilhete no primeiro pedido.
- Consistência visual: mesmo espaçamento, mesmos componentes, mesma tipografia em todo o app (criar/usar um design system com tokens de cor, espaço e fonte).

---

## 5. AUDITORIA (fazer primeiro)

Antes de alterar código, analise o projeto e entregue um relatório com:

1. **Mapa do fluxo atual de compra**: listar cada tela e cada toque, da abertura até o pedido pago. Contar telas, toques e campos de formulário.
2. **Mapa das tarefas do painel**: para cada tarefa do dia a dia do operador (aceitar e despachar um pedido, chamar entregador, cadastrar um produto, ajustar estoque, alterar preço, achar um pedido antigo), contar telas, toques e campos necessários hoje.
3. **Checagem regra a regra**: para cada regra do app do cliente (R1 a R10) e do painel (A1 a A10), marcar "atende", "atende parcial" ou "não atende", com o arquivo/componente onde está o problema.
4. **Performance**: tamanho das imagens, uso de skeleton, consultas lentas ao banco, telas que bloqueiam esperando rede (nas duas frentes).
5. **Textos**: listar mensagens de erro e estados vazios que precisam ser reescritos (nas duas frentes).
6. **Plano priorizado** em três grupos, separando app do cliente e painel:
   - Ganho rápido (pouco esforço, muito impacto) — ex.: mostrar frete antes, reescrever erros, botão "pedir de novo", botão da próxima ação em cada pedido, alerta sonoro de pedido novo.
   - Médio prazo — ex.: Pix com confirmação automática, status em tempo real, "chamar entregador" com cotação lado a lado, ações em massa.
   - Estrutural — ex.: login por telefone, design system único para as duas frentes, programa de indicação, permissões e histórico de atividades.

Aguarde aprovação do plano antes de implementar. Implemente em etapas pequenas, uma por vez, testando cada uma.

---

## 6. Checklist de aceite (toda tela nova ou alterada)

- [ ] O objetivo da tela é alcançado com o menor número possível de toques?
- [ ] Algum valor, taxa ou condição aparece de surpresa?
- [ ] Tem skeleton ou feedback imediato enquanto carrega?
- [ ] Os textos são humanos e as mensagens de erro dizem o que fazer?
- [ ] O estado vazio sugere uma ação?
- [ ] Funciona bem em celular pequeno, com uma mão, e com internet lenta?
- [ ] Botões principais têm área de toque de pelo menos 44x44 px e contraste adequado?
- [ ] Segue as cores, espaçamentos e componentes do design system?
- [ ] Nenhuma chave de API ou dado sensível ficou exposto no front-end?

Adicional para telas do painel:

- [ ] A próxima ação do operador está em destaque e é feita em um toque?
- [ ] Alguma informação precisa ser digitada que o sistema já sabe?
- [ ] A mudança feita aqui avisa o cliente automaticamente quando deveria?
- [ ] Dá para fazer em lote o que costuma ser feito várias vezes?
- [ ] Funciona no celular do operador?
- [ ] Ações comuns têm "Desfazer" e ações irreversíveis têm confirmação?

---

## 7. Anti-padrões (nunca fazer)

- Obrigar cadastro antes de mostrar os produtos.
- Mostrar frete só na última tela.
- Pedir para o cliente enviar comprovante de Pix manualmente.
- Spinner infinito sem explicação.
- Mensagens técnicas ("null", "undefined", códigos de erro) para o cliente.
- Pop-ups que interrompem a compra.
- Formulários com campos opcionais misturados aos obrigatórios.
- Guardar dados de cartão no próprio banco.
- No painel: obrigar o operador a atualizar a página para ver pedido novo.
- No painel: avisar o cliente manualmente sobre algo que o sistema poderia avisar sozinho.
- No painel: tabelas enormes sem busca nem filtro.
- No painel: formulário de produto com dezenas de campos obrigatórios.
- No painel: janela "Tem certeza?" em toda ação simples.
