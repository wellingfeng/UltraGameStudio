# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | Português | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

Em uma game engine, o código é só uma pequena parte do trabalho. O resto são assets e pipeline: materiais, blueprints, terreno, céu, UI, animação esquelética, empacotamento, performance. O FreeUltraCode é um agente de programação no estilo Claude Code / Codex / Gemini reconstruído em torno dessa realidade: ele entende os conceitos das game engines, gera toda a gama de assets de jogo (imagens, modelos 3D, animação de sprites 2D, atlas, áudio, rigging, vídeo) e roteia o trabalho rotineiro por canais gratuitos ou de baixo custo, reservando a cota premium para o que importa.

<p align="center">
  <strong>Interface UMG do Unreal Engine em um clique</strong><br>
  <img src="images/game/JMsXEKE.png" alt="O FreeUltraCode gera uma interface UMG do Unreal Engine em um clique" width="960">
</p>

<p align="center">
  <strong>Geração de modelo 3D em um clique</strong><br>
  <img src="images/game/noYfqPt.png" alt="O FreeUltraCode gera um modelo 3D em um clique" width="960">
</p>

<p align="center">
  <strong>Imagens, sprites, meshes, áudio, rigging e vídeo — gerenciados por um único agente de programação</strong><br>
  <img src="images/game/gmclmLS.png" alt="Geração unificada de assets de jogo do FreeUltraCode" width="960">
  <br><br>
  <img src="images/game/jXgMffC.png" alt="Fluxo de assets de jogo do FreeUltraCode" width="960">
</p>

## Por que FreeUltraCode

Hoje a IA é boa o bastante para escrever a maior parte do código sozinha. O papel do programador está migrando para descrever a intenção, verificar a saída e orquestrar agentes. Mas um jogo não é só código. Uma game engine é cheia de materiais, blueprints, terreno, céu, UI, animação esquelética, empacotamento e ajuste de performance — e a maioria dos agentes de programação genéricos não entende nada disso.

O FreeUltraCode pega um agente no estilo Claude Code / Codex / Gemini e o personaliza profundamente para o desenvolvimento de jogos:

- **Fala a língua das game engines.** O agente vem preparado com conceitos de desenvolvimento de jogos para raciocinar sobre materiais, blueprints, terreno, iluminação, UI (UMG e outras), animação esquelética, build/empacotamento e otimização de performance.
- **Gera todos os tipos de asset que um jogo precisa.** Imagens, modelos 3D, animação de sprites 2D, atlas de sprites, áudio, rigging esquelético e vídeo são produzidos na mesma superfície e gerenciados por um único fluxo de agente.
- **Time de especialistas em desenvolvimento de jogos embutido.** Mais de 40 papéis especializados (diretor técnico, programador de gameplay/IA/rede/ferramentas, designer de nível/economia, diretores de arte e áudio, QA, release manager etc.) cobrindo Unity, Unreal, Godot e Web.
- **Reserva a cota premium para o que importa.** Roteie o trabalho rotineiro por canais gratuitos, de teste ou de baixo custo, e mantenha chaves, configurações e histórico localmente.

## O que ele faz

### Chat de desenvolvimento de jogos

- Peça código de gameplay, integração de engine, lógica de shaders/materiais, scripts de build, investigação de bugs, refatoração, testes e notas de release.
- Trabalhe em projetos Unity, Unreal, Godot ou Web — o agente raciocina sobre conceitos da engine, não só sobre arquivos.
- Anexe caminhos de arquivos ou arraste arquivos para o compositor.
- Veja saída em streaming, logs, referências de arquivos e resumos em uma única superfície de chat.
- Continue com solicitações de acompanhamento na mesma sessão.

### Geração de assets de jogo

Cada tipo de asset que um jogo precisa pode ser gerado na mesma superfície e aplicado ao projeto, e então devolvido ao modelo de programação — tudo no mesmo histórico. Cada gerador passa pelo provedor que você configurou.

| Asset | O que produz | Modo |
| --- | --- | --- |
| Imagens | Concept art, mockups de UI, ícones, pôsteres, texturas, referências | `/image`, `/img`, `/draw`, `/生图` ou `/image-mode-start` |
| Grafos ComfyUI | Pipelines de imagem editáveis baseados em nós | `/comfyui-mode-start` |
| Sprites 2D | Sprites de jogo, frames de sequência, spritesheets | `/sprite` ou `/sprite-mode-start` |
| Modelos 3D | Props, personagens, meshes de cena, blockouts | `/mesh-mode-start` (busque com `/mesh-search`) |
| Música | BGM, trilha, clipes musicais | `/music` ou `/music-mode-start` |
| Voz | Falas e narração | `/speech-mode-start` |
| Vídeo | Clipes de vídeo e assets animados | `/video` ou `/video-mode-start` |

