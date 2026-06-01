# O Claude Code ganhou Dynamic Workflows. E os outros modelos? Uma alternativa open source: OpenWorkflows

## Recentemente venho observando os novos dynamic workflows do Claude Code. Comparado a MCP, Skill e Hooks, pouca gente fala desse novo recurso. Daqui em diante vou chamá-los apenas de workflows.

Para tarefas complexas, muita gente antes gostava de criar primeiro um HTML de pesquisa, depois transformá-lo em um HTML de plano técnico e, por fim, entregar isso à IA para desenvolver. Mas muitas vezes o resultado não era bom. O principal motivo é que HTML é texto para humanos lerem. Não é um script e falta informação estruturada. A consistência da ordem, o nível de paralelismo, a clareza dos limites, a divisão das tarefas e a troca de informação entre tarefas ficam indefinidos, então a IA precisa adivinhar demais.

Os workflows em si são scripts, e isso resolve esse problema de forma direta.

Além disso, workflows têm exploração por múltiplos ângulos, validação adversarial e votação de planos. É por isso que eles tendem a ser mais precisos. Eles vencem pela escala: cinco agents rodam ao mesmo tempo no mesmo problema, e depois outro agent resume tudo. Realmente fica mais preciso, mas os tokens também voam.

Se isso é tão geral, por que deveria ficar preso a um modelo ou a uma CLI?

Seguindo essa ideia, desenvolvi o OpenWorkflows, ou mais exatamente, a IA desenvolveu. Ele transforma workflows do tipo Claude Code em uma tela visual e tenta fazer o mesmo fluxo mirar Claude Code, Codex, Gemini e mais runtimes locais ou na nuvem.

Desta vez não vou falar de conceitos abstratos. Vou seguir direto pelas capturas. O exemplo é concreto: fazer o OpenWorkflows dar suporte a vários estilos de interface, usar Pencil por padrão e permitir troca em Configurações / Aparência.

Durante o desenvolvimento, tentei fazer o máximo possível dentro do OpenWorkflows, para que ele pudesse se auto-inicializar.

O processo abaixo usa CodeX como modelo grande padrão para desenvolvimento.

### 0. Primeiro, a interface final

<p align="center">
  <img src="images/0-标题使用.png" alt="Interface principal do OpenWorkflows" width="960">
</p>

Na interface principal do OpenWorkflows, o blueprint de workflows fica no centro, as propriedades dos nós ficam à direita, e a entrada e saída de IA ficam embaixo.

A interface principal se divide aproximadamente em quatro partes: histórico de workflows à esquerda, tela visual no centro, propriedades dos nós e prompts comuns à direita, e entrada de IA com respostas embaixo.

### 1. Baixar o OpenWorkflows

<p align="center">
  <img src="images/1-下载.png" alt="OpenWorkflows GitHub Releases" width="840">
</p>

Encontre a versão mais recente em Releases, no lado direito da página do projeto no GitHub.

### 2. Configurar primeiro o modelo grande

Por padrão, o OpenWorkflows usa a CLI já configurada no sistema para iniciar. Você pode usar ferramentas como CC-Switch para configurar isso.

### 3. Criar novos workflows e inserir a solicitação

<p align="center">
  <img src="images/3-新建workflow.png" alt="Criar novos workflows e inserir a solicitação" width="840">
</p>

Depois de configurar o modelo, clique em "Novo workflows" à esquerda. A tela mostrará uma estrutura mínima: Start, um Agent e End.

Não é preciso desenhar os nós manualmente. O ponto de partida real é a caixa de entrada de IA no canto inferior direito. Neste exemplo, eu inseri:

```text
Quero que o OpenWorkflows dê suporte a vários estilos de interface,
use Pencil como design padrão
e permita alternar em Configurações / Aparência.
```

Depois de escrever, pressione Ctrl+Enter ou clique no botão de envio no canto inferior direito. O OpenWorkflows transforma esse texto em linguagem natural em um blueprint de workflows editável.

### 4-1. Gerar o blueprint de workflows

<p align="center">
  <img src="images/4-1生成workflow蓝图.png" alt="Blueprint de workflows gerado" width="960">
</p>

Depois de enviar a solicitação, o OpenWorkflows primeiro reorganiza a etapa atual em um workflow completo.

O blueprint da captura é aproximadamente assim:

```text
Start
  -> Explorar em paralelo o suporte de aparência
      -> Investigar entradas de aparência existentes
      -> Projetar o sistema multiestilo
      -> Projetar o estilo padrão Pencil
  -> Resumir o plano de implementação
  -> Implementar múltiplos estilos de interface
  -> Conectar a troca em Configurações / Aparência
  -> Validar e verificar regressões
  -> Registrar o resultado de entrega
  -> End
```

No painel direito de propriedades, você pode continuar modificando as propriedades do nó selecionado. Mas, na maioria das vezes, é melhor usar a caixa de entrada inferior e deixar a IA modificar os nós do blueprint para continuar iterando.

### 4-2. Ver o script gerado

<p align="center">
  <img src="images/4-2蓝图脚本.png" alt="Script de workflows gerado" width="960">
</p>

Há uma entrada "Script" na parte superior. Ao clicar, aparece o script gerado a partir do blueprint atual.

