# react-audit-pro

CLI d'audit pour projets React qui analyse l'architecture, la performance, les tests et le TypeScript. Génère un score global avec recommandations actionnables.

## Fonctionnalités

- Analyse AST React via Babel
- Détection de composants trop volumineux (>300 lignes)
- Vérification des `useEffect` et dépendances manquantes
- Détection des listes sans `key`
- Analyse TypeScript (usage excessif de `any`)
- Estimation heuristique du bundle
- Analyse des tests et maintenabilité
- Rapports texte, JSON et HTML
- Suggestions IA optionnelles (OpenAI / Azure OpenAI)
- Score global sur 100

## Installation

```bash
npm install react-audit-pro
```

## Utilisation

### Analyse du projet courant

```bash
npx react-audit
```

### Analyse d'un dossier précis

```bash
npx react-audit ./mon-projet
```

### Générer un rapport HTML

```bash
npx react-audit . --format html
```

Le rapport sera sauvegardé dans `report.html`.

### Générer un rapport JSON

```bash
npx react-audit . --format json
```

### Forcer un fichier de sortie

```bash
npx react-audit . --format html --output mon-rapport.html
```

### Activer les suggestions IA

```bash
npx react-audit . --ai
```

Nécessite une clé API OpenAI ou Azure OpenAI.

## Configuration IA

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4o-mini"  # optionnel

npx react-audit . --ai
```

Variables disponibles :
- `OPENAI_API_KEY` (requis)
- `OPENAI_MODEL` (optionnel, défaut : `gpt-4o-mini`)
- `OPENAI_BASE_URL` (optionnel)

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_ENDPOINT="https://..."
export AZURE_OPENAI_DEPLOYMENT="..."

npx react-audit . --ai --ai-provider azure
```

Variables disponibles :
- `AZURE_OPENAI_API_KEY` (requis)
- `AZURE_OPENAI_ENDPOINT` (requis)
- `AZURE_OPENAI_DEPLOYMENT` (requis)
- `AZURE_OPENAI_API_VERSION` (optionnel)

## Options CLI

```
Usage: react-audit [options] [target]

Analyse un projet React et génère un score de qualité avec recommandations.

Arguments:
  target                        Répertoire du projet à analyser (défaut: ".")

Options:
  -f, --format <format>         Format de sortie : text | json | html (défaut: "text")
  -o, --output <file>           Fichier de sortie pour le rapport
  --ai                          Activer les suggestions IA
  --ai-provider <provider>      openai | azure | auto (défaut: "auto")
  --ai-model <model>            Modèle IA à utiliser
  --ai-base-url <url>           URL de base pour OpenAI (optionnel)
  --ai-api-key <key>            Clé API (optionnel, utilise env sinon)
  --ai-deployment <deployment>  Déploiement Azure OpenAI
  --ai-api-version <version>    Version API Azure OpenAI
  -h, --help                    Afficher l'aide
```

## Exemple de sortie

```text
Analyse du projet...

[OK] React 19 détecté
[OK] TypeScript activé

[WARN] Problèmes détectés :

1. 3 composant(s) trop volumineux détecté(s)
   Fichier : src/components/Dashboard.tsx:1
   Certains composants dépassent le seuil recommandé de 300 lignes.
   Suggestions :
   - Extraire les hooks métier.
   - Séparer l'UI et la logique.

2. 1 useEffect potentiellement problématique(s)
   useEffect probablement utilisé pour synchroniser une prop vers le state
   Suggestions :
   - Utiliser directement la prop lorsque c'est possible.
   - Extraire une valeur dérivée au lieu de la stocker dans un state.

Détail du score :
- Architecture : 20/20
- Performance : 20/20
- Tests : 20/20
- TypeScript : 18/20
- Maintenabilité : 18/20

Score global : 96/100

Recommandations prioritaires :
1. Réduire les any avec des interfaces explicites ou des types génériques.
```

## Développement

```bash
npm install
npm run build
npm run test
npm run typecheck
```

### Checklist de release

```bash
npm run release
npm version patch
npm publish --access public
```

Voir `RELEASE.md` pour la procédure complète.

## Cas d'usage

- **CI/CD** : Intégrez dans vos pipelines pour surveiller la qualité React
- **Code review** : Utilisez comme standard de qualité pour les PR
- **Audit codebase** : Analysez rapidement l'état d'un projet React
- **Refactoring** : Identifiez les composants à découper et les hooks à optimiser
- **Formation** : Sensibilisez les équipes aux bonnes pratiques React

## Licence

MIT

---

Questions ? Besoin d'une fonctionnalité ? Ouvrez une issue sur GitHub.

