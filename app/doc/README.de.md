# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | Deutsch | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

Nicht jede Programmieraufgabe sollte teures Premium-Kontingent verbrauchen. FreeUltraCode bringt Claude Code, Codex, Gemini, kostenlose Kanäle und lokale Modelle in eine lokale Chat-Oberfläche. Nutze günstige Modelle für Recherche und Routinearbeit, und stärkere Modelle für wichtige Entscheidungen.

<p align="center">
  <strong>Routing kostenloser Kanäle</strong><br>
  <img src="images/hero-free-channels.de.png" alt="Screenshot des Routings kostenloser Kanäle in FreeUltraCode" width="960">
</p>

## Warum FreeUltraCode

Coding Agents sind nützlich, aber Premium-Kontingente sind schnell aufgebraucht. FreeUltraCode hält die Chat-Erfahrung lokal und macht es einfach, Anfragen über kostenlose, Test- oder Niedrigkostenkanäle zu routen, wenn diese ausreichen.

- Nutze GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Gemini, DeepSeek, Kimi, Groq, OpenRouter, NVIDIA NIM, Z.ai, Kilo, LLM7, Ollama, LM Studio und llama.cpp.
- API-Keys und Provider-Einstellungen bleiben auf deinem Rechner.
- Runtime, Kanal, Berechtigungsmodus und Workspace lassen sich direkt im Chat Composer wechseln.
- Chat-Verlauf, Favoriten, geplante Prompts und Workspace-Kontext bleiben lokal.
- Lokale Modelle funktionieren ohne API-Key, wenn deine Hardware sie unterstützt.

## Funktionen

### Programmier-Chat

- Frage nach Codeänderungen, Bug-Analyse, Refactoring, Tests, Release Notes oder Dokumentation.
- Füge Dateipfade hinzu oder ziehe Dateien in den Composer.
- Sieh gestreamte Antworten, Befehlslogs, Dateireferenzen und Zusammenfassungen in einer Chat-Oberfläche.
- Stelle Folgefragen in derselben Sitzung.

### Routing kostenloser Modelle

- **20+ Remote-Kanäle plus lokale Runtimes**: NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, plus Ollama, LM Studio und llama.cpp.
- **Experimentelle Routen ohne Key**: LLM7 und Kilo Gateway können ohne API-Key getestet werden, sollten aber nur für nicht sensible Coding-Prompts genutzt werden.
- **Offizielle Gratis- oder Testkontingente**: Provider-Keys werden lokal in der App gespeichert.
- Der lokale Rust-Proxy übersetzt zwischen Anthropic- und OpenAI-kompatiblen Protokollen.
- Claude Code kann über konfigurierte kostenlose Kanäle laufen, ohne die Chat-Oberfläche zu ändern.
- Keys, Modell-Overrides und lokale Modelle werden in den Einstellungen verwaltet.

Aktuelle programmierorientierte Standardmodelle:

| Kanal | Standardmodell |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

## Schnellstart

```bash
cd app
npm install
npm run dev
```

Desktop-App starten:

```bash
cd app
npm run desktop
```

Produktionspaket bauen:

```bash
cd app
npm run package
```

## Nutzung

### Kostenlosen Kanal registrieren

1. Öffne unten das Menü **Channel** und wähle einen kostenlosen Kanal mit Warnsymbol, zum Beispiel **Free · OpenRouter**.

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="Nicht konfigurierten kostenlosen Kanal im Channel-Menü auswählen" width="960">
</p>

2. Klicke im API-Key-Dialog auf **Open registration site**.

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="Registrierungsseite des Providers öffnen" width="960">
</p>

3. Erstelle auf der Provider-Seite einen neuen API-Key und kopiere ihn.

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="Provider API-Key erstellen" width="960">
</p>

4. Füge den Key in FreeUltraCode ein und klicke auf **Save and Use**. Nach dem Speichern verschwindet das Warnsymbol.

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="Konfigurierter kostenloser Kanal ohne Warnsymbol" width="960">
</p>

5. Alle Kanäle kannst du auch unter **Settings** -> **Channels** -> **Free Channels** verwalten.

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="Kostenlose Kanäle in den Einstellungen verwalten" width="960">
</p>

Sobald der Kanal bereit ist, kannst du über die untere Eingabe über diese Route chatten.

### Chat fürs Programmieren nutzen

1. Klicke in der Sidebar auf **+ New Session**.
2. Wähle Runtime, Kanal, Berechtigungsmodus und Workspace in den unteren Steuerelementen.
3. Beschreibe die Programmieraufgabe mit Zielverhalten, betroffenen Dateien, Akzeptanzkriterien und Einschränkungen.
4. Während der Ausführung zeigt FreeUltraCode Dateizugriffe, Suchen, Änderungen und Prüfungen als separate Einträge.
5. Wenn das Ergebnis angepasst werden muss, fahre in derselben Unterhaltung fort.

## Funktionsweise

```text
Nutzeranfrage
    |
    v
Chat Composer
    |
    +--> gewählte Runtime / Kanal / Berechtigungen / Workspace
             |
             +--> Provider-API, lokale CLI oder lokaler Free-Channel-Proxy
                        |
                        +--> gestreamte Ausgabe, Tool-Log und Chat-Verlauf
```

## Technologie

| Bereich | Technologie |
| --- | --- |
| Desktop-Shell | Tauri 2, Rust |
| Frontend | React 18, Vite 5, TypeScript 5 |
| State | Zustand |
| Styling | Tailwind CSS, CSS-Variablen |
| Icons | lucide-react |
| Provider-Routing | Claude Code, Codex, Gemini, erweiterbare Provider-Einstellungen |
| Free-Channel-Proxy | Rust `tiny_http` + `ureq`, Anthropic/OpenAI-Übersetzung |

## Projektstruktur

```text
app/
  src/
    components/  Gemeinsame UI-Komponenten
    lib/         Provider-Einstellungen, Free-Channel-Routing, Persistenz
    panels/      Sidebar, Chat-Dock, Einstellungen, Planung
    store/       Zustand-State und lokaler Verlauf
  src-tauri/
    src/
      free_proxy.rs    Rust Reverse Proxy + Anthropic/OpenAI-Übersetzung
      lib.rs           Tauri-Kommandos, Datei-/Verlaufsbrücke
  doc/                 Tutorials, lokalisierte READMEs, Screenshots
```

## Dokumentation

- [Chinesischer Guide zur Registrierung kostenloser Kanäle](register-free-channel.md)
- [Englische README](../../README.md)

## Entwicklung

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

## Lizenz

Es wurde noch keine Lizenz angegeben.
