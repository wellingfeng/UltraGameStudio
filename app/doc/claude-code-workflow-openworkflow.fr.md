# Claude Code a des Dynamic Workflows. Et les autres modèles ? Une alternative open source : OpenWorkflows

## Ces derniers temps, j'observe les nouveaux dynamic workflows de Claude Code. Par rapport à MCP, Skill et Hooks, peu de gens parlent de cette nouvelle fonction. Dans la suite, je les appellerai simplement workflows.

Pour les tâches complexes, beaucoup de personnes aimaient auparavant écrire d'abord un HTML de recherche, puis le transformer en HTML de plan technique, avant de le donner à l'IA pour le développement. Mais le résultat est souvent décevant. La raison principale est que le HTML est un texte destiné aux humains. Ce n'est pas un script et il manque d'informations structurées. La cohérence de l'ordre, le degré de parallélisme, la clarté des limites, la division des tâches et l'échange d'informations entre tâches restent flous. L'IA doit donc trop deviner.

Les workflows sont eux-mêmes des scripts, ce qui leur permet de résoudre ce problème directement.

Les workflows apportent aussi l'exploration sous plusieurs angles, la validation adversariale et le vote sur les plans. C'est pourquoi ils peuvent être plus précis. Ils gagnent par l'échelle : cinq agents travaillent en même temps sur le même problème, puis un autre agent synthétise les résultats. C'est effectivement plus précis, mais les tokens partent très vite.

Puisque c'est aussi général, pourquoi faudrait-il l'attacher à un seul modèle ou à une seule CLI ?

En suivant cette idée, j'ai développé OpenWorkflows, ou plus exactement, l'IA l'a développé. Il transforme les workflows de type Claude Code en canevas visuel et tente de faire en sorte qu'un même flux puisse cibler Claude Code, Codex, Gemini et d'autres runtimes locaux ou cloud.

Cette fois, je ne parle pas de concepts abstraits. Je parcours directement les captures d'écran. L'exemple est concret : faire en sorte qu'OpenWorkflows prenne en charge plusieurs styles d'interface, utilise Pencil par défaut et permette de basculer dans Paramètres / Apparence.

Pendant le développement, j'ai essayé de faire autant que possible dans OpenWorkflows pour qu'il puisse s'auto-amorcer.

Le processus ci-dessous utilise CodeX comme grand modèle par défaut pour le développement.

### 0. D'abord, l'interface finale

<p align="center">
  <img src="images/0-标题使用.png" alt="Interface principale d'OpenWorkflows" width="960">
</p>

Dans l'interface principale d'OpenWorkflows, le blueprint des workflows est au centre, les propriétés des nœuds sont à droite, et l'entrée ainsi que la sortie IA sont en bas.

L'interface principale se divise grosso modo en quatre parties : l'historique des workflows à gauche, le canevas visuel au centre, les propriétés des nœuds et les prompts courants à droite, puis l'entrée IA et les réponses en bas.

### 1. Télécharger OpenWorkflows

<p align="center">
  <img src="images/1-下载.png" alt="OpenWorkflows GitHub Releases" width="840">
</p>

Trouvez la dernière version dans Releases, à droite de la page du projet GitHub.

### 2. Configurer d'abord le grand modèle

Par défaut, OpenWorkflows utilise la CLI déjà configurée sur le système pour démarrer. Vous pouvez utiliser des outils comme CC-Switch pour la configurer.

### 3. Créer de nouveaux workflows, puis saisir la demande

<p align="center">
  <img src="images/3-新建workflow.png" alt="Créer de nouveaux workflows et saisir la demande" width="840">
</p>

Après avoir configuré le modèle, cliquez sur "Nouveau workflows" à gauche. Le canevas affiche une structure minimale : Start, un Agent et End.

Il n'est pas nécessaire de dessiner les nœuds à la main. Le vrai point de départ est la zone de saisie IA en bas à droite. Dans cet exemple, j'ai saisi :

```text
Je veux qu'OpenWorkflows prenne en charge plusieurs styles d'interface,
utilise Pencil comme design par défaut
et permette de changer dans Paramètres / Apparence.
```

Une fois le texte écrit, vous pouvez appuyer sur Ctrl+Enter ou cliquer sur le bouton d'envoi en bas à droite. OpenWorkflows transforme ce langage naturel en blueprint de workflows éditable.

### 4-1. Générer le blueprint de workflows

<p align="center">
  <img src="images/4-1生成workflow蓝图.png" alt="Blueprint de workflows généré" width="960">
</p>

Après l'envoi de la demande, OpenWorkflows réorganise d'abord l'étape actuelle en un workflow complet.

Le blueprint de la capture ressemble à ceci :

```text
Start
  -> Examiner en parallèle le support des apparences
      -> Étudier les points d'entrée d'apparence existants
      -> Concevoir le système multi-style
      -> Concevoir le style Pencil par défaut
  -> Résumer le plan d'implémentation
  -> Implémenter plusieurs styles d'interface
  -> Brancher le changement dans Paramètres / Apparence
  -> Valider et vérifier les régressions
  -> Documenter le résultat livré
  -> End
```

Dans le panneau des propriétés à droite, les propriétés du nœud sélectionné peuvent encore être modifiées. Mais le plus souvent, on utilise plutôt la zone de saisie en bas pour demander à l'IA de modifier les nœuds du blueprint et continuer l'itération.

### 4-2. Voir le script généré

<p align="center">
  <img src="images/4-2蓝图脚本.png" alt="Script de workflows généré" width="960">
</p>

En haut se trouve une entrée "Script". En l'ouvrant, vous voyez le script généré à partir du blueprint actuel.

