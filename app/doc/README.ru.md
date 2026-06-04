# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | Русский | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

Не каждая задача по программированию стоит расхода квоты самых дорогих моделей. FreeUltraCode объединяет Claude Code, Codex, Gemini, бесплатные каналы и локальные модели в одном локальном чате. Дешевые модели подходят для разведки и рутины, а более стабильные можно оставить для важных решений.

<p align="center">
  <strong>Маршрутизация бесплатных каналов</strong><br>
  <img src="images/hero-free-channels.ru.png" alt="Снимок экрана маршрутизации бесплатных каналов FreeUltraCode" width="960">
</p>

## Зачем нужен FreeUltraCode

Coding agents полезны, но квота премиальных моделей быстро заканчивается. FreeUltraCode сохраняет локальный чат и позволяет направлять запросы через бесплатные, пробные или недорогие каналы, когда их достаточно.

- Используйте GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Gemini, DeepSeek, Kimi, Groq, OpenRouter, NVIDIA NIM, Z.ai, Kilo, LLM7, Ollama, LM Studio и llama.cpp.
- API-ключи и настройки провайдеров остаются на вашей машине.
- Runtime, канал, режим разрешений и workspace меняются прямо из области ввода.
- История чатов, избранное, запланированные prompts и контекст workspace хранятся локально.
- Локальные модели можно использовать без API-ключей, если хватает оборудования.

## Возможности

### Чат для программирования

- Запрашивайте правки кода, расследование багов, рефакторинг, тесты, release notes или документацию.
- Добавляйте пути к файлам или перетаскивайте файлы в область ввода.
- Смотрите потоковые ответы, логи команд, ссылки на файлы и резюме в одном чате.
- Продолжайте работу уточняющими запросами в той же сессии.

### Маршрутизация бесплатных моделей

- **20+ удаленных каналов и локальные runtimes**: NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, плюс Ollama, LM Studio и llama.cpp.
- **Экспериментальные маршруты без ключа**: LLM7 и Kilo Gateway можно попробовать без API-ключа, но только для несекретных coding prompts.
- **Официальные бесплатные или пробные квоты**: ключи провайдеров хранятся локально в приложении.
- Локальный Rust proxy переводит протоколы Anthropic и OpenAI-compatible.
- Claude Code может работать через настроенные бесплатные каналы без изменения интерфейса чата.
- Ключи, переопределения моделей и локальные модели настраиваются в settings.

Текущие модели по умолчанию для программирования:

| Канал | Модель по умолчанию |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

## Быстрый старт

```bash
cd app
npm install
npm run dev
```

Запуск desktop-приложения:

```bash
cd app
npm run desktop
```

Сборка production-пакета:

```bash
cd app
npm run package
```

## Использование

### Регистрация бесплатного канала

1. Откройте нижнее меню **Channel** и выберите бесплатный канал с предупреждением, например **Free · OpenRouter**.

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="Выбор ненастроенного бесплатного канала в меню Channel" width="960">
</p>

2. В диалоге API key нажмите **Open registration site**.

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="Открыть сайт регистрации провайдера" width="960">
</p>

3. Создайте новый API key на странице провайдера и скопируйте его.

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="Создать API key провайдера" width="960">
</p>

4. Вставьте ключ в FreeUltraCode и нажмите **Save and Use**. После сохранения предупреждение исчезнет.

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="Бесплатный канал настроен и готов" width="960">
</p>

5. Все каналы также можно управлять через **Settings** -> **Channels** -> **Free Channels**.

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="Управление бесплатными каналами в настройках" width="960">
</p>

Когда канал готов, используйте нижнее поле ввода для чата через этот маршрут.

### Использование Chat для программирования

1. Нажмите **+ New Session** в боковой панели.
2. Выберите runtime, канал, режим разрешений и workspace в нижних элементах управления.
3. Опишите задачу: ожидаемое поведение, затронутые файлы, критерии приемки и ограничения.
4. Во время выполнения FreeUltraCode показывает чтение файлов, поиск, изменения и проверки отдельными строками.
5. Если результат нужно уточнить, продолжайте в том же чате.

## Как это работает

```text
Запрос пользователя
    |
    v
Chat composer
    |
    +--> выбранные runtime / канал / разрешения / workspace
             |
             +--> API провайдера, локальный CLI или локальный free-channel proxy
                        |
                        +--> потоковый вывод, лог инструментов и история чата
```

## Технологии

| Область | Технология |
| --- | --- |
| Desktop shell | Tauri 2, Rust |
| Frontend | React 18, Vite 5, TypeScript 5 |
| State | Zustand |
| Styling | Tailwind CSS, CSS variables |
| Icons | lucide-react |
| Provider routing | Claude Code, Codex, Gemini, расширяемые настройки провайдеров |
| Free-channel proxy | Rust `tiny_http` + `ureq`, перевод Anthropic/OpenAI |

## Структура проекта

```text
app/
  src/
    components/  Общие UI-компоненты
    lib/         Настройки провайдеров, маршрутизация бесплатных каналов, persistence
    panels/      Sidebar, chat dock, settings, scheduling UI
    store/       Zustand state и локальная история
  src-tauri/
    src/
      free_proxy.rs    Rust reverse proxy + Anthropic/OpenAI translation
      lib.rs           Tauri commands, filesystem/history bridge
  doc/                 Tutorials, локализованные README, screenshots
```

## Документация

- [Китайское руководство по регистрации бесплатного канала](register-free-channel.md)
- [English README](../../README.md)

## Разработка

```bash
npm run dev
npm run typecheck
npm run lint
npm run test
npm run desktop
npm run package
```

## Сообщество

- Discord: <https://discord.gg/2C9ptSEFG>
- QQ Group: `149523963`
- Issues: <https://github.com/wellingfeng/FreeUltraCode/issues>

## Лицензия

Лицензия пока не указана.
