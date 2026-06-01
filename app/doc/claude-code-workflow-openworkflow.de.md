# Claude Code hat Dynamic Workflows. Was ist mit anderen Modellen? Eine Open-Source-Alternative: OpenWorkflows

## In letzter Zeit beschäftige ich mich mit den neuen dynamic workflows von Claude Code. Im Vergleich zu MCP, Skill und Hooks sprechen noch wenige über diese neue Funktion. Im Folgenden nenne ich sie einfach workflows.

Bei komplexen Aufgaben schreiben viele zuerst eine Recherche-HTML, wandeln sie dann in eine technische Planungs-HTML um und geben sie schließlich an eine KI zur Entwicklung weiter. Oft ist das Ergebnis aber nicht gut. Der Hauptgrund ist: HTML ist Text für Menschen. Es ist kein Script und enthält zu wenig strukturierte Informationen. Reihenfolge, Parallelisierbarkeit, klare Grenzen, Aufgabenaufteilung und der Informationsaustausch zwischen Aufgaben sind nicht eindeutig. Die KI muss zu viel erraten.

Workflows selbst sind Scripts und können dieses Problem direkter lösen.

Außerdem bringen workflows mehrere Perspektiven, adversariale Prüfung und Abstimmung über Lösungspläne mit. Genau deshalb sind sie oft genauer. Sie gewinnen über Skalierung: fünf Agents laufen gleichzeitig auf dasselbe Problem los, danach fasst ein weiterer Agent die Ergebnisse zusammen. Das ist tatsächlich genauer, verbraucht aber auch sehr viele Tokens.

Wenn das so allgemein nützlich ist, warum sollte es an ein bestimmtes Modell oder eine bestimmte CLI gebunden sein?

Aus diesem Gedanken heraus habe ich OpenWorkflows entwickelt, genauer gesagt hat die KI es entwickelt. OpenWorkflows macht Claude-Code-artige workflows zu einer visuellen Leinwand und versucht, denselben Ablauf auf Claude Code, Codex, Gemini und weitere lokale oder Cloud-Runtimes auszurichten.

Diesmal geht es nicht um abstrakte Konzepte. Ich gehe direkt anhand der Screenshots durch ein Beispiel: OpenWorkflows soll mehrere Oberflächenstile unterstützen, standardmäßig Pencil verwenden und den Wechsel unter Einstellungen / Erscheinungsbild erlauben.

Während der Entwicklung habe ich versucht, so viel wie möglich in OpenWorkflows selbst zu erledigen, damit es sich selbst bootstrappen kann.

Der folgende Prozess verwendet CodeX als Standardmodell für die Entwicklung.

### 0. Zuerst die fertige Oberfläche

<p align="center">
  <img src="images/0-标题使用.png" alt="OpenWorkflows Hauptoberfläche" width="960">
</p>

In der Hauptoberfläche von OpenWorkflows liegt der workflows-Blueprint in der Mitte, die Knoteneigenschaften sind rechts, und unten befinden sich KI-Eingabe und Ausgabe.

Die Oberfläche besteht grob aus vier Teilen: workflows-Verlauf links, visuelle Leinwand in der Mitte, Knoteneigenschaften und häufige Prompts rechts sowie KI-Eingabe und Antworten unten.

### 1. OpenWorkflows herunterladen

<p align="center">
  <img src="images/1-下载.png" alt="OpenWorkflows GitHub Releases" width="840">
</p>

Die neueste Version findet man rechts auf der GitHub-Projektseite unter Releases.

### 2. Zuerst das Modell konfigurieren

Standardmäßig startet OpenWorkflows über die im System konfigurierte CLI. Tools wie CC-Switch können dafür verwendet werden.

### 3. Neue workflows erstellen und die Anforderung eingeben

<p align="center">
  <img src="images/3-新建workflow.png" alt="Neue workflows erstellen und Anforderung eingeben" width="840">
</p>

Nach der Modellkonfiguration klickt man links auf "Neue workflows". Auf der Leinwand erscheint eine Minimalstruktur: Start, ein Agent und End.

Man muss die Knoten nicht wirklich von Hand zeichnen. Der Einstieg ist das KI-Eingabefeld unten rechts. In diesem Beispiel gebe ich ein:

