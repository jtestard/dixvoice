# Dixvoice — branche `new-design`

Nouveau design du front (`webapp/frontend/src`) : table vue de dessus avec les joueurs autour, avatars colorés,
animations (deal, envol de la carte, tampon VOTED, bon clip qui s'illumine en vert, podium, confettis), waveform
live sur le vrai audio, sons d'interface synthétisés, interface épurée qui tient sur un écran.

Les fichiers de ce dossier remplacent ceux de `webapp/frontend/src/` **à l'identique de l'arborescence** :

| Fichier | Statut |
|---|---|
| `src/index.css` | remplacé (tokens + toutes les animations) |
| `src/audio.ts` | remplacé (AnalyserNode + repli CORS, `sampleWave`, `progress`) |
| `src/sfx.ts` | nouveau (synthé WebAudio, `sfx()`, `setSfxEnabled()`) |
| `src/useSfxCues.ts` | nouveau (sons pilotés par les snapshots serveur) |
| `src/tutorial.ts` | remplacé (textes, plus de cue sur Home / fin) |
| `src/useQuickStart.ts` | remplacé (n'envoie plus `start_game` : le joueur presse Start) |
| `src/App.tsx` | remplacé (cue passée à Lobby / Game, sons branchés) |
| `src/components/Table.tsx` | nouveau (la table + les sièges + les mini-cartes) |
| `src/components/ClipCard.tsx` | remplacé (bobines, waveform live, progression, `flying`, `voted`, `correct`) |
| `src/components/Common.tsx` | remplacé (`Avatar`, `playerColor`, `ScoreTrack gained`, `Podium`, `Confetti`) |
| `src/components/Game.tsx` | remplacé (deux colonnes, reveal en vert, résultat + points fusionnés) |
| `src/components/Lobby.tsx` | remplacé (table 8 sièges, Start armé) |
| `src/components/Home.tsx` | remplacé (compacte, table de démo + 4 étapes) |
| `src/components/TutorialCard.tsx` | remplacé (`TutorialCue`, carte compacte) |

Inchangés : `api.ts`, `useGame.ts`, `usePlayingKey.ts`, `roundResult.ts`, `types.ts`, `main.tsx`.

## Installer sur la branche

```sh
cd /Users/oscar/Documents/ETUDES/STARTUPS/Dixvid
git checkout -b new-design
# copier le contenu de ce dossier (new-design/webapp/...) à la racine du repo :
cp -R <chemin-du-zip>/new-design/webapp/frontend/src/. webapp/frontend/src/
cd webapp/frontend
npm install
npm run lint
npm run dev          # + `npm run mock` dans un autre terminal
git add -A
git commit -m "New design: table, avatars, animations, sound effects"
git push -u origin new-design
```

## À vérifier après la copie

- **Tests** (`npm test`) : certains tests de `src/test/` ciblent l'ancien markup (badge « bot », tags « waiting / done »,
  libellés « Round win », « Adding companions… », bloc « On the table »). Ils sont à mettre à jour avec le nouveau
  design ; la logique de jeu et le protocole n'ont pas changé.
- **CORS du CDN** : la waveform live lit l'audio via `crossOrigin="anonymous"`. Le CDN autorise déjà `GET` depuis
  toute origine (README › Clip storage). En cas de refus, `audio.ts` rebascule seul en mode sans analyseur.
- **Backend** : rien à changer. « Play again » n'existe pas (la session est terminée après une partie), le bouton
  n'est donc pas dans `EndGame`.
- **Réduction des animations** : tout est coupé par `prefers-reduced-motion`, la waveform live ne bouge plus mais la
  barre de progression reste.

Le prototype de référence (jouable, mêmes animations et sons) est `Dixvoice Game Feel.dc.html` ; les décisions
détaillées sont dans `HANDOFF.md`.