Dans la capture, on voit des structures comme parallel(...) et agent(...). Les nœuds parallèles deviennent des branches exécutées en concurrence, et les nœuds ordinaires deviennent des appels agent individuels.

Cela montre aussi qu'OpenWorkflows ne se contente pas de dessiner des boîtes. Derrière le canevas se trouve une structure de workflows unifiée, ce qui permet ensuite de se connecter à différents runtimes.

### 5. Continuer avec les prompts courants à droite

<p align="center">
  <img src="images/5-使用常用提示词.png" alt="Utiliser les prompts courants pour continuer à modifier les workflows" width="960">
</p>

Après la génération du blueprint, il n'est pas nécessaire de l'exécuter tout de suite. Le panneau "Prompts courants" à droite est plus adapté pour affiner le processus, même si vous pouvez aussi écrire vous-même.

Les prompts sont regroupés par scénario : clarification interactive, clarté, complétude, coût, structure, fiabilité, performance et parallélisme, validation et tests.

Dans la capture, le prompt choisi est "Clarifier les exigences". Il remplit la zone de saisie IA avec une demande de confirmation interactive des points ambigus avant toute modification du blueprint.

Cette conception est très utile. Beaucoup de workflows échouent non parce que le modèle ne sait pas faire, mais parce que l'objectif, les limites, les chemins d'échec et la stratégie de coût n'étaient pas assez clairs au départ.

Il existe aussi des prompts courants comme grill-me, compléter les conditions limites, optimiser le parallélisme et principe unique. Vous pouvez en ajouter ou les modifier vous-même.

### 6. Confirmer les limites avec des choix interactifs

<p align="center">
  <img src="images/6-交互选择.png" alt="Choix interactifs pour confirmer les limites" width="640">
</p>

Après avoir cliqué sur "Clarifier les exigences", l'IA ne modifie pas directement le graphe. Elle demande d'abord : "Quel périmètre doit couvrir la fonction de changement de style d'interface ?"

La capture propose deux choix : livrer seulement le style Pencil par défaut avec une structure extensible, ou livrer Pencil plus plusieurs styles commutables.

Après votre choix, l'IA écrit cette décision dans le blueprint de workflows et sort l'IRGraph mis à jour. Cette étape réduit le risque que l'IA parte seule dans la mauvaise direction.

### 7. Cliquer sur Exécuter

<p align="center">
  <img src="images/7-运行.png" alt="Exécuter les workflows" width="960">
</p>

Quand la structure du blueprint, la configuration du modèle et les limites clés sont confirmées, cliquez sur "Exécuter" en haut.

Je recommande de ne pas lancer juste après la génération. Vérifiez d'abord si les branches parallèles sont raisonnables, si le nœud de synthèse vient après les branches parallèles, et si la validation couvre le résultat final.

Si un nœud a seulement une responsabilité peu claire, vous pouvez d'abord le modifier dans ses propriétés, puis relancer.

### 8. Observer l'état d'exécution

<p align="center">
  <img src="images/8-运行中.png" alt="Observer l'état d'exécution des workflows" width="960">
</p>

Après le lancement, le bouton supérieur devient "En cours... Stop". L'entrée IA en bas est verrouillée pour éviter que le blueprint soit modifié pendant l'exécution.

Le canevas affiche l'état des nœuds. Dans la capture, Start est terminé, le nœud parallèle suivant est en cours, et un compteur d'exécution apparaît en haut à droite. Si une étape échoue au milieu, on peut continuer depuis la tâche précédente.

### 9. Changer le style d'interface

<p align="center">
  <img src="images/9-切换风格.png" alt="Changer le style d'interface" width="840">
</p>

Une fois le développement terminé par OpenWorkflows, redémarrez le programme et changez de style dans Paramètres / Apparence.

La capture montre des cartes de style comme Pencil, Deep Night, Aurora, Daylight et Ember. Une fois sélectionné, le style modifie l'arrière-plan global, les panneaux, les bordures et les couleurs d'état d'exécution.

### Ce que je trouve vraiment utile

La vraie valeur d'OpenWorkflows n'est pas d'enrober un prompt dans une UI.

Il relie "demande -> blueprint -> script -> exécution -> historique". Vous pouvez d'abord générer un processus en langage naturel, vérifier la structure sur le canevas, compléter les limites avec des prompts courants si nécessaire, puis seulement exécuter.

Un même ensemble de workflows n'a pas non plus besoin d'être lié naturellement à un seul modèle. Les nœuds simples peuvent utiliser des modèles moins chers, les nœuds clés des modèles plus puissants, et la cible d'exécution peut continuer à s'étendre à Claude Code, Codex, Gemini ou d'autres runtimes.

Pour des tâches complexes de programmation IA, cette décomposition est plus facile à maintenir qu'un très long prompt. Si un nœud échoue, on corrige ce nœud. Si une branche est inutile, on la supprime. Si l'on veut réutiliser, on repart de l'historique.

### C'est encore tôt, mais la direction mérite d'être suivie

Le concept global de workflows est encore jeune, et OpenWorkflows lui-même vient de commencer. Les adaptateurs de runtime, les capacités des nœuds et l'écosystème de scripts continueront d'évoluer.

Mais la direction générale est claire : la programmation IA ne restera pas longtemps à "ouvrir une fenêtre de chat puis pousser chaque étape à la main".

Les tâches complexes finiront par devenir des workflows, parce qu'elles peuvent être vues, éditées, migrées et réutilisées.

Groupe QQ : 149523963

Projet :

https://github.com/wellingfeng/OpenWorkflows

Référence :

https://code.claude.com/docs/en/workflows