```text
Ich möchte, dass OpenWorkflows mehrere Oberflächenstile unterstützt,
standardmäßig Pencil verwendet
und unter Einstellungen / Erscheinungsbild umschalten kann.
```

Danach kann man Ctrl+Enter drücken oder rechts unten auf Senden klicken. OpenWorkflows verwandelt diese natürliche Sprache in einen editierbaren workflows-Blueprint.

### 4-1. Workflows-Blueprint generieren

<p align="center">
  <img src="images/4-1生成workflow蓝图.png" alt="Generierter workflows-Blueprint" width="960">
</p>

Nach dem Absenden erweitert OpenWorkflows den aktuellen Schritt zuerst zu einem vollständigen workflow.

Der Blueprint im Screenshot sieht ungefähr so aus:

```text
Start
  -> Erscheinungsbild-Unterstützung parallel klären
      -> Bestehende Einstiegspunkte untersuchen
      -> Mehrstil-System entwerfen
      -> Pencil-Standardstil entwerfen
  -> Implementierungsplan zusammenfassen
  -> Mehrere Oberflächenstile implementieren
  -> Umschaltung in Einstellungen / Erscheinungsbild anbinden
  -> Validierung und Regression prüfen
  -> Lieferergebnis dokumentieren
  -> End
```

Rechts in den Knoteneigenschaften lassen sich die Eigenschaften des ausgewählten Knotens weiter ändern. Häufiger nutzt man aber das Eingabefeld unten und lässt die KI die Blueprint-Knoten weiter anpassen, sodass der Ablauf iterativ verbessert wird.

### 4-2. Das generierte Script ansehen

<p align="center">
  <img src="images/4-2蓝图脚本.png" alt="Generiertes workflows-Script" width="960">
</p>

Oben gibt es einen Eintrag "Script". Nach dem Öffnen sieht man das Script, das aus dem aktuellen Blueprint erzeugt wurde.

Im Screenshot erkennt man Strukturen wie parallel(...) und agent(...). Parallele Knoten werden zu gleichzeitig ausgeführten Zweigen, normale Knoten zu einzelnen Agent-Aufrufen.

Das zeigt auch: OpenWorkflows zeichnet nicht nur Kästen. Hinter der Leinwand steht eine einheitliche workflows-Struktur, die später an unterschiedliche Runtimes angebunden werden kann.

### 5. Mit häufigen Prompts rechts weiter ändern

<p align="center">
  <img src="images/5-使用常用提示词.png" alt="Mit häufigen Prompts workflows weiter ändern" width="960">
</p>

Nach dem Generieren muss man den Blueprint nicht sofort ausführen. Die "Häufigen Prompts" rechts eignen sich besser, um den Prozess weiter zu verfeinern. Natürlich kann man auch eigene Prompts schreiben.

Die Prompts sind nach Szenarien gruppiert, etwa interaktive Klärung, Klarheit, Vollständigkeit, Kosten, Struktur, Zuverlässigkeit, Performance und Parallelität sowie Validierung und Tests.

Im Screenshot wird "Anforderung klären" verwendet. Dadurch wird ein Prompt in die KI-Eingabe eingefügt, der verlangt, dass die KI vor Änderungen am Blueprint zuerst wichtige Unklarheiten interaktiv bestätigt.

Dieses Design ist praktisch. Viele workflows scheitern nicht daran, dass das Modell die Aufgabe nicht kann, sondern daran, dass Ziel, Grenzen, Fehlerpfade und Kostenstrategie am Anfang nicht klar genug waren.

Es gibt außerdem häufige Prompts wie grill-me, Grenzbedingungen ergänzen, Parallelisierung optimieren und Single Principle. Man kann eigene Prompts hinzufügen oder bestehende ändern.

### 6. Grenzen über interaktive Auswahl bestätigen

<p align="center">
  <img src="images/6-交互选择.png" alt="Interaktive Auswahl zur Grenzbestätigung" width="640">
</p>

Nach "Anforderung klären" ändert die KI den Graphen nicht direkt, sondern fragt zuerst: "In welchem Umfang soll die Umschaltung der Oberflächenstile umgesetzt werden?"

