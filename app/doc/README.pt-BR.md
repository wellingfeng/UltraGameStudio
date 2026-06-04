# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | Português | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

Nem toda tarefa de programação merece gastar cota dos modelos mais caros. O FreeUltraCode reúne Claude Code, Codex, Gemini, canais gratuitos e modelos locais em uma interface de chat local. Use modelos baratos para explorar e reserve modelos mais estáveis para decisões importantes.

<p align="center">
  <strong>Roteamento de canais gratuitos</strong><br>
  <img src="images/hero-free-channels.pt-BR.png" alt="Captura de tela do roteamento de canais gratuitos do FreeUltraCode" width="960">
</p>

## Por que FreeUltraCode

Agentes de programação são úteis, mas a cota de modelos premium acaba rápido. O FreeUltraCode mantém a experiência de chat local e facilita enviar solicitações para canais gratuitos, de teste ou de baixo custo quando eles são suficientes.

- Use GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Gemini, DeepSeek, Kimi, Groq, OpenRouter, NVIDIA NIM, Z.ai, Kilo, LLM7, Ollama, LM Studio e llama.cpp.
- Mantenha API keys e configurações de provedores na sua máquina.
- Troque runtime, canal, modo de permissão e workspace direto no compositor de chat.
- Preserve localmente histórico, favoritos, prompts agendados e contexto do workspace.
- Use modelos locais sem API key quando o hardware permitir.

## O que ele faz

### Chat de programação

- Peça alterações de código, investigação de bugs, refatoração, testes, notas de release ou documentação.
- Anexe caminhos de arquivos ou arraste arquivos para o compositor.
- Veja saída em streaming, logs de comandos, referências de arquivos e resumos em uma única superfície de chat.
- Continue com solicitações de acompanhamento na mesma sessão.

### Roteamento de modelos gratuitos

- **20+ canais remotos e runtimes locais**: NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, além de Ollama, LM Studio e llama.cpp.
- **Rotas experimentais sem key**: LLM7 e Kilo Gateway podem ser testados sem API key, mas use apenas para prompts de código não sensíveis.
- **Rotas oficiais com cota grátis ou de teste**: as chaves dos provedores ficam salvas localmente no app.
- O proxy local em Rust traduz entre protocolos Anthropic e OpenAI-compatible.
- Claude Code pode passar por canais gratuitos configurados sem mudar a interface de chat.
- Keys, modelos personalizados e modelos locais são gerenciados nas configurações.

Modelos padrão voltados para programação:

| Canal | Modelo padrão |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

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

### Usar Chat para programar

1. Clique em **+ New Session** na barra lateral.
2. Escolha runtime, canal, modo de permissão e workspace nos controles inferiores.
3. Descreva a tarefa com comportamento esperado, arquivos afetados, critérios de aceite e restrições.
4. Durante a execução, o FreeUltraCode mostra leituras de arquivo, buscas, edições e verificações como entradas separadas.
5. Se precisar ajustar o resultado, continue no mesmo chat com uma solicitação de acompanhamento.

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
    lib/         Configurações de provedores, roteamento gratuito, persistência
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
