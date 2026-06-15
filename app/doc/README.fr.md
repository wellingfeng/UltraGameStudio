# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | Français | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

Dans un moteur de jeu, le code ne représente qu'une petite partie du travail. Le reste, ce sont les assets et le pipeline : matériaux, blueprints, terrain, ciel, UI, animation squelettique, packaging, performances. FreeUltraCode est un agent de programmation de type Claude Code / Codex / Gemini reconstruit autour de cette réalité : il comprend les concepts des moteurs de jeu, génère toute la gamme d'assets de jeu (images, modèles 3D, animation de sprites 2D, atlas, audio, rigging, vidéo) et route le travail de routine vers des canaux gratuits ou peu coûteux pour préserver le quota premium.

<p align="center">
  <strong>Interface UMG Unreal Engine en un clic</strong><br>
  <img src="images/game/JMsXEKE.png" alt="FreeUltraCode génère une interface UMG Unreal Engine en un clic" width="960">
</p>

<p align="center">
  <strong>Génération de modèle 3D en un clic</strong><br>
  <img src="images/game/noYfqPt.png" alt="FreeUltraCode génère un modèle 3D en un clic" width="960">
  <br><br>
  <img src="images/20260615-214236.jpg" alt="Aperçu du modèle 3D généré par FreeUltraCode" width="960">
</p>

<p align="center">
  <strong>Images, sprites, meshes, audio, rigging et vidéo — gérés par un seul agent de programmation</strong><br>
  <img src="images/game/gmclmLS.png" alt="Génération unifiée d'assets de jeu FreeUltraCode" width="960">
  <br><br>
  <img src="images/game/jXgMffC.png" alt="Workflow d'assets de jeu FreeUltraCode" width="960">
</p>

## Pourquoi FreeUltraCode

L'IA est désormais capable d'écrire la majeure partie du code seule. Le rôle du programmeur évolue vers la description de l'intention, la vérification des résultats et l'orchestration des agents. Mais un jeu, ce n'est pas que du code. Un moteur de jeu est plein de matériaux, blueprints, terrain, ciel, UI, animation squelettique, packaging et optimisation des performances — et la plupart des agents de programmation génériques n'y comprennent rien.

FreeUltraCode prend un agent de type Claude Code / Codex / Gemini et le personnalise en profondeur pour le développement de jeux :

- **Parle le langage des moteurs de jeu.** L'agent est préparé avec les concepts du développement de jeux pour raisonner sur les matériaux, blueprints, terrain, éclairage, UI (UMG et autres), animation squelettique, build/packaging et optimisation des performances.
- **Génère tous les types d'assets dont un jeu a besoin.** Images, modèles 3D, animation de sprites 2D, atlas de sprites, audio, rigging squelettique et vidéo sont produits depuis la même interface et gérés via un seul workflow d'agent.
- **Équipe d'experts en développement de jeux intégrée.** Plus de 40 rôles spécialisés (directeur technique, programmeur gameplay/IA/réseau/outils, designer de niveau/économie, directeurs artistique et audio, QA, release manager, etc.) couvrant Unity, Unreal, Godot et le Web.
- **Garde le quota premium pour l'essentiel.** Routez le travail de routine vers des canaux gratuits, d'essai ou peu coûteux, et gardez clés, paramètres et historique en local.

## Fonctions principales

### Chat de développement de jeux

- Demandez du code gameplay, de l'intégration moteur, de la logique shader/matériau, des scripts de build, des enquêtes de bug, des refactors, des tests et des notes de version.
- Travaillez sur des projets Unity, Unreal, Godot ou Web — l'agent raisonne sur les concepts du moteur, pas seulement sur les fichiers.
- Ajoutez des chemins de fichiers ou glissez des fichiers dans la zone de saisie.
- Suivez les réponses streamées, les journaux, les références de fichiers et les résumés dans la même conversation.
- Continuez avec des demandes de suivi dans la même session.

### Génération d'assets de jeu

Chaque type d'asset dont un jeu a besoin peut être généré depuis la même interface et appliqué à votre projet, puis renvoyé au modèle de programmation — le tout dans le même historique. Chaque générateur passe par le fournisseur que vous avez configuré.