Na captura, dá para ver estruturas como parallel(...) e agent(...). Nós paralelos viram ramificações executadas de forma concorrente, e nós comuns viram chamadas individuais de agent.

Isso também mostra que o OpenWorkflows não é apenas desenho de caixas. Por trás da tela existe uma estrutura unificada de workflows, que depois pode se conectar a diferentes runtimes.

### 5. Continuar editando com os prompts comuns à direita

<p align="center">
  <img src="images/5-使用常用提示词.png" alt="Usar prompts comuns para continuar editando workflows" width="960">
</p>

Depois de gerar o blueprint, não é necessário executar imediatamente. O painel "Prompts comuns" à direita é melhor para lapidar o processo, embora também seja possível escrever manualmente.

Os prompts são agrupados por cenário, como esclarecimento interativo, clareza, completude, custo, estrutura, confiabilidade, desempenho e paralelismo, verificação e testes.

Na captura, o prompt usado é "Esclarecer requisitos". Ele preenche a entrada de IA com uma solicitação para que a IA confirme interativamente os pontos ambíguos antes de modificar o blueprint.

Esse design é muito útil. Muitos workflows falham não porque o modelo não sabe fazer, mas porque objetivo, limites, caminhos de falha e estratégia de custo não estavam claros no início.

Também há prompts comuns como grill-me, completar condições de borda, otimização paralela e princípio único. Você pode adicionar ou modificar prompts por conta própria.

### 6. Confirmar limites com escolhas interativas

<p align="center">
  <img src="images/6-交互选择.png" alt="Escolhas interativas para confirmar limites" width="640">
</p>

Depois de clicar em "Esclarecer requisitos", a IA não muda o gráfico diretamente. Primeiro ela pergunta: "Qual escopo a função de troca de estilo de interface deve cobrir?"

A captura mostra duas opções: entregar apenas o estilo padrão Pencil e deixar uma estrutura extensível, ou entregar Pencil mais vários estilos alternáveis.

Depois que você escolhe, a IA escreve essa decisão de volta no blueprint de workflows e emite o IRGraph atualizado. Essa etapa reduz o risco de a IA mudar a direção sozinha.

### 7. Clicar em Executar

<p align="center">
  <img src="images/7-运行.png" alt="Executar workflows" width="960">
</p>

Depois que a estrutura do blueprint, a configuração do modelo e os limites principais estiverem confirmados, clique em "Executar" na parte superior.

É melhor não executar logo após gerar o blueprint. Primeiro verifique se as ramificações paralelas fazem sentido, se o nó de resumo vem depois delas e se a validação cobre o resultado final.

Se um nó só tiver responsabilidade pouco clara, você pode editá-lo nas propriedades do nó antes de executar de novo.

### 8. Observar o estado de execução

<p align="center">
  <img src="images/8-运行中.png" alt="Observar o estado de execução dos workflows" width="960">
</p>

Depois de executar, o botão superior vira "Executando... Parar". A entrada de IA embaixo fica bloqueada para evitar que o blueprint seja bagunçado durante a execução.

A tela mostra o estado dos nós. Na captura, Start terminou, o nó paralelo seguinte está executando e o canto superior direito mostra a contagem de execução. Se algo falhar no meio, é possível continuar a partir da tarefa anterior.

### 9. Alternar o estilo da interface

<p align="center">
  <img src="images/9-切换风格.png" alt="Alternar estilo da interface" width="840">
</p>

Depois que o OpenWorkflows terminar o desenvolvimento, reinicie o programa e alterne entre diferentes estilos em Configurações / Aparência.

Na captura aparecem cartões de estilo como Pencil, Deep Night, Aurora, Daylight e Ember. Ao selecionar um estilo, ele afeta o fundo global, painéis, bordas e cores de estado de execução.

### O que eu acho realmente útil

O maior valor do OpenWorkflows não é colocar uma UI em volta de um prompt.

Ele conecta "solicitação -> blueprint -> script -> execução -> revisão do histórico". Você pode primeiro gerar um processo em linguagem natural, verificar a estrutura na tela, usar prompts comuns para completar limites quando necessário e só então executar.

Os mesmos workflows também não precisam ficar presos naturalmente a um único modelo. Nós simples podem usar modelos baratos, nós importantes podem usar modelos mais fortes, e o alvo de execução pode continuar se expandindo para Claude Code, Codex, Gemini ou outros runtimes.

Para tarefas complexas de programação com IA, essa decomposição é mais fácil de manter do que um prompt enorme. Se um nó falhar, corrija esse nó. Se uma ramificação não for necessária, remova essa ramificação. Se quiser reutilizar, continue a partir do histórico.

### Ainda é cedo, mas a direção vale atenção

O conceito de workflows como um todo ainda é bem inicial, e o próprio OpenWorkflows também está só começando. Adaptadores de runtime, capacidades dos nós e o ecossistema de scripts ainda vão mudar.

Mas a direção geral está clara: a programação com IA não ficará para sempre em "abrir uma janela de chat e empurrar cada etapa manualmente".

Tarefas complexas acabarão virando workflows porque podem ser vistas, editadas, migradas e reutilizadas.

Grupo QQ: 149523963

Projeto:

https://github.com/wellingfeng/OpenWorkflows

Referência:

https://code.claude.com/docs/en/workflows
