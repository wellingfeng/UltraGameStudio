# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | Deutsch | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

In einer Game-Engine macht Code nur einen kleinen Teil der Arbeit aus. Der Rest sind Assets und Pipeline: Materialien, Blueprints, Terrain, Himmel, UI, Skelettanimation, Packaging, Performance. FreeUltraCode ist ein Coding-Agent im Stil von Claude Code / Codex / Gemini, der um diese Realität herum neu gebaut wurde: Er versteht Game-Engine-Konzepte, generiert die volle Bandbreite an Game-Assets (Bilder, 3D-Modelle, 2D-Sprite-Animation, Atlanten, Audio, Rigging, Video) und routet Routinearbeit über kostenlose oder günstige Kanäle, damit Premium-Kontingent dort eingesetzt wird, wo es zählt.

<p align="center">
  <strong>Unreal-Engine-UMG-Oberfläche per Klick</strong><br>
  <img src="images/game/JMsXEKE.png" alt="FreeUltraCode erzeugt eine Unreal-Engine-UMG-Oberfläche per Klick" width="960">
</p>

<p align="center">
  <strong>3D-Modell-Generierung per Klick</strong><br>
  <img src="images/game/noYfqPt.png" alt="FreeUltraCode erzeugt ein 3D-Modell per Klick" width="960">
  <br><br>
  <img src="images/20260615-214236.jpg" alt="Vorschau eines von FreeUltraCode generierten 3D-Modells" width="960">
</p>

<p align="center">
  <strong>Bilder, Sprites, Meshes, Audio, Rigging und Video — verwaltet durch einen einzigen Coding-Agenten</strong><br>
  <img src="images/game/gmclmLS.png" alt="FreeUltraCode einheitliche Game-Asset-Generierung" width="960">
  <br><br>
  <img src="images/game/jXgMffC.png" alt="FreeUltraCode Game-Asset-Workflow" width="960">
</p>

## Warum FreeUltraCode

KI ist heute gut genug, um den Großteil des Codes selbst zu schreiben. Die Rolle des Programmierers verschiebt sich hin zum Beschreiben von Absichten, Verifizieren von Ergebnissen und Orchestrieren von Agenten. Aber ein Spiel ist nicht nur Code. Eine Game-Engine ist voll von Materialien, Blueprints, Terrain, Himmel, UI, Skelettanimation, Packaging und Performance-Tuning — und die meisten generischen Coding-Agenten verstehen davon nichts.

FreeUltraCode nimmt einen Agenten im Stil von Claude Code / Codex / Gemini und passt ihn tiefgreifend für die Spieleentwicklung an:

- **Spricht die Sprache der Game-Engine.** Der Agent ist mit Konzepten der Spieleentwicklung vorbereitet und kann über Materialien, Blueprints, Terrain, Beleuchtung, UI (UMG u. a.), Skelettanimation, Build/Packaging und Performance-Optimierung schlussfolgern.
- **Generiert jeden Asset-Typ, den ein Spiel braucht.** Bilder, 3D-Modelle, 2D-Sprite-Animation, Sprite-Atlanten, Audio, Skelett-Rigging und Video entstehen über dieselbe Oberfläche und werden über einen einzigen Agent-Workflow verwaltet.
- **Integriertes Game-Dev-Expertenteam.** Über 40 Spezialrollen (Technical Director, Gameplay-/KI-/Netzwerk-/Tools-Programmierer, Level-/Economy-Designer, Art- und Audio-Direktoren, QA, Release Manager u. a.) für Unity, Unreal, Godot und Web.
- **Bewahrt Premium-Kontingent für das Wesentliche.** Route Routinearbeit über kostenlose, Test- oder günstige Kanäle, und halte Keys, Einstellungen und Verlauf lokal.

## Funktionen

### Game-Dev-Coding-Chat

- Frage nach Gameplay-Code, Engine-Integration, Shader-/Material-Logik, Build-Skripten, Bug-Analyse, Refactoring, Tests und Release Notes.
- Arbeite an Unity-, Unreal-, Godot- oder Web-Engine-Projekten — der Agent schlussfolgert über Engine-Konzepte, nicht nur über Dateien.
- Füge Dateipfade hinzu oder ziehe Dateien in den Composer.
- Sieh gestreamte Antworten, Befehlslogs, Dateireferenzen und Zusammenfassungen in einer Chat-Oberfläche.
- Stelle Folgefragen in derselben Sitzung.

### Game-Asset-Generierung

Jeder Asset-Typ, den ein Spiel braucht, lässt sich über dieselbe Oberfläche generieren, ins Projekt einbauen und ans Programmiermodell zurückgeben — alles im selben Verlauf. Jeder Generator läuft über den von dir konfigurierten Provider.

