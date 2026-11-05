# VERIF-IMMO

Web app de contrôle des immobilisations à partir :
- des deux fichiers carto « G Canalisation » (pose et dépose, .xlsm / .xlsx) ;
- de la capture d'écran SAP de la structure du projet (onglet « Donn. base »).

Tout est traité **dans le navigateur** : aucun fichier ni capture n'est envoyé sur Internet. La lecture des captures (OCR) se fait localement. Les macros des fichiers .xlsm ne sont jamais exécutées.

## Mise en ligne (GitHub Pages)
1. Créer un dépôt GitHub (ex. `verif-immo`).
2. Déposer **tout le contenu de ce dossier** à la racine du dépôt (index.html, app.js, engine.js, style.css, dossier `vendor/`).
3. Settings → Pages → Source : « Deploy from a branch », branche `main`, dossier `/ (root)`.
4. L'appli est disponible à l'adresse `https://<compte>.github.io/verif-immo/`.

## Fichiers
| Fichier | Rôle |
|---|---|
| `index.html` | page |
| `style.css` | présentation (couleurs dans `:root`) |
| `app.js` | interface, sauvegarde, OCR, exports — contient le numéro de version (`VERSION`) |
| `engine.js` | règles métier et calculs |
| `vendor/` | bibliothèques embarquées : SheetJS (Excel), jsPDF + AutoTable (PDF), Tesseract.js + données « fra » (OCR) |

## Version
Le numéro affiché vient de `const VERSION = '1.0'` dans `app.js` : l'incrémenter à chaque modification.

## Règles appliquées
Voir le menu **Aide** de l'appli.

## Licences des bibliothèques
SheetJS CE (Apache-2.0), jsPDF (MIT), jspdf-autotable (MIT), Tesseract.js et tesseract.js-core (Apache-2.0), données Tesseract (Apache-2.0). Fichiers de licence dans `vendor/`.