O agente primeiro refina seu prompt, envia ao provedor configurado e mostra o resultado no fluxo de chat. Saia de qualquer modo com o comando `*-mode-end` correspondente.

### Time de especialistas em desenvolvimento de jogos

O FreeUltraCode traz mais de 40 especialistas em desenvolvimento de jogos que o agente aciona automaticamente conforme a tarefa:

- **Especialistas de engine** para Unity, Unreal, Godot (GDScript / C# / GDExtension / shaders) e Web.
- **Programação**: diretor técnico, programadores lead/engine/gameplay/IA/rede/ferramentas/UI.
- **Design**: designers de gameplay, nível, economia, live-ops e narrativa.
- **Arte e áudio**: diretores e especialistas, VFX, sound design, direção de áudio.
- **Produção, qualidade e release**: produtor, QA lead/tester, devops, segurança, localização, release manager.

Configure a engine ativa, o modo council e os especialistas habilitados em **Settings**.

### Roteamento de modelos gratuitos

- **20+ canais remotos e runtimes locais**: NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, além de Ollama, LM Studio e llama.cpp.
- **Rotas experimentais sem key**: LLM7 e Kilo Gateway podem ser testados sem API key, mas use apenas para prompts de código não sensíveis.
- **Rotas oficiais com cota grátis ou de teste**: as chaves dos provedores ficam salvas localmente no app.
- O proxy local em Rust traduz entre protocolos Anthropic e OpenAI-compatible.
- Claude Code pode passar por canais gratuitos configurados sem mudar a interface de chat.
- Keys, modelos personalizados e modelos locais são gerenciados nas configurações.

<p align="center">
  <strong>Roteamento de canais gratuitos</strong><br>
  <img src="images/hero-free-channels.pt-BR.png" alt="Captura de tela do roteamento de canais gratuitos do FreeUltraCode" width="960">
</p>

Modelos padrão voltados para programação:

| Canal | Modelo padrão |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

### Workflow dinâmico (/ultracode)

Para tarefas complexas de programação com várias etapas, `/ultracode <tarefa>` gera na hora um harness de execução sob medida e o executa imediatamente. Nenhum canvas visual necessário.

- Descreva a tarefa em linguagem natural — o planejador constrói um harness com subagentes paralelos, verificação adversarial e portões de aceitação.
- Seis estratégias internas são escolhidas automaticamente: classificar-e-agir, leque-e-síntese, verificação-adversarial, gerar-e-filtrar, torneio, repetir-até-concluir.
- Cada execução é totalmente registrada em `.fuc-run/<run-id>/` com livro de tarefas, eventos, veredito e resultado final.
- Execute pelo app desktop ou pela CLI: `fuc ultracode "<tarefa>" --json --interactive --cwd <workspace>`.
- Configuração zero — reutiliza as credenciais de login do `claude` CLI local.

#### Free Auto — Troca automática multicanal

O canal **Auto** (`freecc:auto` no menu Channel) roteia automaticamente cada requisição para o melhor canal gratuito disponível, sem trocas manuais.

- Alterna entre todos os canais gratuitos configurados, pulando automaticamente os que atingem limites de taxa (429) ou retornam erros upstream (5xx).
- Rastreia cooldowns por canal com backoff: quando um canal falha, ele é pausado antes de ser tentado novamente.
- Suporta substituição opcional de modelo para que todas as requisições usem o mesmo modelo.
- Se todos os canais estiverem esgotados, retorna um 503 com o log de falhas para diagnóstico.

#### Cadeia multi-provedor: DeepSeek → CodeX

Com `/ultracode`, o harness pode encadear vários provedores entre as etapas do plano automaticamente. Padrão típico: DeepSeek produz rascunhos com baixo custo, CodeX refina até a qualidade final.

- O **plano de harness dinâmico** suporta substituição de `model` por etapa — atribua DeepSeek para brainstorming/classificação e CodeX/Gemini para implementação/verificação.
- **Compatibilidade cc-switch**: O FreeUltraCode lê a configuração CLI `cc-switch`; qualquer provedor já configurado para Claude Code está disponível imediatamente.
- A estratégia **leque-e-síntese** paraleliza workers DeepSeek em subtarefas independentes, depois um portão de consenso (CodeX) sintetiza e verifica os resultados.

#### Seleção de canal sensível à velocidade

O canal Auto do proxy gratuito prioriza canais com base em sinais de disponibilidade em tempo real:

- **Consciente de limites de taxa**: canais retornando 429 são resfriados por 30+ segundos antes de nova tentativa.
- **Falha rápida em erros**: erros não-reintentáveis (falhas de autenticação 4xx, quedas upstream 5xx) são rastreados com cooldown; o roteador Auto os pula.
- **Orçamento de tempo de conexão**: cada tentativa de canal está sujeita ao timeout upstream; o roteador Auto não bloqueia em um único upstream lento.
- **Ordem natural por responsividade**: canais bem-sucedidos são tentados primeiro; canais com erro vão para o final da lista.

Esses recursos garantem execuções resilientes do harness `/ultracode`, mesmo quando provedores gratuitos individuais estão lentos, limitados ou temporariamente indisponíveis.

## Início rápido

```bash
cd app
npm install
npm run dev
```

Para o app desktop:

```bash
cd app
npm run desktop
```

Para gerar um pacote de produção:

```bash
cd app
npm run package
```

## Uso básico

### Registrar um canal gratuito

1. Abra o menu inferior **Channel** e escolha um canal gratuito com aviso, por exemplo **Free · OpenRouter**.

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="Escolher um canal gratuito ainda não configurado no menu Channel" width="960">
</p>

2. No diálogo de API key, clique em **Open registration site**.

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="Abrir o site de registro do provedor" width="960">
</p>

3. Crie uma nova API key na página do provedor e copie a chave.

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="Criar uma API key do provedor" width="960">
</p>

4. Cole a key no FreeUltraCode e clique em **Save and Use**. Depois de salvar, o aviso desaparece.

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="Canal gratuito configurado sem aviso" width="960">
</p>

5. Você também pode gerenciar todos os canais em **Settings** -> **Channels** -> **Free Channels**.

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="Gerenciar canais gratuitos nas configurações" width="960">
</p>

Quando o canal estiver pronto, use a entrada inferior para conversar por essa rota.

### Gerar assets de jogo

Os modos de asset transformam o compositor em uma superfície de geração de assets, mantendo o mesmo histórico. Úteis para gerar mockups de UI, ícones, texturas, sprites, modelos 3D, áudio e vídeo antes de voltar ao código. O exemplo abaixo usa o modo de imagem; os modos sprite, mesh, música, voz e vídeo funcionam igual com seus comandos `*-mode-start`.

1. Abra **Settings** -> **Images** (ou a seção de asset correspondente), escolha o provedor padrão e preencha a API key, Account ID, Base URL ou endpoint local do ComfyUI exigido.
2. Em uma sessão de chat, digite `/image-mode-start`. Você também pode iniciar e gerar no mesmo envio:

```text
/image-mode-start uma textura de muro de pedra estilizada para uma masmorra de fantasia, tileable, 1024x1024
```

3. Enquanto o modo estiver ativo, mensagens comuns geram assets em vez de executar edições de código. O seletor **Channel** muda para provedores de assets.
4. Descreva o asset desejado. FreeUltraCode primeiro pede ao modelo de programação para melhorar o prompt e depois envia ao provedor configurado.

<p align="center">
  <img src="images/生图/session-2026-06-07-2351.png" alt="O modo de asset gera elementos na mesma sessão do FreeUltraCode" width="720">
</p>

5. Envie `/image-mode-end` para voltar ao canal e modelo de programação. Para um único asset sem modo persistente, use `/image`, `/img`, `/draw`, `/生图`, `/sprite`, `/music` ou `/video` seguido do prompt.

## Como funciona

```text
Solicitação do usuário
    |
    v
Compositor de chat
    |
    +--> runtime / canal / permissões / workspace selecionados
             |
             +--> API do provedor, CLI local ou proxy local de canal gratuito
                        |
                        +--> saída em streaming, log de ferramentas e histórico
```

## Stack técnico

| Área | Tecnologia |
| --- | --- |
| Shell desktop | Tauri 2, Rust |
| Frontend | React 18, Vite 5, TypeScript 5 |
| Estado | Zustand |
| Estilo | Tailwind CSS, variáveis CSS |
| Ícones | lucide-react |
| Roteamento de provedores | Claude Code, Codex, Gemini, configurações extensíveis |
| Proxy de canais gratuitos | Rust `tiny_http` + `ureq`, tradução Anthropic/OpenAI |

## Estrutura do projeto

```text
app/
  src/
    components/  UI compartilhada
    lib/         Configurações de provedores, roteamento gratuito, geração de assets (imagem/sprite/3D/música/voz/vídeo/ComfyUI), time de especialistas de jogo, persistência
    panels/      Sidebar, chat dock, configurações, agendamento
    store/       Estado Zustand e histórico local
  src-tauri/
    src/
      free_proxy.rs    Proxy reverso Rust + tradução Anthropic/OpenAI
      lib.rs           Comandos Tauri, ponte de arquivos/histórico
  doc/                 Tutoriais, READMEs localizados, capturas
```

## Documentação

- [Guia chinês para registrar canal gratuito](register-free-channel.md)
- [README em inglês](../../README.md)

## Desenvolvimento

```bash
npm run dev
npm run typecheck
npm run lint
npm run test
npm run desktop
npm run package
```

## Comunidade

- Discord: <https://discord.gg/2C9ptSEFG>
- QQ Group: `149523963`
- Issues: <https://github.com/wellingfeng/FreeUltraCode/issues>

## Licença

Nenhuma licença foi especificada ainda.