| Asset | Was er erstellt | Modus |
| --- | --- | --- |
| Bilder | Concept Art, UI-Mockups, Icons, Poster, Texturen, Referenzen | `/image`, `/img`, `/draw`, `/生图` oder `/image-mode-start` |
| ComfyUI-Graphen | Knotenbasierte, editierbare Bild-Pipelines | `/comfyui-mode-start` |
| 2D-Sprites | Game-Sprites, Sequenz-Frames, Spritesheets | `/sprite` oder `/sprite-mode-start` |
| 3D-Modelle | Props, Charaktere, Szenen-Meshes, Blockouts | `/mesh-mode-start` (Suche via `/mesh-search`) |
| Musik | BGM, Score, Musik-Clips | `/music` oder `/music-mode-start` |
| Sprache | Voice-Lines und Narration | `/speech-mode-start` |
| Video | Videoclips und animierte Assets | `/video` oder `/video-mode-start` |

Der Agent verbessert zuerst deinen Prompt, sendet ihn an den konfigurierten Provider und zeigt das Ergebnis im Chat-Stream. Verlasse jeden Modus mit dem passenden `*-mode-end`-Befehl.

### Game-Dev-Expertenteam

FreeUltraCode liefert über 40 Spezialisten der Spieleentwicklung, die der Agent je nach Aufgabe automatisch heranzieht:

