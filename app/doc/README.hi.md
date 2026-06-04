# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | हिन्दी | <a href="README.ar.md">العربية</a>
</div>

हर programming task के लिए सबसे महंगे model quota को खर्च करना जरूरी नहीं है। FreeUltraCode Claude Code, Codex, Gemini, free channels और local models को एक local chat interface में रखता है। सामान्य exploration सस्ते models से करें और critical judgment ज्यादा stable models को दें।

<p align="center">
  <strong>Free channel routing</strong><br>
  <img src="images/hero-free-channels.hi.png" alt="FreeUltraCode मुफ्त चैनल रूटिंग स्क्रीनशॉट" width="960">
</p>

## FreeUltraCode क्यों

Coding agents काम आते हैं, लेकिन premium model quota जल्दी खत्म होता है। FreeUltraCode chat experience को local रखता है और जब free, trial-credit या low-cost channel पर्याप्त हों, तब requests को उन्हीं के जरिए भेजना आसान बनाता है।

- GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Gemini, DeepSeek, Kimi, Groq, OpenRouter, NVIDIA NIM, Z.ai, Kilo, LLM7, Ollama, LM Studio और llama.cpp इस्तेमाल करें।
- API keys और provider settings आपकी machine पर रहती हैं।
- runtime, channel, permission mode और workspace chat composer से ही बदलें।
- chat history, favorites, scheduled prompts और workspace context local रहते हैं।
- hardware support होने पर local models बिना API key के चल सकते हैं।

## क्या कर सकता है

### Programming Chat

- code edits, bug investigation, refactor, tests, release notes या documentation के लिए पूछें।
- file paths जोड़ें या files को composer में drag करें।
- streamed output, command logs, file references और summaries एक ही chat surface में देखें।
- उसी session में follow-up requests जारी रखें।

### Free-model routing

- **20+ remote channels और local runtimes**: NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, साथ में Ollama, LM Studio और llama.cpp।
- **Keyless experimental routes**: LLM7 और Kilo Gateway बिना API key के test हो सकते हैं, लेकिन इन्हें non-sensitive coding prompts के लिए ही इस्तेमाल करें।
- **Official free/trial-credit routes**: provider keys app में local रूप से stored रहती हैं।
- Local Rust proxy Anthropic और OpenAI-compatible protocols के बीच translate करता है।
- Claude Code configured free channels के जरिए चल सकता है, chat UI बदले बिना।
- keys, model overrides और local model settings app settings में manage होते हैं।

Current coding-oriented default models:

| Channel | Default model |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

## Quick Start

```bash
cd app
npm install
npm run dev
```

Desktop app चलाने के लिए:

```bash
cd app
npm run desktop
```

Production package बनाने के लिए:

```bash
cd app
npm run package
```

## Basic Usage

### Free channel register करें

1. नीचे वाला **Channel** menu खोलें और warning mark वाला free channel चुनें, जैसे **Free · OpenRouter**।

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="Channel menu से unconfigured free channel चुनना" width="960">
</p>

2. API key dialog में **Open registration site** पर click करें।

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="provider registration site खोलना" width="960">
</p>

3. provider page पर नई API key बनाएं और copy करें।

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="provider API key बनाना" width="960">
</p>

4. key को FreeUltraCode में paste करें और **Save and Use** पर click करें। save होने के बाद warning mark हट जाएगा।

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="configured free channel ready" width="960">
</p>

5. सभी channels को **Settings** -> **Channels** -> **Free Channels** से भी manage किया जा सकता है।

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="settings में free channels manage करना" width="960">
</p>

Channel ready होने के बाद नीचे के input से उसी route पर chat करें।

### Chat से programming करें

1. left sidebar में **+ New Session** click करें।
2. नीचे runtime, channel, permission mode और workspace चुनें।
3. expected behavior, affected files, acceptance criteria और constraints के साथ task लिखें।
4. चलने के दौरान FreeUltraCode file reads, searches, edits और checks को अलग entries में दिखाता है।
5. result adjust करना हो तो उसी chat में follow-up request भेजें।

## कैसे काम करता है

```text
User request
    |
    v
Chat composer
    |
    +--> selected runtime / channel / permission / workspace
             |
             +--> provider API, local CLI, or local free-channel proxy
                        |
                        +--> streamed output, tool log, and chat history
```

## Technology Stack

| Area | Technology |
| --- | --- |
| Desktop shell | Tauri 2, Rust |
| Frontend | React 18, Vite 5, TypeScript 5 |
| State | Zustand |
| Styling | Tailwind CSS, CSS variables |
| Icons | lucide-react |
| Provider routing | Claude Code, Codex, Gemini, extensible provider settings |
| Free-channel proxy | Rust `tiny_http` + `ureq`, Anthropic/OpenAI protocol translation |

## Project Structure

```text
app/
  src/
    components/  Shared UI components
    lib/         Provider settings, free-channel routing, persistence
    panels/      Sidebar, chat dock, settings, scheduling UI
    store/       Zustand state and local history
  src-tauri/
    src/
      free_proxy.rs    Rust reverse proxy + Anthropic/OpenAI translation
      lib.rs           Tauri commands, filesystem/history bridge
  doc/                 Tutorials, localized READMEs, screenshots
```

## Documentation

- [Free channel registration guide in Chinese](register-free-channel.md)
- [English README](../../README.md)

## Development

```bash
npm run dev
npm run typecheck
npm run lint
npm run test
npm run desktop
npm run package
```

## Community

- Discord: <https://discord.gg/2C9ptSEFG>
- QQ Group: `149523963`
- Issues: <https://github.com/wellingfeng/FreeUltraCode/issues>

## License

License अभी specified नहीं है।