| Asset | Ce qu'il produit | Mode |
| --- | --- | --- |
| Images | Concept art, maquettes UI, icônes, affiches, textures, références | `/image`, `/img`, `/draw`, `/生图` ou `/image-mode-start` |
| Graphes ComfyUI | Pipelines d'images éditables à base de nœuds | `/comfyui-mode-start` |
| Sprites 2D | Sprites de jeu, frames de séquence, spritesheets | `/sprite` ou `/sprite-mode-start` |
| Modèles 3D | Props, personnages, meshes de scène, blockouts | `/mesh-mode-start` (recherche via `/mesh-search`) |
| Musique | BGM, bande-son, clips musicaux | `/music` ou `/music-mode-start` |
| Voix | Répliques et narration | `/speech-mode-start` |
| Vidéo | Clips vidéo et assets animés | `/video` ou `/video-mode-start` |

L'agent améliore d'abord votre prompt, l'envoie au fournisseur configuré et affiche le résultat dans le flux de chat. Quittez n'importe quel mode avec la commande `*-mode-end` correspondante.

### Équipe d'experts en développement de jeux

FreeUltraCode embarque plus de 40 spécialistes du développement de jeux que l'agent mobilise automatiquement selon la tâche :

- **Spécialistes moteur** pour Unity, Unreal, Godot (GDScript / C# / GDExtension / shaders) et le Web.
- **Programmation** : directeur technique, programmeurs lead/moteur/gameplay/IA/réseau/outils/UI.
- **Design** : designers gameplay, niveau, économie, live-ops et narratif.
- **Art & audio** : directeurs et spécialistes, VFX, sound design, direction audio.
- **Production, qualité et release** : producteur, QA lead/testeur, devops, sécurité, localisation, release manager.

Configurez le moteur actif, le mode council et les experts activés dans **Settings**.

### Routage des modèles gratuits

- **20+ canaux distants et runtimes locaux** : NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, plus Ollama, LM Studio et llama.cpp.
- **Routes expérimentales sans clé** : LLM7 et Kilo Gateway peuvent être essayés sans clé API, mais seulement pour des prompts de code non sensibles.
- **Routes avec quota gratuit ou d'essai** : les clés fournisseur restent stockées localement dans l'application.
- Le proxy Rust local traduit entre les protocoles Anthropic et OpenAI-compatible.
- Claude Code peut passer par les canaux gratuits configurés sans changer l'interface de chat.
- Les clés, les modèles personnalisés et les modèles locaux se gèrent depuis les paramètres.

<p align="center">
  <strong>Routage des canaux gratuits</strong><br>
  <img src="images/hero-free-channels.fr.png" alt="Capture d'écran du routage des canaux gratuits de FreeUltraCode" width="960">
</p>

Modèles par défaut orientés programmation :

| Canal | Modèle par défaut |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

### Workflow dynamique (/ultracode)

Pour les tâches de programmation complexes en plusieurs étapes, `/ultracode <tâche>` génère à la volée un harness d'exécution sur mesure et l'exécute immédiatement. Aucun canevas visuel n'est nécessaire.

- Décrivez la tâche en langage naturel — le planificateur construit un harness avec des sous-agents parallèles, une vérification adversariale et des portes d'acceptation.
- Six stratégies internes sont choisies automatiquement : classification-action, éventail-synthèse, vérification adversariale, génération-filtrage, tournoi, boucle jusqu'à complétion.
- Chaque exécution est entièrement journalisée sous `.fuc-run/<run-id>/` avec registre de tâches, événements, verdict et résultat final.
- Lancement depuis l'application desktop ou en CLI : `fuc ultracode "<tâche>" --json --interactive --cwd <workspace>`.
- Zéro configuration — réutilise les identifiants de connexion locaux de la CLI `claude`.

#### Free Auto — Basculement automatique multi-canal

Le canal **Auto** (`freecc:auto` dans le menu Channel) achemine automatiquement chaque requête vers le meilleur canal gratuit disponible, sans intervention manuelle.

- Alterne entre tous les canaux gratuits configurés, en sautant automatiquement ceux qui atteignent les limites de débit (429) ou retournent des erreurs upstream (5xx).
- Suivi des refroidissements par canal avec backoff : quand un canal retourne une erreur, il est mis en pause avant d'être réessayé.
- Prend en charge un remplacement de modèle optionnel pour que toutes les requêtes auto-routées utilisent le même modèle.
- Si tous les canaux sont épuisés, retourne un 503 avec le journal des échecs pour diagnostiquer la panne.

#### Chaîne multi-fournisseur : DeepSeek → CodeX

Avec `/ultracode`, le harness peut enchaîner automatiquement plusieurs fournisseurs à travers les étapes du plan. Un schéma typique : laisser DeepSeek produire des ébauches rapides à faible coût, puis laisser CodeX reprendre et raffiner le résultat.

- Le **plan de harness dynamique** prend en charge les remplacements de `model` par étape — attribuez DeepSeek aux étapes de brainstorming/classification et CodeX/Gemini aux étapes d'implémentation/vérification.
- **Compatibilité cc-switch** : FreeUltraCode lit la configuration CLI `cc-switch`, tout fournisseur déjà configuré pour le routage Claude Code est immédiatement disponible pour les étapes ultracode.
- La stratégie **éventail-synthèse** parallélise les workers DeepSeek sur des sous-tâches indépendantes, puis une porte de consensus (CodeX) synthétise et vérifie les résultats.

#### Sélection de canal sensible à la vitesse

Le canal Auto du proxy gratuit priorise les canaux selon des signaux de disponibilité en temps réel :

- **Conscience des limites de débit** : les canaux retournant 429 sont refroidis pendant 30+ secondes avant réessai, évitant les tentatives inutiles sur des upstreams saturés.
- **Échec rapide sur erreurs** : les erreurs non-réessayables (échecs d'authentification 4xx, pannes upstream 5xx) sont suivies par canal avec refroidissement ; le routeur Auto les saute.
- **Budget de temps de connexion** : chaque tentative de canal est soumise au timeout upstream ; le routeur Auto parcourt les candidats sans bloquer sur un seul upstream lent.
- **Ordre naturel par réactivité** : les canaux qui réussissent restent sans refroidissement et sont essayés en premier ; les canaux en erreur sont repoussés en fin de liste.

Ces fonctionnalités assurent la résilience des exécutions de harness `/ultracode`, même lorsque certains fournisseurs gratuits sont lents, limités en débit ou temporairement indisponibles.

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

### Générer des assets de jeu

Les modes d'assets transforment la zone de chat en surface de génération d'assets tout en gardant le même historique. Utiles pour créer maquettes UI, icônes, textures, sprites, modèles 3D, audio et vidéo avant de revenir au code. L'exemple ci-dessous utilise le mode image ; les modes sprite, mesh, musique, voix et vidéo fonctionnent pareil avec leurs commandes `*-mode-start`.

1. Ouvrez **Settings** -> **Images** (ou la section d'asset correspondante), choisissez le fournisseur par défaut, puis renseignez l'API key, l'Account ID, la Base URL ou l'endpoint ComfyUI local requis.
2. Dans une session de chat, tapez `/image-mode-start`. Vous pouvez aussi lancer le mode et générer dans le même message :

```text
/image-mode-start une texture de mur de pierre stylisée pour un donjon fantasy, tileable, 1024x1024
```

3. Tant que le mode est actif, les messages ordinaires génèrent des assets au lieu de modifier le code. Le sélecteur **Channel** passe aux fournisseurs d'assets.
4. Décrivez l'asset voulu. FreeUltraCode fait d'abord améliorer le prompt par le modèle de programmation, puis l'envoie au fournisseur configuré.

<p align="center">
  <img src="images/生图/session-2026-06-07-2351.png" alt="Le mode asset génère des éléments dans la même session FreeUltraCode" width="720">
</p>

5. Envoyez `/image-mode-end` pour revenir au canal et au modèle de programmation. Pour générer un seul asset sans mode persistant, utilisez `/image`, `/img`, `/draw`, `/生图`, `/sprite`, `/music` ou `/video` suivi du prompt.

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
    lib/         Paramètres fournisseur, routage des canaux gratuits, génération d'assets (image/sprite/3D/musique/voix/vidéo/ComfyUI), équipe d'experts jeu, persistance
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
