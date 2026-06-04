# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | Français | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

Tous les travaux de programmation ne méritent pas de consommer votre quota premium. FreeUltraCode rassemble Claude Code, Codex, Gemini, les canaux gratuits et les modèles locaux dans une interface de chat locale. Utilisez les modèles bon marché pour explorer, puis les modèles plus fiables pour les décisions importantes.

<p align="center">
  <strong>Routage des canaux gratuits</strong><br>
  <img src="images/hero-free-channels.fr.png" alt="Capture d'écran du routage des canaux gratuits de FreeUltraCode" width="960">
</p>

## Pourquoi FreeUltraCode

Les agents de programmation sont utiles, mais les quotas des modèles premium partent vite. FreeUltraCode garde l'expérience de chat locale et facilite le routage des requêtes vers des canaux gratuits, d'essai ou moins chers quand ils suffisent.

- Utilisez GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Gemini, DeepSeek, Kimi, Groq, OpenRouter, NVIDIA NIM, Z.ai, Kilo, LLM7, Ollama, LM Studio et llama.cpp.
- Gardez les clés API et les paramètres fournisseur sur votre machine.
- Changez de runtime, canal, mode d'autorisation et workspace depuis la zone de saisie.
- Conservez localement l'historique, les favoris, les prompts planifiés et le contexte du workspace.
- Utilisez des modèles locaux sans clé API si votre machine les supporte.

## Fonctions principales

### Chat de programmation

- Demandez des modifications de code, une enquête de bug, un refactor, des tests, des notes de version ou de la documentation.
- Ajoutez des chemins de fichiers ou glissez des fichiers dans la zone de saisie.
- Suivez les réponses streamées, les journaux de commandes, les références de fichiers et les résumés dans la même conversation.
- Continuez avec des demandes de suivi dans la même session.

### Routage des modèles gratuits

- **20+ canaux distants et runtimes locaux** : NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, plus Ollama, LM Studio et llama.cpp.
- **Routes expérimentales sans clé** : LLM7 et Kilo Gateway peuvent être essayés sans clé API, mais seulement pour des prompts de code non sensibles.
- **Routes avec quota gratuit ou d'essai** : les clés fournisseur restent stockées localement dans l'application.
- Le proxy Rust local traduit entre les protocoles Anthropic et OpenAI-compatible.
- Claude Code peut passer par les canaux gratuits configurés sans changer l'interface de chat.
- Les clés, les modèles personnalisés et les modèles locaux se gèrent depuis les paramètres.

Modèles par défaut orientés programmation :

| Canal | Modèle par défaut |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

## Démarrage rapide

```bash
cd app
npm install
npm run dev
```

Pour l'application desktop :

```bash
cd app
npm run desktop
```

Pour créer un package de production :

```bash
cd app
npm run package
```

## Utilisation

### Enregistrer un canal gratuit

1. Ouvrez le menu **Channel** en bas et choisissez un canal gratuit avec un symbole d'avertissement, par exemple **Free · OpenRouter**.

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="Choisir un canal gratuit non configuré dans le menu Channel" width="960">
</p>

2. Dans la boîte de dialogue de clé API, cliquez sur **Open registration site**.

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="Ouvrir le site d'inscription du fournisseur" width="960">
</p>

3. Créez une nouvelle clé API sur la page du fournisseur, puis copiez-la.

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="Créer une clé API fournisseur" width="960">
</p>

4. Collez la clé dans FreeUltraCode et cliquez sur **Save and Use**. Après l'enregistrement, le symbole d'avertissement disparaît.

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="Canal gratuit configuré et prêt" width="960">
</p>

5. Vous pouvez aussi gérer tous les canaux depuis **Settings** -> **Channels** -> **Free Channels**.

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="Gérer les canaux gratuits dans les paramètres" width="960">
</p>

Quand le canal est prêt, utilisez la zone de saisie du bas pour discuter via cette route.

### Utiliser le chat pour programmer

1. Cliquez sur **+ New Session** dans la barre latérale.
2. Choisissez le runtime, le canal, le mode d'autorisation et le workspace depuis les contrôles du bas.
3. Décrivez la demande de programmation avec le comportement attendu, les fichiers concernés, les critères d'acceptation et les contraintes.
4. Pendant l'exécution, FreeUltraCode affiche les lectures de fichiers, recherches, modifications et vérifications sous forme d'entrées séparées.
5. Si le résultat doit être ajusté, continuez dans la même conversation avec une demande de suivi.

## Fonctionnement

```text
Demande utilisateur
    |
    v
Zone de chat
    |
    +--> runtime / canal / autorisations / workspace sélectionnés
             |
             +--> API fournisseur, CLI local ou proxy local de canal gratuit
                        |
                        +--> sortie streamée, journal d'outils et historique
```

## Stack technique

| Domaine | Technologie |
| --- | --- |
| Shell desktop | Tauri 2, Rust |
| Frontend | React 18, Vite 5, TypeScript 5 |
| État | Zustand |
| Style | Tailwind CSS, variables CSS |
| Icônes | lucide-react |
| Routage fournisseur | Claude Code, Codex, Gemini, provider settings extensibles |
| Proxy canaux gratuits | Rust `tiny_http` + `ureq`, traduction Anthropic/OpenAI |

## Structure du projet

```text
app/
  src/
    components/  Composants UI partagés
    lib/         Paramètres fournisseur, routage des canaux gratuits, persistance
    panels/      Sidebar, chat dock, paramètres, planification
    store/       État Zustand et historique local
  src-tauri/
    src/
      free_proxy.rs    Proxy inverse Rust + traduction Anthropic/OpenAI
      lib.rs           Commandes Tauri, pont fichiers/historique
  doc/                 Tutoriels, README localisés, captures
```

## Documentation

- [Guide chinois d'inscription à un canal gratuit](register-free-channel.md)
- [README anglais](../../README.md)

## Développement

```bash
npm run dev
npm run typecheck
npm run lint
npm run test
npm run desktop
npm run package
```

## Communauté

- Discord: <https://discord.gg/2C9ptSEFG>
- QQ Group: `149523963`
- Issues: <https://github.com/wellingfeng/FreeUltraCode/issues>

## Licence

Aucune licence n'a encore été spécifiée.