- **Engine-Spezialisten** für Unity, Unreal, Godot (GDScript / C# / GDExtension / Shader) und Web.
- **Programmierung**: Technical Director, Lead-/Engine-/Gameplay-/KI-/Netzwerk-/Tools-/UI-Programmierer.
- **Design**: Gameplay-, Level-, Economy-, Live-Ops- und Narrative-Designer.
- **Art & Audio**: Direktoren und Spezialisten, VFX, Sound Design, Audio-Leitung.
- **Produktion, Qualität & Release**: Producer, QA-Lead/Tester, DevOps, Sicherheit, Lokalisierung, Release Manager.

Konfiguriere die aktive Engine, den Council-Modus und die aktivierten Experten in **Settings**.

### Routing kostenloser Modelle

- **20+ Remote-Kanäle plus lokale Runtimes**: NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, plus Ollama, LM Studio und llama.cpp.
- **Experimentelle Routen ohne Key**: LLM7 und Kilo Gateway können ohne API-Key getestet werden, sollten aber nur für nicht sensible Coding-Prompts genutzt werden.
- **Offizielle Gratis- oder Testkontingente**: Provider-Keys werden lokal in der App gespeichert.
- Der lokale Rust-Proxy übersetzt zwischen Anthropic- und OpenAI-kompatiblen Protokollen.
- Claude Code kann über konfigurierte kostenlose Kanäle laufen, ohne die Chat-Oberfläche zu ändern.
- Keys, Modell-Overrides und lokale Modelle werden in den Einstellungen verwaltet.

<p align="center">
  <strong>Routing kostenloser Kanäle</strong><br>
  <img src="images/hero-free-channels.de.png" alt="Screenshot des Routings kostenloser Kanäle in FreeUltraCode" width="960">
</p>

Aktuelle programmierorientierte Standardmodelle:

| Kanal | Standardmodell |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

### Dynamischer Workflow (/ultracode)

Für komplexe mehrstufige Programmieraufgaben generiert `/ultracode <Aufgabe>` spontan ein maßgeschneidertes Ausführungs-Harness und führt es sofort aus. Kein visuelles Canvas nötig.

- Beschreibe die Aufgabe in natürlicher Sprache — der Planer baut ein Harness mit parallelen Subagenten, adversarieller Verifikation und Akzeptanzgattern.
- Sechs interne Strategien werden automatisch gewählt: Klassifizieren & Handeln, Fächer & Synthese, Adversarielle Verifikation, Generieren & Filtern, Turnier, Schleife bis zur Fertigstellung.
- Jeder Lauf wird vollständig unter `.fuc-run/<run-id>/` protokolliert: Aufgabenbuch, Ereignisse, Urteil und Endergebnis.
- Ausführung über die Desktop-App oder CLI: `fuc ultracode "<Aufgabe>" --json --interactive --cwd <workspace>`.
- Null Konfiguration — verwendet die lokalen `claude` CLI-Anmeldeinformationen.

#### Free Auto — Automatische Mehrkanal-Umschaltung

Der **Auto**-Kanal (`freecc:auto` im Channel-Menü) leitet jede Anfrage automatisch an den besten verfügbaren kostenlosen Kanal weiter — ohne manuelles Umschalten.

- Rotiert durch alle konfigurierten kostenlosen Kanäle und überspringt automatisch Kanäle mit Ratenbegrenzung (429) oder Upstream-Fehlern (5xx).
- Verfolgt kanalspezifische Abkühlzeiten mit Backoff: nach einem Fehler pausiert ein Kanal für eine gewisse Zeit.
- Unterstützt optionale Modell-Überschreibung, sodass alle automatisch gerouteten Anfragen dasselbe Modell nutzen.
- Wenn alle Kanäle erschöpft sind, wird ein 503 mit Fehlerprotokoll zurückgegeben.

#### Multi-Provider-Kette: DeepSeek → CodeX

Mit `/ultracode` kann das Harness mehrere Provider über die Planschritte hinweg automatisch verketten. Typisches Muster: DeepSeek erzeugt kostengünstige Entwürfe, CodeX übernimmt die Verfeinerung zur finalen Qualität.

- Der **dynamische Harness-Plan** unterstützt `model`-Überschreibungen pro Schritt — DeepSeek für Brainstorming/Klassifikation, CodeX/Gemini für Implementierung/Verifikation.
- **cc-switch-Kompatibilität**: FreeUltraCode liest die `cc-switch` CLI-Konfiguration; jeder für Claude Code konfigurierte Provider ist sofort für Ultracode-Schritte verfügbar.
- Die **Fächer-und-Synthese**-Strategie parallelisiert DeepSeek-Worker über unabhängige Teilaufgaben, ein Konsens-Gate (CodeX) synthetisiert und verifiziert die Ergebnisse.

#### Geschwindigkeitsbewusste Kanalauswahl

Der Auto-Kanal des Free-Proxy priorisiert Kanäle basierend auf Echtzeit-Verfügbarkeitssignalen:

- **Ratenbegrenzungs-Bewusstsein**: Kanäle mit 429 werden für 30+ Sekunden abgekühlt, um vergebliche Versuche zu vermeiden.
- **Schnelles Fehlschlagen bei Fehlern**: Nicht-wiederholbare Fehler (4xx Auth, 5xx Upstream) werden mit Cooldowns verfolgt; der Auto-Router überspringt sie.
- **Verbindungszeit-Budget**: Jeder Kanalversuch unterliegt dem Upstream-Timeout; der Auto-Router blockiert nicht an einem einzigen langsamen Upstream.
- **Natürliche Reaktivitäts-Reihenfolge**: Erfolgreiche Kanäle werden zuerst versucht; fehlerhafte Kanäle ans Ende der Liste verschoben.

Diese Funktionen sorgen für resiliente `/ultracode`-Harness-Läufe, selbst wenn einzelne kostenlose Provider langsam, ratenbegrenzt oder vorübergehend nicht verfügbar sind.

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

### Game-Assets generieren

Asset-Modi machen den Chat Composer zur Asset-Generierung, ohne den Verlauf zu verlassen. Praktisch für UI-Mockups, Icons, Texturen, Sprites, 3D-Modelle, Audio und Video, bevor du zum Code zurückkehrst. Das Beispiel unten nutzt den Bildmodus; Sprite-, Mesh-, Musik-, Sprach- und Video-Modus funktionieren gleich mit ihren `*-mode-start`-Befehlen.

1. Öffne **Settings** -> **Images** (oder den passenden Asset-Bereich), wähle den Standard-Provider und trage API-Key, Account ID, Base URL oder lokalen ComfyUI-Endpunkt ein.
2. Schreibe in einer Chat-Sitzung `/image-mode-start`. Du kannst den Modus starten und direkt generieren:

```text
/image-mode-start eine stilisierte Steinmauer-Textur für einen Fantasy-Dungeon, tileable, 1024x1024
```

3. Solange der Modus aktiv ist, erzeugen normale Nachrichten Assets statt Codeänderungen. Der **Channel**-Selector zeigt dann Asset-Provider.
4. Beschreibe das gewünschte Asset. FreeUltraCode lässt zuerst das Programmiermodell den Prompt verbessern und sendet ihn danach an den konfigurierten Provider.

<p align="center">
  <img src="images/生图/session-2026-06-07-2351.png" alt="Der Asset-Modus erzeugt Elemente in derselben FreeUltraCode-Sitzung" width="720">
</p>

5. Sende `/image-mode-end`, um zum Programmierkanal und Modell zurückzukehren. Für ein einzelnes Asset ohne dauerhaften Modus nutze `/image`, `/img`, `/draw`, `/生图`, `/sprite`, `/music` oder `/video` plus Prompt.

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
    lib/         Provider-Einstellungen, Free-Channel-Routing, Asset-Generierung (Bild/Sprite/3D/Musik/Sprache/Video/ComfyUI), Game-Dev-Expertenteam, Persistenz
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