Der Screenshot bietet zwei Optionen: nur den Pencil-Standardstil umsetzen und eine Erweiterungsstruktur vorsehen, oder Pencil plus mehrere umschaltbare Stile umsetzen.

Nach der Auswahl schreibt die KI diese Entscheidung zurück in den workflows-Blueprint und gibt den aktualisierten IRGraph aus. Dieser Schritt reduziert das Risiko, dass die KI eigenmächtig in die falsche Richtung geht.

### 7. Ausführen

<p align="center">
  <img src="images/7-运行.png" alt="Workflows ausführen" width="960">
</p>

Wenn Blueprint-Struktur, Modellkonfiguration und wichtige Grenzen bestätigt sind, klickt man oben auf "Ausführen".

Ich würde nicht sofort nach dem Generieren ausführen. Zuerst sollte man prüfen, ob die parallelen Zweige sinnvoll sind, ob der Zusammenfassungsknoten nach den parallelen Zweigen kommt und ob die Validierung das Endergebnis abdeckt.

Wenn nur die Verantwortung eines Knotens unklar ist, kann man ihn zuerst in den Knoteneigenschaften ändern und dann erneut ausführen.

### 8. Laufstatus beobachten

<p align="center">
  <img src="images/8-运行中.png" alt="Laufstatus der workflows beobachten" width="960">
</p>

Nach dem Start wird der obere Button zu "Läuft... Stop". Die KI-Eingabe unten wird gesperrt, damit der Blueprint während der Ausführung nicht durcheinander gerät.

Auf der Leinwand sieht man den Knotenstatus. Im Screenshot ist Start abgeschlossen, der folgende parallele Knoten läuft, und rechts oben sieht man die Laufzählung. Wenn etwas zwischendurch fehlschlägt, kann man von der vorherigen Aufgabe aus fortsetzen.

### 9. Oberflächenstil wechseln

<p align="center">
  <img src="images/9-切换风格.png" alt="Oberflächenstil wechseln" width="840">
</p>

Nachdem OpenWorkflows die Entwicklung abgeschlossen hat, startet man das Programm neu und wechselt unter Einstellungen / Erscheinungsbild zwischen verschiedenen Stilen.

Im Screenshot sieht man Stil-Karten wie Pencil, Deep Night, Aurora, Daylight und Ember. Die Auswahl beeinflusst globalen Hintergrund, Panels, Rahmen und Farben für Laufzustände.

### Was ich wirklich nützlich finde

Der größte Wert von OpenWorkflows liegt nicht darin, einen Prompt mit einer UI zu verpacken.

Es verbindet "Anforderung -> Blueprint -> Script -> Ausführen -> Verlauf prüfen". Man kann zuerst mit natürlicher Sprache einen Ablauf erzeugen, dann die Struktur auf der Leinwand prüfen, bei Bedarf mit häufigen Prompts Grenzen ergänzen und erst danach ausführen.

Dieselben workflows müssen nicht an ein einziges Modell gebunden sein. Einfache Knoten können günstige Modelle verwenden, wichtige Knoten stärkere Modelle, und das Ausführungsziel kann weiter auf Claude Code, Codex, Gemini oder andere Runtimes erweitert werden.

Für komplexe KI-Coding-Aufgaben ist diese Zerlegung leichter zu pflegen als ein extrem langer Prompt. Scheitert ein Knoten, ändert man diesen Knoten. Ist ein Zweig unnötig, löscht man ihn. Will man etwas wiederverwenden, macht man aus dem Verlauf weiter.

### Noch früh, aber die Richtung ist interessant

Das ganze Konzept workflows ist noch früh, und OpenWorkflows selbst steht ebenfalls am Anfang. Runtime-Adapter, Knotenmöglichkeiten und Script-Ökosystem werden sich weiter verändern.

Die Richtung ist aber klar: KI-Coding wird nicht dauerhaft bei "Chatfenster öffnen und jeden Schritt manuell weiterschieben" bleiben.

Komplexe Aufgaben werden am Ende zu workflows, weil sie sichtbar, editierbar, migrierbar und wiederverwendbar sind.

QQ-Gruppe: 149523963

Projekt:

https://github.com/wellingfeng/OpenWorkflows

Referenz:

https://code.claude.com/docs/en/workflows
