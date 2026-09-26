# Dixvoice : plan final du microservice audio

*26 septembre 2026. Le contrat de l'équipe est le [README](../README.md). Chaque chiffre porte sa source. Ce qui n'est pas mesuré ni sourcé est marqué **(estimation)**.*

*J0 à J7 désignent des **jalons** (étapes du build), pas des jours. Ce document intègre les corrections de la relecture finale, puis les exigences du coéquipier du 26/09 : CORS sur les `GET`, sons créés impossibles à distinguer des sons listés, ids en UUID.*

`SCRATCH` désigne le dossier de travail local d'Oscar, **pas encore dans le repo**. Les outils déjà écrits sont dans `SCRATCH/wf/` :
- `gradium-bench/` : sonde de latence, faux serveur Gradium, script Voice Design ;
- `audio/` : mesures d'encodage et de navigateurs ;
- `library/` : prototype de fabrication de la bibliothèque ;
- `hosting/proto/audio-service/` : brouillons du Dockerfile, de `railway.json` et de `fly.toml`.

> **⚠ À réconcilier avec le README du 26/09 (commit 24a24c6), plus récent que ce plan :**
> - **Salons** : le README réintroduit les salons à code (4 à 8 joueurs) et une main de **6** emplacements (5 distribués + 1 son créé).
> - **Hébergement** : le backend Go tourne sur le cluster Kubernetes gcast, pas sur Railway. Il faut décider où tourne le service audio (même cluster, recommandé, pour garder un réseau privé entre Go et le service ; sinon `POST /audio` passe par Internet, protégé par le jeton).
> - **Lecture** : le front joue les clips avec un élément HTML `<audio>` (pas la Web Audio API du §3.7) ; la prise en charge des requêtes `Range` (§3.2) reste indispensable pour Safari.
> - **`tonality`** est du texte libre dans le README ; ce plan en fait un identifiant de préréglage (`GET /audio/tonalities`), sinon `400 unknown_tonality`.
> - **Sons déjà utilisés** : chaque salon garde la liste des ids distribués ou créés et ne les redistribue pas ; un son créé dans un salon peut donc être distribué dans un autre (question 10 du §10).
> - **Formats** : compatibles. Le web app ne lit que `id` dans `/audio/list` et attend `201 {"id": …}` sur `POST /audio`.

---

## 1. En une phrase

Un petit programme Python, dans un conteneur Docker, qui fait trois choses :
- il **liste** une bibliothèque de sons préparés à l'avance ;
- il **sert** chaque son en MP3 ;
- il **fabrique en direct** une réplique de voix d'au plus 2 s avec Gradium, en moins d'une demi-seconde visée.

Quelques mots utilisés partout dans ce plan :
- **Conteneur** : une boîte qui contient le programme et tout ce dont il a besoin, et qui tourne pareil sur ton Mac et sur le serveur.
- **Endpoint** : une adresse du service, par exemple `GET /audio/list`.
- **Latence** : le temps d'attente entre le clic et le son.
- **Chemin critique** : les étapes que le joueur attend vraiment.

```
Navigateur (jeu itch.io, iframe servie depuis https://html-classic.itch.zone)
   │ WebSocket du jeu (existe déjà)             │ HTTPS public, lecture seule :
   │ « créer un son », état, votes              │ GET /audio/{id}, GET /audio/tonalities
   ▼                                            ▼
Backend Go ── HTTP réseau privé + jeton ──► Service audio (Python, 1 conteneur) ── HTTPS gardé ouvert ──► Gradium TTS
   GET  /audio/list   (pioche)                 bibliothèque MP3 incluse dans l'image
   POST /audio        (créer un son)           clips générés écrits sur le disque local
```

Qui appelle quoi :
- **Le backend Go** est le seul à appeler `POST /audio`. Il connaît les joueurs, donc c'est lui qui limite chacun, et la clé Gradium ne sort jamais du serveur. Le README le dit : le backend appelle le service « to list sounds, fetch them, and create new ones ».
- **Le navigateur** télécharge les MP3 directement (`GET /audio/{id}`), sans passer par Go. Il y a un intermédiaire de moins et le cache du navigateur garde les fichiers.
  - **⚠ Écart au README** : le README fait récupérer les sons par Go (« fetch them »). Alternative conforme : Go relaie les MP3, le service reste privé (pas de domaine public, pas de CORS, `POST` injoignable depuis Internet), au prix d'un intermédiaire de plus. **À trancher avec l'équipe en J0.**
- **Gradium** n'est appelé que par le service audio.

---

## 2. Choix techniques

| Choix | Pourquoi |
|---|---|
| **Python 3.12** | C'est ton langage le plus fort. Le service passe son temps à attendre le réseau : notre calcul pour un clip prend environ 3 ms (mesuré, `SCRATCH/wf/audio/out_bench.txt`). Ton `python3` système (3.9.6) ne suffit pas : `soundfile` 0.14, `lameenc` 1.8.4 et le SDK `gradium` exigent Python 3.10 ou plus (métadonnées des paquets, `SCRATCH/wf/audio/wheels`, https://pypi.org/pypi/gradium/json). |
| **uv** | Gestionnaire Python qui installe aussi Python lui-même, sans Homebrew. `uv python install 3.12` a pris environ 3 s sur ton Mac (mesuré, `SCRATCH/wf/hosting`). |
| **FastAPI + uvicorn** (1 processus, 1 worker) | FastAPI est un framework web asynchrone : un seul processus attend plusieurs réponses réseau sans se bloquer. Il génère `/docs`, la documentation d'API exigée par le jury, sans travail en plus. On garde un seul processus parce que la liste des clips est en mémoire (https://fastapi.tiangolo.com/deployment/docker/). |
| **httpx** | Client HTTP qui garde les connexions ouvertes vers Gradium (keep-alive). On évite ainsi TCP+TLS à chaque clip : environ 45 ms de TCP+TLS mesurés depuis le lieu du hackathon vers `eu.api.gradium.ai` ; une requête complète avec DNS froid a pris 178 ms (`SCRATCH/wf/hosting`). |
| **numpy** | Retrait des silences, coupe, fondu, volume : environ 0,1 ms en tout (mesuré, `out_bench.txt`). |
| **soundfile** 0.14 (libsndfile 1.2.2 + LAME 3.100 inclus) | Encode le MP3 sans ffmpeg (paquet de 1,3 Mo). C'est **le seul encodeur testé qui donne un clip de 2,000 s exactement, sans silence ajouté au début, dans Chromium 152 et Safari 27** (mesuré, `SCRATCH/wf/audio/web/result_*.json`). Il met 2,5 à 3,1 ms pour 2 s à 24 kHz (mesuré). |
| **lameenc** (secours) | Environ 2 ms. En revanche, il n'écrit pas d'en-tête « gapless » (l'en-tête qui dit au lecteur où le son commence vraiment) : le clip décode à 2,064 s et démarre 24 à 46 ms en retard (mesuré). |
| **Pas le SDK Gradium dans le service** | Ses fonctions `tts()` et `tts_stream()` ouvrent une nouvelle connexion à chaque appel (`SCRATCH/wf/gradium-extra/sdk/gradium/client.py`). On écrit un client REST d'environ 80 lignes avec httpx **(estimation)**. Le SDK reste utile pour les scripts ponctuels. |
| **Exclus de l'image** : scipy, pyloudnorm, ffmpeg, pydub, PyAV | scipy pèse 112 Mo et son import prend 0,4 s. ffmpeg lancé en sous-processus coûte 13 à 18 ms par appel. pydub dépend d'`audioop`, supprimé en Python 3.13. PyAV pèse 106 Mo, contient du code GPL, et Safari ignore son en-tête (tout est mesuré dans `SCRATCH/wf/audio`). pyloudnorm et ffmpeg (via `imageio-ffmpeg`) servent **hors ligne** pour fabriquer la bibliothèque. |

**Transport vers Gradium en v1 : REST sur connexion gardée ouverte, pas WebSocket.** C'est une seule requête HTTP, donc simple à déboguer. On ne construit un client WebSocket multiplexé (plusieurs requêtes en même temps sur une seule connexion) que si la mesure montre qu'il gagne plus de 30 ms en médiane (§9).

**⚠ Point à vérifier en J2, avant tout le reste** : en mode NDJSON, la doc dit de lire le corps « until it closes ». Si Gradium signale la fin du flux en **fermant la connexion**, elle n'est jamais réutilisée, et le pool gardé ouvert ne sert à rien (chaque clip repaie ~45 ms de TCP+TLS). La sonde journalise `Transfer-Encoding`/`Connection` et vérifie que la 2e requête réutilise la même connexion (trace httpcore). Si ce n'est pas le cas, on passe directement au client WebSocket multiplexé.

---

## 3. Le contrat

### Règles communes

- **Format d'erreur unique**, que Go décode dans une seule structure : `{"error": {"code": "<code>", "message": "<texte lisible>"}}`. On remplace le gestionnaire 422 par défaut de FastAPI pour garder ce format partout.
- **CORS (exigence du coéquipier : les domaines du front doivent pouvoir appeler tous les `GET`)**. Le CORS est la règle du navigateur qui autorise ou non une page d'un autre domaine à lire une réponse. Réglage, avec le `CORSMiddleware` de FastAPI :
  - **tous les `GET` et `HEAD`** : `/audio/list`, `/audio/{id}`, `/audio/tonalities`, `/healthz` ;
  - origines lues dans la variable `CORS_ORIGINS`. Par défaut `*` : c'est permis puisqu'il n'y a pas de cookies (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS), et c'est le plus sûr parce que le domaine des iframes itch.io a déjà changé (https://itch.io/t/3661515/cors-errors). Si l'équipe préfère une liste : `https://html-classic.itch.zone`, `https://html.itch.zone` et le serveur de développement Vite `http://localhost:5173`, plus `allow_origin_regex = https://.*\.itch\.zone` pour couvrir les sous-domaines ;
  - `allow_methods = GET, HEAD, OPTIONS`, **sans `POST`** : un navigateur ne peut pas appeler `POST /audio` (la requête JSON déclenche une vérification préalable, refusée), en plus du jeton ;
  - `allow_headers = Range, If-None-Match` ; `expose_headers = Content-Range, Accept-Ranges, ETag, Content-Length`, pour que le front puisse lire ces en-têtes ; `max_age = 86400` (la vérification préalable est gardée un jour en cache) ; `allow_credentials = False` ;
  - les réponses d'erreur (404…) portent aussi les en-têtes CORS, sinon le front verrait une « erreur CORS » au lieu d'une 404.
- Un `GET` sans en-tête personnalisé ne déclenche pas de *preflight*, la requête `OPTIONS` de vérification qui ajoute un aller-retour (même source MDN).
- **Ids : UUID version 4 pour tous les sons**, bibliothèque et sons créés, en minuscules, forme canonique de 36 caractères (`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`). Un UUID v4 est tiré au hasard (122 bits aléatoires, `uuid.uuid4()`), donc impossible à deviner et sans lien avec le texte, l'auteur ou la date.
  - **Jamais de v1 ni de v7** : ils contiennent l'heure de création, qui trahirait un son créé pendant la partie.
  - **Jamais de v3 ni de v5** (UUID calculés à partir d'un contenu) pour la bibliothèque : leur chiffre de version (3 ou 5) les distinguerait des sons créés (4).
  - Un id mal formé reçoit une 404 sans lecture du disque.
- **Indiscernabilité (exigence du coéquipier)** : rien ne doit permettre de distinguer un son créé d'un son de la bibliothèque. Ce qui est garanti :
  - même forme d'id (UUID v4) ;
  - **les sons créés apparaissent dans `/audio/list`** dès leur création, avec exactement les mêmes champs ;
  - liste **triée par id** : l'ordre est aléatoire et ne révèle pas l'ordre d'ajout ;
  - **mêmes réglages d'encodage** (soundfile, MP3 24 kHz mono VBR, mêmes versions figées dans `uv.lock`), aucune métadonnée ID3 ;
  - **mêmes en-têtes HTTP** : tous les fichiers reçoivent la même date de modification (`os.utime` à une date fixe, au démarrage pour la bibliothèque et à l'écriture pour les sons créés). Sinon `Last-Modified`, et l'`ETag` que Starlette calcule à partir de cette date, trahiraient un fichier récent ;
  - les répliques de voix de la bibliothèque viennent des **mêmes voix Gradium** : `kind: voice` ne désigne pas forcément un son créé ;
  - Go ne transmet jamais au navigateur un champ du genre `generated`.

### 3.1 `GET /audio/list` (README)

Appelé par Go au démarrage et à chaque partie. Réponse 200 `application/json` : un **tableau nu**, au plus près de « list all possible sound objects in JSON » :

```json
[
  {"id": "3f6c2a1e-8b4d-4c7a-9e21-5d0b7a6f1c93", "kind": "sfx",      "duration_ms": 1840},
  {"id": "5d2b8f60-e1a7-4a3c-8c94-71f0b2d6e4a8", "kind": "voice",    "duration_ms": 1530},
  {"id": "a91e07d4-2c5b-4f18-b6a3-0e7d94c2f851", "kind": "ambience", "duration_ms": 2000}
]
```

- `kind` vaut `sfx` (bruitage), `ambience`, `voice`, `music` ou `abstract`.
- L'URL d'un clip est `AUDIO_PUBLIC_URL + "/audio/" + id`.
- **Pas de titre ni de tags** : ils donneraient la réponse sans écouter. Ils restent dans `library/manifest.json`.
- En-têtes : `Cache-Control: no-cache` (le client revérifie à chaque fois, puisque la liste grandit avec les sons créés) et `ETag: "<hash de l'ensemble des ids>"` : un `If-None-Match` identique reçoit une 304, sans corps.
- Contenu : **la bibliothèque (clips `enabled && deal`) et tous les sons créés encore présents sur le disque**, mêmes champs, triés par id (§6.5).

### 3.2 `GET /audio/{id}` et `HEAD /audio/{id}` (README ; `HEAD` ajouté)

- **200** `audio/mpeg` avec :
  - `Content-Length` ;
  - `ETag` ;
  - `Accept-Ranges: bytes` ;
  - `Cache-Control: public, max-age=31536000, immutable`. Un id ne change jamais de contenu, donc le navigateur ne redemande jamais le fichier, même au rechargement (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control).
- **206** quand le navigateur demande un morceau du fichier (en-tête `Range`). Starlette `FileResponse` le fait tout seul depuis la version 0.39 (https://starlette.dev/release-notes/). Apple l'exige pour les médias sur iOS. Safari macOS envoie d'abord une sonde `Range: bytes=0-1` (mesuré, `SCRATCH/wf/audio/web/range_log.jsonl`).
- **404** `not_found`, avec `Cache-Control: no-store`. Un id mal formé reçoit aussi une 404, sans lecture du disque.
- `HEAD` sert aux lecteurs qui vérifient la taille avant de télécharger. Il est fourni avec la même route.

### 3.3 `POST /audio` (README)

Appelé **par Go seulement**, par le réseau privé.

Requête :

```
POST /audio?inline=true
Content-Type: application/json
X-Service-Token: <SERVICE_TOKEN>
X-Player-Id: p_42            (facultatif, pour les journaux)

{"text": "Où est passé mon sandwich ?", "tonality": "noemie-fr"}
```

Réponse **201**, avec l'en-tête `Location: /audio/c47e19b2-6a0d-4e5f-a813-9b2c7d04e6f1` :

```json
{
  "id": "c47e19b2-6a0d-4e5f-a813-9b2c7d04e6f1",
  "kind": "voice",
  "duration_ms": 1760,
  "tonality": "noemie-fr",
  "spoken_text": "Où est passé mon sandwich ?",
  "truncated": false,
  "cached": false,
  "model": "gradium-tts-beta",
  "timings_ms": {"queue": 0, "provider_first_audio": 61, "provider_done": 298, "postprocess": 4, "total": 309},
  "mp3_base64": "SUQzBAAAAAAA…"
}
```

**Ajouts au README, chacun justifié :**
- **`?inline=true`** (facultatif) ajoute `mp3_base64`. Go passe ce champ au **seul créateur** dans son message WebSocket, et le créateur entend son clip sans faire de `GET`. On économise un aller-retour : environ 50 ms en bonne 4G **(estimation)**, 165 ms en « Fast 4G » DevTools, 560 ms en « Slow 4G » (modèle de livraison, `SCRATCH/wf/audio`). Un MP3 d'environ 11 Ko pèse environ 15 Ko en base64, et le décoder en JS prend moins de 0,2 ms (mesuré). Sans `inline`, la réponse ne contient pas ce champ.
- `truncated` et `spoken_text` disent ce qu'on entend vraiment quand la fin a été coupée (§4).
- `cached: true` signale un doublon : même texte et même tonalité qu'un clip déjà généré. On réutilise le son sous un **nouvel** UUID v4 : zéro crédit et aucune collision d'id dans le vote. (Ce champ et `timings_ms` ne vont qu'à Go, jamais au navigateur.)
- `timings_ms` dans le corps suffit : Go le journalise (et peut le renvoyer au créateur pour le débogage). Pas d'en-tête `Server-Timing` : `POST /audio` n'est jamais appelé par le navigateur, DevTools ne le verrait pas.

Codes d'erreur :

| HTTP | `code` | Cas |
|---|---|---|
| 400 | `invalid_request` | JSON illisible, champ manquant ou de mauvais type |
| 400 | `text_empty` | aucune lettre après nettoyage |
| 400 | `text_too_long` | plus de `MAX_CHARS` (40) après nettoyage |
| 400 | `unknown_tonality` | tonalité absente de `tonalities.json` |
| 400 | `text_has_digits` | chiffres refusés : « écris les nombres en lettres » (Gradium développe « 2500000 » en « 2 million 500 thousand », ce qui ferait exploser les 2 s) |
| 400 | `text_rejected` | mot de la liste de blocage |
| 401 | `unauthorized` | `X-Service-Token` absent ou faux |
| 429 | `busy` | pas de place libérée en 2 s, ou budget du jour épuisé (+ `Retry-After`) |
| 502 | `provider_error` | Gradium a renvoyé une erreur, même après le repli de modèle |
| 503 | `provider_unavailable` | pas de clé, clé révoquée, crédits sous le plancher, ou `PROVIDER=off` |
| 504 | `provider_timeout` | plus de `PROVIDER_TIMEOUT_S` (5 s) |

Côté Go : délai maximal de 8 s, qui couvre l'attente du sémaphore (2 s) + `PROVIDER_TIMEOUT_S` (5 s) + le post-traitement ; aucun réglage ne doit dépasser l'autre. Go accepte **201** (pas seulement 200), décode `{error:{code,message}}` et affiche un message par code (`text_too_long`, `text_has_digits`, `unknown_tonality`, `text_rejected`, `busy`, `provider_unavailable`). 429, 502, 503 et 504 peuvent être retentés ; les 400 s'affichent au joueur.

### 3.4 `GET /audio/tonalities` (ajout)

Le formulaire « Create a sound » doit afficher les tonalités. Sans cet endpoint, la liste serait recopiée à la main dans le front et finirait par diverger.

```json
{
  "generation_available": true,
  "max_chars": 40,
  "recommended_chars": 25,
  "tonalities": [
    {"id": "noemie-fr", "label": "Espiègle", "language": "fr", "sample_id": "0b8d3e57-94c1-4a26-bd70-e2f5a918c3d4"},
    {"id": "sterling-en", "label": "Theatrical", "language": "en", "sample_id": "e2a6c9f1-37b8-4d05-9a4e-6c1f08b7d352"}
  ]
}
```

- `generation_available: false` sert au front à griser « Créer un son ».
- `sample_id` est une réplique enregistrée à l'avance par voix, résolue par le front avec la même règle que la pioche (`AUDIO_PUBLIC_URL + "/audio/" + id`) : le joueur l'écoute gratuitement avant de choisir. (Un chemin relatif serait résolu par rapport à l'iframe itch.io, donc faux.)
- Pas de `voice_id` ni de réglages : le navigateur n'en a pas besoin.
- `Cache-Control: public, max-age=30`, court parce que `generation_available` peut changer.
- Le front l'appelle **au chargement**, ce qui ouvre aussi la connexion HTTPS vers le service avant le premier son.

### 3.5 `GET /healthz` (ajout)

L'hébergeur l'utilise pour savoir si le service a démarré, et c'est la première chose à regarder en cas de problème.
- **200** dès que la bibliothèque est chargée, **503** sinon.
- **N'appelle jamais Gradium** : une panne de Gradium ne doit pas faire redémarrer le conteneur.
- **Réponse publique minimale** : `{status, clips, generation_available}`. Le détail ci-dessous (crédits, IP de Gradium, modèle, temps TLS) n'est renvoyé qu'avec `X-Service-Token`.

```json
{"status": "ok", "version": "<commit>", "clips": 312, "generated": 57,
 "provider": "gradium", "provider_state": "ok", "model_in_use": "gradium-tts-beta",
 "credits_remaining": 987654, "last_total_ms": 309, "gradium_ip": "163.172.130.79", "tls_ms": 47}
```

`provider_state` vaut `ok`, `degraded`, `down` ou `out_of_credits`.

### 3.6 `GET /docs` et `/openapi.json` (ajout, automatique)

FastAPI les génère. On exporte aussi `docs/openapi.json` dans le dépôt pour le jury.

### 3.7 Consignes à coller dans le chat de l'équipe

**Pour Go :**
- `GET /audio/list` au démarrage, avec `If-None-Match` ;
- garder un ensemble « récemment distribués » pour ne pas redonner les mêmes cartes d'une partie à l'autre ;
- `POST /audio?inline=true` avec `X-Service-Token`, délai de 8 s, **un seul client HTTP réutilisé** ;
- limiter chaque joueur (1 génération toutes les 5 s, 1 par manche proposé) ;
- `mp3_base64` au créateur seulement ; au vote, les ids **mélangés, envoyés d'un coup, jamais dans l'ordre des soumissions**, qui trahirait les auteurs ;
- remplacer par un clip de la bibliothèque toute carte dont l'id renvoie 404 ;
- ne jamais envoyer au navigateur d'information qui distingue un son créé (pas de champ `generated`, pas de `cached` ni de `timings_ms`) ;
- les sons créés sont dans `/audio/list` : si l'équipe ne veut pas qu'ils partent dans la pioche des autres, **Go les écarte lui-même** avec les ids reçus en réponse à ses `POST` (voir §10).

**Pour le front :**
- utiliser la Web Audio API ;
- au premier clic, mettre `navigator.audioSession.type = 'playback'` si la propriété existe (sinon l'interrupteur silencieux d'iOS coupe le son), puis créer ou reprendre **un seul** `AudioContext` ;
- décoder un son minuscule au démarrage : le premier décodage d'une session Safari coûte 85 à 112 ms (mesuré) ;
- décoder chaque clip une fois et garder l'`AudioBuffer` par id ;
- précharger la main dès la distribution ; au vote, lancer tous les `GET` en parallèle ;
- appeler `GET /audio/tonalities` au chargement ;
- adresse du service dans une variable Vite fixée au build pour itch.io (`VITE_AUDIO_URL`), et `<link rel="preconnect" href="…" crossorigin>` vers ce domaine ;
- compteur de caractères ; bouton grisé si `generation_available` vaut `false` ; afficher `spoken_text` si `truncated` vaut `true`.

Sources : https://developer.chrome.com/blog/autoplay, https://developer.mozilla.org/docs/Web/API/AudioSession/type.

---

## 4. La « tonalité » et la limite de 2 secondes

### 4.1 Ce qu'est une tonalité

Gradium n'a **aucun réglage d'émotion ni de style, et pas de SSML** (un langage de balises pour guider une voix). Il ne comprend que deux balises, `<flush>` et `<break time="…"/>`, et lit tout le reste à voix haute (`SCRATCH/gradium/guides_voices_voice-design.md`).

Une tonalité est donc un **préréglage choisi dans une liste fermée**, stocké dans `config/tonalities.json` (versionné ; les ids de voix ne sont pas secrets) :

```json
{"id": "noemie-fr", "label": "Espiègle", "language": "fr",
 "voice_id": "FXxJ9mANRq6BCTX5", "fallback_voice_id": "YhIHaAfQ0cQPDV9R",
 "temp": 0.7, "padding_bonus": 0.0, "sample_clip": "0b8d3e57-94c1-4a26-bd70-e2f5a918c3d4", "enabled": true}
```

- `temp` : variabilité de la voix, de 0,0 à 1,4, 0,7 par défaut.
- `padding_bonus` : débit, de −4 à 4 ; **négatif = plus rapide**. C'est le seul réglage de vitesse (`SCRATCH/gradium/guides_voice-settings.md`).
- On **n'envoie pas** `cfg_coef` : le modèle bêta l'ignore (`SCRATCH/gradium/guides_release-notes_2026-09.md`).
- `fallback_voice_id` : une voix du catalogue utilisée si une voix créée disparaît.

**Première liste** (voix « flagship » fournies par Gradium ; ids tirés de `SCRATCH/gradium/guides_voices_flagship-voices.md`, à revérifier avec `GET https://api.gradium.ai/api/voices/?include_catalog=true`) :

| Langue | Voix | `voice_id` |
|---|---|---|
| FR | Solène (enthousiaste) | `YhIHaAfQ0cQPDV9R` |
| FR | Noémie (Parisienne, espiègle) | `FXxJ9mANRq6BCTX5` |
| FR | Coralie (gloussante) | `ZeSg853xFACESHHI` |
| FR | Damien (coach intense) | `25AzBFyp6svYnJsj` |
| FR | Augustin (curieux, geek) | `Tek4tJXiX6_yvXq7` |
| EN | Zoey (Gen Z enjouée) | `NbpkqMVS3CJeq2j8` |
| EN | Sterling (théâtral) | `6MFfc37kq0sBjBjy` |
| EN | Damon (surexcité) | `KUpE0JVhjiIzp1Fk` |
| EN | Garrett (grave, magnétique) | `POBHtemksfWQbng0` |
| EN | Marlowe (rieuse) | `Bla6SbVMczYnOhfK` |

**Plus tard, en option : 4 à 8 personnages créés par Voice Design** (pirate, ogre, présentateur radio…). Voice Design fabrique une voix à partir d'une description écrite.
- Toujours **hors partie** : trois candidates prennent « three to five seconds » (doc Voice Design).
- On écoute chaque candidate en REST avec un texte de 100 caractères au plus, puis on convertit la meilleure avec `POST /voices/from-embedding`.
- Chaque voix convertie prend une place de voix personnalisée. Le nombre de places de ton offre est inconnu : à demander au stand.
- Le script `SCRATCH/wf/gradium-bench/design_voices.py` n'a jamais tourné sur la vraie API : on le teste sur une seule voix d'abord.

**Côté joueur** : un sélecteur FR/EN filtre les tonalités, avec un bouton ▶ par tonalité. La langue du texte doit suivre celle de la voix : les règles de réécriture du texte suivent la langue de la voix (`guides_voice-settings.md`), et un texte français lu par une voix anglaise sonne faux.

### 4.2 Combien de caractères tiennent en 2 s

- Gradium donne environ 750 caractères par minute, soit **12,5 caractères/s**, donc **25 caractères en 2,0 s** (https://docs.gradium.ai/guides/credits.md ; calcul).
- Avec 0,2 à 0,3 s de silence au début et à la fin, il en reste 21 à 22 (calcul).
- Le débit du français n'est pas documenté : **à mesurer** (§9).
- Un dépôt de Gradium affirme que `padding_bonus` à ±2 change la durée d'environ ±30 % (`SCRATCH/wf/gradium-extra/gh-skills/…/SKILL.md`, **non vérifié**).

### 4.3 Garantir 2 s au plus, en trois couches

1. **Front** : compteur, conseil à 25 caractères (`recommended_chars`), blocage à 40 (`max_chars`).
2. **Serveur, avant Gradium** :
   - nettoyage : normalisation Unicode NFC, **remplacement des apostrophes et guillemets typographiques** (`’ ‘ ʼ` → `'`, `« » “ ”` → `"`, `– —` → `-` ; iOS et macOS tapent `’` par défaut, sinon « l’eau » deviendrait « leau »), **refus des chiffres** (400 `text_has_digits`), suppression des caractères de contrôle, **suppression de `<` et `>`** (sinon un joueur glisse `<break time="2.0s"/>` et ajoute 2 s de silence), on ne garde que les lettres, les chiffres, les espaces et `. , ! ? ' - … : ;`, espaces multiples réduits, au moins une lettre ;
   - refus au-delà de 40 caractères ;
   - débit selon la longueur, `padding_bonus = préréglage + ajustement`, borné à [−4, 4]. Valeurs de départ **(estimation, à calibrer)** :

     | Longueur | Ajustement |
     |---|---|
     | ≤ 25 caractères | 0 |
     | 26 à 32 | −1 |
     | 33 à 40 | −2 |

3. **Après génération** (numpy, environ 0,1 ms, mesuré) :
   - retrait du silence au début et à la fin : seuil −45 dB, fenêtres de 10 ms, 20 ms de marge ;
   - si la parole dépasse encore 2,0 s, **coupe à la fin du dernier mot terminé avant 1,97 s**. On lit la fin des mots dans les messages `text` de Gradium (`start_s`/`stop_s`, `SCRATCH/gradium/guides_text-to-speech.md`), moins le silence retiré au début ;
   - sans horodatage, ou si un seul mot dépasse : coupe au passage de 10 ms le plus silencieux entre 1,6 et 2,0 s ;
   - fondu de sortie de 30 ms (le volume descend jusqu'à zéro, ce qui évite un « clic ») ;
   - plafond absolu à 2,000 s ; `truncated` et `spoken_text` décrivent le résultat.

   Un test vérifie la durée **après décodage du MP3**.

### 4.4 Même volume que la bibliothèque

- Le volume est réglé sur le **RMS** (niveau moyen du signal), avec un plafond de crête à −1 dBFS.
- La cible RMS est calibrée une fois, hors ligne, pour sonner comme la bibliothèque à −16 LUFS. Le LUFS mesure le volume perçu. La norme AES TD1008 recommande −16 LUFS pour la musique, −18 pour la parole et −1 dBTP de crête (https://aes.org/wp-content/uploads/2024/01/20210924_TD1008_v3.13.pdf).
- On n'utilise pas pyloudnorm en direct, sinon scipy entrerait dans l'image.

---

## 5. Une génération en direct, étape par étape

### 5.1 Au démarrage (hors chemin critique)

1. Charger `library/manifest.json` et `config/tonalities.json`, vérifier que chaque fichier existe. Encoder une fois 100 ms de silence pour payer l'import de soundfile (15 ms) et de numpy (38 ms), mesurés.
2. Créer un `httpx.AsyncClient` avec `limits=httpx.Limits(max_connections=8, max_keepalive_connections=4, keepalive_expiry=120)`. **Attention** : httpx ferme par défaut une connexion inactive après 5 s. Sans ce réglage, la connexion gardée ouverte ne sert à rien.
3. **Pré-ouvrir 4 connexions** (autant que `MAX_CONCURRENCY`) en lançant 4 `GET https://api.gradium.ai/api/usages/credits` en parallèle (schéma `CreditsSummary`, `SCRATCH/wf/gradium-extra/openapi.json`). Sinon, chaque génération simultanée au-delà de la première paierait TCP+TLS, environ 45 ms mesurés depuis le lieu du hackathon. On note l'IP résolue et le temps TLS dans `/healthz`.
4. **Requête de chauffe** : générer « Ok. » (3 crédits). Elle vérifie la clé, le modèle et le format, et remplit `last_total_ms`. Si Gradium est injoignable, le service **démarre quand même** (`provider_state: down`) et réessaie en fond.
5. **Tâche de fond** : un appel léger toutes les 25 à 30 s sur une connexion inactive à la fois (comme le `POOL_TTL` de 25 s de la démo `tts-latency-race`), et lecture des crédits une fois par minute. Le délai d'inactivité et les limites de débit de Gradium ne sont pas documentés : à demander au stand.

### 5.2 Chemin critique d'un `POST /audio`

1. Go reçoit l'action sur la WebSocket du jeu, déjà ouverte, et fait `POST /audio?inline=true` sur le réseau privé.
2. Vérification du jeton, nettoyage, longueur, liste de blocage, budget du jour : moins de 1 ms **(estimation)**.
3. **Cache des doublons** : `clé = sha256(texte_normalisé | tonalité | modèle | version_du_traitement)`. Si la clé existe, on copie le MP3 (environ 11 Ko) sous un nouvel UUID v4, on l'ajoute à la liste et on répond (`cached: true`), en moins de 10 ms **(estimation)**.
4. Place dans le sémaphore (un compteur qui limite les générations simultanées) : `MAX_CONCURRENCY=4`. Si aucune place ne se libère en 2 s : 429 `busy`.
5. Appel Gradium, `POST https://api.gradium.ai/api/post/speech/tts`, avec les en-têtes `x-api-key` et `Content-Type: application/json` :
   ```json
   {"text": "Où est passé mon sandwich ?", "voice_id": "FXxJ9mANRq6BCTX5",
    "output_format": "pcm_24000", "model_name": "gradium-tts-beta",
    "json_config": "{\"temp\":0.7,\"padding_bonus\":-1}", "only_audio": false}
   ```
   - `pcm_24000` : du son brut, 24 000 échantillons par seconde, entiers 16 bits, mono. Pas d'en-tête WAV à lire et pas de rééchantillonnage ; la voix n'a besoin de rien au-dessus de 12 kHz. On évite `wav`, dont l'en-tête envoyé en flux contient des longueurs fictives (`SCRATCH/gradium/guides_voices_voice-design.md`).
   - `only_audio: false` : la réponse est un flux **NDJSON** (une ligne JSON par message) avec l'audio en base64 **et** les messages `text` horodatés ; la fin du corps marque la fin (`SCRATCH/gradium/guides_text-to-speech-rest.md`).
   - `json_config` part en **chaîne JSON**, parce que les sources ne sont pas d'accord sur son type et que le SDK envoie une chaîne (`SCRATCH/gradium/api-reference_endpoint_tts-post.md`, `voices.py`).
6. Lecture du flux : décodage du base64 en int16, horodatages gardés, instant du premier `audio` noté. **Au-delà de 2,4 s d'audio reçu, on ne décode plus**, mais on lit jusqu'au bout pour que la connexion reste réutilisable. Les crédits sont comptés au caractère envoyé, donc la suite ne coûte rien de plus.
7. Post-traitement (§4.3, §4.4), puis **encodage MP3 avec soundfile** en 24 kHz mono VBR (débit variable), `compression_level=0.5`, soit 10 944 octets pour 2 s (mesuré), dans `asyncio.to_thread` pour ne pas bloquer les autres requêtes.
   - Un fichier d'environ 11 Ko tient dans la fenêtre TCP initiale d'environ 14,6 Ko (RFC 6928) : il passe sans aller-retour de plus même sur une connexion neuve.
   - À 24 kHz, ne pas descendre sous 64 kb/s en CBR (débit constant) : l'en-tête gapless n'est alors plus écrit (mesuré).
8. Écriture atomique de `CLIPS_DIR/<uuid>.mp3` et de `<uuid>.json` (`kind`, `duration_ms`) (fichier temporaire, puis renommage), date de modification fixée (`os.utime`), **ajout à la liste** (le hash de l'`ETag` change), enregistrement dans le cache des doublons, réponse 201.
9. Après la réponse : une ligne de journal JSON (`id, tonality, chars, model, cached, truncated, timings`), **sans le texte**.

**Erreurs de Gradium.** Le contrat varie selon les sources :
- avant le flux, HTTP 500 avec du texte brut du genre `error from server 1008: …` (https://docs.gradium.ai/guides/errors.md) ;
- pendant le flux, des lignes `{"type":"error",…}`.

On lit donc le corps comme du texte, puis on tente le JSON. On vérifie le comportement réel au jalon J2 avec **une requête volontairement fausse** (voix inexistante, clé invalide).

### 5.3 Budget de latence : du clic « Créer » au son chez le créateur

| Étape | Temps | Source |
|---|---|---|
| Navigateur → Go (WebSocket ouverte, ½ aller-retour) | 20 à 50 ms | **estimation** (aller-retour 4G de 40 à 100 ms, estimé) |
| Go → service (réseau privé, même région) | ~1 ms | **estimation** |
| Validation, cache des doublons | < 1 ms | **estimation** |
| Service → Gradium, ½ aller-retour | ~7 ms si Gradium répond depuis Paris | ½ des 13,85 ms Paris↔Amsterdam (https://wondernetwork.com/pings/Paris/Amsterdam). Depuis le lieu du hackathon, `api.gradium.ai` résout vers Scaleway Paris (mesuré), mais **depuis Amsterdam il peut router ailleurs** : à lire dans `/healthz` |
| Gradium, premier son (bêta) | < 50 ms mesuré par Gradium **en WebSocket avec le setup envoyé à l'avance** (225 ms pour `default`) ; **en REST, inconnu** (la mise en place de la session est payée à chaque requête) | chiffre de Gradium, qui « varies with network conditions and input » (`guides_release-notes_2026-09.md`) ; **à mesurer en J2** |
| **Gradium, reste du clip (~2 s de voix)** | **inconnu ; provision de 100 à 400 ms** | **estimation non sourcée : c'est l'inconnue n° 1**, rien n'est publié |
| Gradium → service, ½ aller-retour | ~7 ms | **estimation** |
| Post-traitement + MP3 | 2,6 à 3,2 ms sur M3 Pro ; ≤ 10 ms sur un vCPU cloud | mesuré (`out_bench.txt`) ; facteur cloud ×2-3 **(estimation)** |
| Service → Go → navigateur (~15 Ko en base64) | 20 à 50 ms | **estimation** |
| `GET` du MP3 | **0 ms** avec `inline` (sinon ~50 ms en bonne 4G) | modèle de livraison (`SCRATCH/wf/audio`), **estimation** |
| `decodeAudioData` à chaud | 1 à 5 ms | mesuré (Chromium 152, Safari 27) |

- **Total hors génération Gradium : environ 50 à 125 ms (estimation). Total : environ 0,2 à 0,6 s (estimation).**
- **Objectifs** : médiane de `timings_ms.total` ≤ 300 ms, et médiane client ≤ 600 ms. À confirmer par la mesure.
- **Au vote** : on n'attend que le premier clip (un aller-retour + 11 à 25 Ko, soit environ 60 à 150 ms en 4G, **estimation**) ; les autres se chargent pendant qu'il joue ses 2 s.

### 5.4 Hors du chemin critique

- Fabrication de la bibliothèque et calibrage du volume.
- Voice Design, répliques d'exemple.
- Ouverture, chauffe et entretien des connexions ; lecture des crédits.
- Journaux après la réponse.
- Préconnexion et décodage de chauffe dans le navigateur.
- **Aucun LLM** dans le chemin, et la modération se limite à une liste de mots.

### 5.5 Options activées seulement si la mesure le justifie (§9)

| Option | Déclencheur | Détail |
|---|---|---|
| Client WebSocket multiplexé | `ws_warm` bat le REST de plus de 30 ms en médiane | Une seule WebSocket, `client_req_id` par requête, `close_ws_on_eos:false`, `setup`/`text`/`end_of_stream` envoyés d'un coup sans attendre `ready` (`SCRATCH/gradium/guides_multiplexing.md`, `guides_websocket-stream-options.md`). Une erreur liée à un `client_req_id` ne termine que cette requête. Ping toutes les 20 s, reconnexion avec délais croissants. **Le renouvellement du socket avant 3000 s n'est qu'une précaution** : la doc appelle « session » chaque `client_req_id` (message « Session already active (req-a) », `guides_multiplexing.md` l.147), donc on ne sait pas si la limite de 3000 s (`guides_limits.md`) vise le socket entier. À demander au stand. |
| `setup` envoyé à l'avance par voix | écart `setup`→`ready` > 50 ms sur un socket chaud | Comme la démo `SCRATCH/wf/gradium-extra/gh-examples/tts-latency-race/server.py`. Le délai d'inactivité d'un setup en attente n'est pas documenté. |
| Génération spéculative | clip complet > ~400 ms | Go envoie `POST /audio` avec `"speculative": true` quand le joueur arrête de taper ~700 ms. Le clic final tombe dans le cache des doublons. Environ 25 à 40 crédits par brouillon **(estimation)**. |
| Streaming du PCM au créateur | clip complet − premier son > 300 ms | Probablement inutile pour 2 s de voix stockée puis rejouée. |

---

## 6. La bibliothèque de sons

### 6.1 Sources : l'intérêt d'abord (décision d'Oscar, 26/09)

La licence n'est plus un critère de sélection : on prend les sons **les plus intéressants pour le jeu**. Seules exclusions : les **extraits d'œuvres connues** (films, séries, jeux vidéo, chansons, jingles de marque). Ils sont reconnus en une seconde, donc sans ambiguïté pour le jeu, et ce sont eux qui déclenchent les demandes de retrait.

Risque accepté : le repo est public et chaque son est servi seul en mp3. Une demande de retrait (DMCA) adressée à GitHub ou à itch.io pourrait faire retirer le jeu, probabilité faible pendant un hackathon. Parade : `CREDITS.md` garde la source de chaque son, pour pouvoir en retirer un seul en quelques minutes.

Sources, par intérêt pour Dixit :
- **Freesound**, toutes licences (CC0, CC BY, CC BY-NC, Sampling+) : le plus grand choix de sons évocateurs, tri par note et par nombre de téléchargements. Recherche et aperçus mp3 (~128 kb/s, suffisants pour 2 s) avec une clé d'API gratuite (compte à créer par Oscar) ; 60 requêtes/min et 2000/jour (https://freesound.org/docs/api/overview.html).
- **BBC Sound Effects** (archives, très évocatrices ; licence RemArc, usage non commercial).
- **Sonniss GDC bundles** (qualité professionnelle, surtout pour les ambiances ; la licence interdit de redistribuer les fichiers bruts).
- Pixabay, Mixkit, Zapsplat en complément.
- Kenney et OpenGameArt en dernier : surtout des sons d'interface de jeu, peu évocateurs.
- Répliques Gradium générées à l'avance.

Méthode de sélection (Claude ne peut pas écouter) : une quarantaine de thèmes évocateurs, les meilleurs candidats par note et téléchargements, une présélection d'environ 300 sons, puis **une écoute humaine d'environ 1 h** pour garder les 120 meilleurs.

### 6.2 Volume visé et composition

- **120 clips d'abord** : une partie à 6 joueurs, 2 tours de conteur chacun, consomme 96 clips sans répétition. Puis **environ 300**.
- Chevauchement moyen entre deux parties de 96 clips : 46 clips avec une bibliothèque de 200, 31 avec 300, 18 avec 500 (simulation, `SCRATCH/wf/library/sizing.py`).
- 300 clips à 96 kb/s pèsent environ 6 Mo, sans problème pour Git ni pour l'image (limites GitHub : https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).
- **Composition** (proposition de conception, sans source) :
  - 25 % d'ambiances ;
  - 25 % de bruitages d'actions ;
  - 20 % de sons humains sans paroles (rires, soupirs) ;
  - 10 à 15 % de répliques de 1 à 5 mots, rendues avec les voix des tonalités ;
  - 10 % de jingles ;
  - 5 à 10 % de sons abstraits.

  On choisit des sons qui évoquent une situation ou une émotion. On évite les sons de marque et les voix de personnes réelles.
- **Répliques Gradium** : 40 à 80 lignes × 3 prises ≈ 6 000 crédits, soit 0,6 % du million **(estimation)**. Tester d'abord 10 onomatopées (« Hahaha ! », « Pfff… ») : aucune balise de rire n'est documentée.

### 6.3 Script de fabrication (hors ligne, sur ton Mac ; résultat committé)

`tools/build_library.py`, à partir de `SCRATCH/wf/library/poc_build.py`, qui fait déjà les étapes 3 à 6 en environ 38 ms par clip (une entrée de 2000 ms ressort à 2000 ms au décodage, mesuré). Il lit `tools/sources.yaml` (fournisseur, id ou prompt, kind, catégorie, tags, licence, décalage de départ), puis :

1. récupère le son (aperçu mp3 Freesound via l'API, fichier BBC / Sonniss / autre site rangé dans `tools/raw/`, ou génération Gradium) ;
2. le décode en mono 48 kHz avec ffmpeg, fourni par `imageio-ffmpeg` (ffmpeg 7.1 arm64 avec libmp3lame, sans Homebrew, testé) ;
3. retire le silence de début, garde les 2 s les plus fortes au plus, fondu de 30 ms ;
4. règle le volume avec pyloudnorm, plafond à −1 dBFS : **−16 LUFS pour les sons, −18 LUFS pour les voix** (norme AES TD1008) ; la cible RMS du direct est calée sur les répliques de voix de la bibliothèque. Un clip de moins de 400 ms est mesuré sur une copie répétée ;
5. **encode avec soundfile, comme en direct** : MP3 **24 kHz** mono VBR (`compression_level` 0,3 à 0,5). Pas avec ffmpeg : l'en-tête « Lavf » qu'il écrit est ignoré par Safari (clip lu en 2,064 s au lieu de 2,000 s, départ décalé, mesuré). 24 kHz est la seule fréquence mesurée exacte dans Chromium et Safari ;
6. **redécode pour contrôler** : durée ≤ 2000 ms et volume ; échec si hors limite ou si la source n'est pas renseignée (pour `CREDITS.md`). En J4, écouter en plus 3 clips de la bibliothèque **dans Safari** (durée décodée, départ) ;
7. id = **UUID v4 tiré au hasard la première fois** qu'un son entre dans la bibliothèque, puis **conservé** d'une reconstruction à l'autre (le script retrouve le son par sa source dans l'ancien manifeste) : les ids déjà distribués restent valides. Jamais d'id dérivé du contenu (voir §3). Enfin, écriture de `library/manifest.json` et `library/CREDITS.md`.

`--check` (lancé aussi par les tests) : fichiers présents, durées ≤ 2000 ms, source renseignée pour chaque son.

Outils : `uv run --group tools`, avec `pyloudnorm`, `imageio-ffmpeg`, `soundfile`, `numpy`, `pyyaml` (déjà testés dans `SCRATCH/wf/library/venv`).

### 6.4 Format du manifeste (`library/manifest.json`)

Il reprend `SCRATCH/wf/library/manifest_example.json`, avec une entrée par clip :

```
id, file, kind, category, title, description, tags, language, duration_ms,
sample_rate, channels, bitrate_kbps, bytes, sha256, loudness_lufs, peak_dbfs,
source{provider, source_id, source_url, author, license (code SPDX), license_url, attribution, modified},
generator{model, voice_id, text|prompt, generated_at} | null,
review{status, by, at}, deal (bool), enabled (bool)
```

Le service ne lit que `id, file, kind, duration_ms, deal, enabled`.
- `/audio/list` renvoie les clips `enabled && deal`, **plus les sons créés** (§6.5).
- Les répliques d'exemple des tonalités ont `deal: false` : elles sont servies mais jamais distribuées.

### 6.5 Service et clips générés

- `library/` est **copiée dans l'image** et servie par `FileResponse`.
- **Les sons créés rejoignent `/audio/list` dès leur création** (exigence du coéquipier) : sinon, un joueur qui compare l'id d'un candidat à la liste saurait qu'il a été créé pendant la partie.
- Conséquence : ils peuvent être distribués aux autres joueurs. Le service ne les marque pas (ce serait un indice) ; si l'équipe ne le veut pas, Go les écarte avec les ids reçus en réponse à ses `POST`. Leur texte n'étant relu par personne, la liste de mots bloqués compte davantage.
- `library/manifest.json` ne doit **pas** être servi par le service ni publié ailleurs que dans le repo : il contient titres et tags.
- **Limite connue** : un joueur qui relit `/audio/list` avant et après la création d'un son voit apparaître un nouvel id. On ne peut pas l'empêcher sans cacher la liste au navigateur, ce que l'exigence CORS exclut. Risque faible en hackathon ; à signaler à l'équipe.

---

## 7. Stockage, cache, sécurité, replis

### 7.1 Stockage

- **Bibliothèque** : dans l'image, en lecture seule.
- **Clips générés** : `CLIPS_DIR=/tmp/clips/<uuid>.mp3`, avec `<uuid>.json` à côté (`kind`, `duration_ms`). L'id est un UUID v4 (§3). Tout est servi par le **même** `FileResponse`, donc un seul chemin de code, Range/206 gratuit et des en-têtes identiques.
- **Registre** : un simple `dict id → (chemin, kind, duration_ms)` pour la bibliothèque et les sons créés, reconstruit au démarrage à partir du manifeste et des `<uuid>.json` de `CLIPS_DIR`.
- **Redéploiement** : les clips générés sont perdus (404). Go remplace alors la carte. L'état de jeu de Go est lui aussi en mémoire, d'après le README. **Pas de redéploiement pendant la démo.**
- **Option** si l'équipe veut que les clips survivent : un volume Railway sur `/data` (`CLIPS_DIR=/data/clips`), 5 Go en Hobby, au prix d'une courte coupure à chaque redéploiement (https://docs.railway.com/reference/volumes).
- **Pas de nettoyage automatique** : 11 Ko par clip.

### 7.2 Cache HTTP

| Ressource | Cache-Control |
|---|---|
| `/audio/{id}` | `immutable`, un an, avec ETag |
| `/audio/list` | `no-cache`, avec ETag (304 si rien n'a changé) |
| `/audio/tonalities` | 30 s |

Pas de gzip sur les MP3, qui sont déjà compressés.

### 7.3 Sécurité

- **Clé Gradium** :
  - seulement en variable d'environnement : variable **scellée** sur Railway, illisible après saisie (https://docs.railway.com/variables.md) ;
  - en local, dans `secret/gradium.env`, puisque le `.gitignore` actuel ne contient que `secret` ;
  - proposer à l'équipe d'ajouter `.env` et `*.env`, et committer un `.env.example` vide ;
  - la protection de GitHub contre les secrets poussés ne reconnaît peut-être pas le format Gradium (https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection) ; or une clé poussée = disqualification. Vérification avant le gel, en cherchant **la valeur exacte de la clé** dans tout l'historique sans l'afficher : `git grep -lF "$(cut -d= -f2 ../secret/gradium.env)" $(git rev-list --all) && echo FUITE || echo ok`, plus un passage de gitleaks (binaire téléchargeable) avant de rendre le dépôt public. **Si une fuite est trouvée, révoquer la clé** : réécrire l'historique ne suffit pas ;
  - **aucune clé du compte Google du sponsor** dans ce service.
- **`POST /audio`** exige `X-Service-Token`, comparé avec `hmac.compare_digest` (comparaison à temps constant). Le domaine public expose toutes les routes, d'où ce jeton.
- **Garde-fous de crédits, dans le service** :
  - `MAX_CHARS=40` ;
  - `MAX_CONCURRENCY=4` (la limite de sessions simultanées de ton offre n'est pas publiée, `guides_limits.md`) ;
  - `DAILY_CHAR_BUDGET=50000`, soit environ 1 500 clips par jour **(estimation)**, 429 au-delà ;
  - `CREDIT_FLOOR=20000` : en dessous, 503, ce qui garde une réserve pour le pitch.
  - Un clip coûte 1 crédit par caractère, soit 25 à 40 crédits ; 1 M de crédits ≈ 25 000 à 40 000 clips (https://docs.gradium.ai/guides/credits.md, calcul).
- **Dans Go** : 1 génération par joueur toutes les 5 s et 1 par manche (proposé), plus une limite par connexion.
- **Modération** : `config/blocklist.txt`, quelques dizaines de mots FR/EN, comparés sur le texte en minuscules sans accents ; 400 `text_rejected`. Pas de LLM.
- **Pas de clonage de voix en direct** (les voix sont des préréglages), ce qui respecte la règle de Gradium contre l'usurpation. **Mention « Voices generated with Gradium AI »** dans les crédits et sur la page itch.io, parce que les conditions demandent d'informer qu'on entend de l'IA (https://gradium.ai/terms-of-service).

### 7.4 Replis (la bibliothèque reste toujours jouable)

`PROVIDER` vaut `gradium` (production), `fake` (développement et tests seulement, jamais pour le jury) ou `off` (génération coupée proprement).

| Panne | Réaction |
|---|---|
| Échec de connexion **avant** l'envoi du texte | Une seule nouvelle tentative. Jamais après l'envoi, pour ne pas payer deux fois. |
| Erreur du modèle bêta | Une tentative avec `GRADIUM_FALLBACK_MODEL=default` (225 ms au premier son). **Après 3 échecs de suite de la bêta, `default` pendant 30 min.** On journalise `model`. La bêta est publique depuis le 22/09 et peut changer pendant que le jury joue. |
| Voix introuvable | Nouvel essai avec `fallback_voice_id` |
| Réponse contenant `revoked`, `expired`, `credit`, un code 1008, ou HTTP 402 | `provider_state=out_of_credits` : chaque POST répond tout de suite 503, jusqu'à ce que la lecture des crédits redevienne bonne et dépasse le plancher |
| Plus de 5 s | 504 `provider_timeout` |
| Gradium injoignable au démarrage | Le service démarre, `generation_available: false`, reconnexion en fond |
| Après le hackathon | Rien ne dépend du compte Google temporaire. Si la clé ou les crédits disparaissent, seul « Créer un son » se grise. |

---

## 8. Code, Docker, développement, déploiement, tests, documentation

### 8.1 Arborescence (`./audio-service/` dans le monorepo)

```
audio-service/
  pyproject.toml  uv.lock  .python-version  Dockerfile  .dockerignore  railway.json  fly.toml
  .env.example  README.md
  config/tonalities.json  config/blocklist.txt
  library/manifest.json  library/CREDITS.md  library/clips/*.mp3
  docs/openapi.json
  src/audio_service/
    main.py        # app FastAPI, démarrage/arrêt, CORS, format d'erreur, routes, run() lit HOST/PORT
    settings.py    # variables d'environnement
    store.py       # registre bibliothèque + générés, ids, écriture atomique, cache des doublons
    tonality.py    # préréglages, padding_bonus selon la longueur
    textguard.py   # nettoyage, longueur, liste de blocage
    audio.py       # silences, coupe au mot, fondu, RMS, MP3 (soundfile, secours lameenc)
    providers/base.py     # synth(text, preset, padding, model) -> (pcm int16, sr, mots, first_audio_ms)
    providers/gradium.py  # REST NDJSON, pool chaud, crédits, état, repli de modèle
    providers/fake.py     # son synthétique proportionnel au texte + faux horodatages, FAKE_LATENCY_MS
  tools/
    build_library.py  sources.yaml
    probe_latency.py      # = SCRATCH/wf/gradium-bench/gradium_probe.py, adapté (§9.2)
    bench_service.py      # mesure de bout en bout contre le service déployé
    design_voices.py      # = SCRATCH/wf/gradium-bench/design_voices.py (optionnel)
  tests/
    mock_gradium.py       # = SCRATCH/wf/gradium-bench/mock_gradium.py
    test_api.py  test_audio.py  test_gradium.py  test_library.py
```

Environ 500 lignes de code pour le service **(estimation)**.

Dépendances :
- **exécution** : `fastapi`, `uvicorn[standard]`, `httpx`, `numpy`, `soundfile>=0.13`, `lameenc` ;
- **groupe `dev`** : `pytest`, `pytest-asyncio`, `websockets` (le faux serveur l'importe) ;
- **groupe `tools`** : `pyloudnorm`, `imageio-ffmpeg`, `pyyaml`.

Dans `pyproject.toml` : `[project.scripts] audio-service = "audio_service.main:run"` **et** une section `[build-system]` (`uv_build`, déjà dans le prototype `SCRATCH/wf/hosting/proto/audio-service/pyproject.toml`) : sans elle, le script `audio-service` n'est pas installé et le `CMD` du Dockerfile échoue.

**Pièges FastAPI** : déclarer `/audio/list` et `/audio/tonalities` **avant** `/audio/{id}` (sinon « list » est pris pour un id) ; `@app.api_route('/audio/{id}', methods=['GET','HEAD'])`, car `@app.get` ne répond pas à `HEAD` ; `FileResponse` ne gère pas `If-None-Match`/304 : le coder à la main pour `/audio/list` seulement ; enregistrer des gestionnaires pour `StarletteHTTPException` et `RequestValidationError` qui renvoient `{"error":{code,message}}` en gardant les en-têtes CORS.

**À vérifier dès J0** : `sf.write(buf, x, 24000, format="MP3", bitrate_mode="VARIABLE", compression_level=0.5)` dans un `io.BytesIO` avec la version installée. Repli : lameenc q5.

### 8.2 Dockerfile

Il part de `SCRATCH/wf/hosting/proto/audio-service/Dockerfile`, jamais construit faute de Docker ici :

```dockerfile
FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim AS builder
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0 UV_NO_DEV=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-editable
COPY README.md ./
COPY src ./src
RUN uv sync --locked --no-editable

FROM python:3.12-slim-trixie
RUN groupadd --system --gid 999 app && useradd --system --gid 999 --uid 999 --create-home app
COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app config/ /app/config/
COPY --chown=app:app library/ /app/library/
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 HOST="" PORT=8080 CLIPS_DIR=/tmp/clips
WORKDIR /app
USER app
EXPOSE 8080
CMD ["audio-service"]
```

- Le groupe `tools` n'est pas installé : il faut `UV_NO_DEV=1` et le déclarer hors des groupes par défaut.
- **Debian slim, pas Alpine** : lameenc n'a pas de paquet précompilé pour musl, et les paquets manylinux supposent glibc.
- **Pas de cache BuildKit** : Railway exige un format d'id spécial (https://docs.railway.com/builds/dockerfiles.md).
- `CMD` en forme exec : Python reçoit directement le signal d'arrêt (doc FastAPI).
- `HOST=""` écoute en IPv4 **et** IPv6 ; `"::"` seul n'accepterait que l'IPv6 (vérifié sur Python 3.12.14).
- `run()` lance uvicorn avec `workers=1` et `timeout_graceful_shutdown=8`. Une requête en cours finit bien après SIGTERM (mesuré, `SCRATCH/wf/hosting`).

### 8.3 Développement local sur ton Mac (sans Docker, sans ffmpeg, Python 3.9 système intact)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env          # ou ouvrir un nouveau terminal ; puis uv --version
uv python install 3.12
cd audio-service && uv sync
PROVIDER=fake SERVICE_TOKEN=dev uv run audio-service        # http://localhost:8080/docs
uv run pytest
# avec la vraie clé (fichier dans secret/, ignoré par git) :
set -a; source ../secret/gradium.env; set +a; PROVIDER=gradium uv run audio-service
# client réel contre le faux Gradium :
uv run python tests/mock_gradium.py &  PROVIDER=gradium GRADIUM_BASE_URL=http://127.0.0.1:18766/api uv run audio-service
```

- **Coéquipiers** : `AUDIO_URL=http://localhost:8080`, `SERVICE_TOKEN=dev`, `PROVIDER=fake` (latence réglable avec `FAKE_LATENCY_MS=250`). Ni clé, ni crédit.
- **On ne construit pas l'image sur le Mac pour la production** : le Mac est en arm64, l'hébergeur en amd64. On laisse Railway construire.
- Pour un test de conteneur local, si besoin : Docker Desktop, gratuit pour les étudiants (https://docs.docker.com/subscription/desktop-license/).

### 8.4 Déploiement : Railway, région EU West (Amsterdam), dans le même projet que Go

- **Service `audio-service`** :
  - Root Directory `/audio-service` ;
  - fichier de config `/audio-service/railway.json`, en chemin **absolu**, parce que ce fichier ne suit pas le Root Directory (https://docs.railway.com/deployments/monorepo.md) ;
  - contenu déjà rédigé : builder `DOCKERFILE`, `healthcheckPath /healthz`, `drainingSeconds 10`, `overlapSeconds 5`, `watchPatterns ["/audio-service/**"]` ;
  - région EU West choisie explicitement ; **mise en veille (« Serverless ») désactivée**, c'est la valeur par défaut (https://docs.railway.com/deployments/serverless.md).
- **Variables** : `PORT=8080` (explicite : Railway injecte sinon son propre `PORT`, et l'URL privée `:8080` de Go ne correspondrait plus ; régler aussi le port cible du domaine public sur 8080), `PROVIDER=gradium`, `GRADIUM_API_KEY` (scellée), `SERVICE_TOKEN` (scellée, partagée avec Go), `GRADIUM_BASE_URL=https://api.gradium.ai/api`, `GRADIUM_MODEL=gradium-tts-beta`, `GRADIUM_FALLBACK_MODEL=default`, `MAX_CHARS=40`, `MAX_CONCURRENCY=4`, `DAILY_CHAR_BUDGET=50000`, `CREDIT_FLOOR=20000`, `PROVIDER_TIMEOUT_S=5`.
- **Côté Go** : `AUDIO_URL=http://${{audio-service.RAILWAY_PRIVATE_DOMAIN}}:8080`, sur le réseau privé (https://docs.railway.com/reference/private-networking). Côté front, le **domaine public HTTPS** généré par Railway. Depuis itch.io, tout autre domaine doit être en HTTPS (https://itch.io/docs/creators/html5), et une IP nue serait bloquée comme contenu mixte.
- **Premier déploiement sans app GitHub** : `npm i -g @railway/cli && railway up` (https://docs.railway.com/cli/up.md).
- **Coût** : passer au plan Hobby, 5 $/mois pour les deux services **(estimation)**, **avant la démo**. L'essai n'est qu'un crédit unique de 5 $ sur 30 jours, et l'essai limité restreint le trafic sortant (https://docs.railway.com/reference/pricing/free-trial). Vérifier dès J1 que le conteneur joint bien `api.gradium.ai:443`.
- **Pénalité d'Amsterdam** : environ +14 ms d'aller-retour si Gradium répond depuis Paris **(estimation)**. On lit `gradium_ip` et `tls_ms` dans `/healthz`.
  - **Plan B** : Fly.io `cdg` (Paris) **pour les deux services**, avec `auto_stop_machines="off"`, `kill_signal SIGTERM`, `kill_timeout 10`, environ 3,6 $/mois par machine de 512 Mo (calcul d'après https://docs.fly.io/about/pricing.md ; brouillon `fly.toml` prêt).
  - Déplacer seulement le service audio ne gagne rien : le trajet Go → audio s'allonge d'autant.
- **Version jury figée** : tag `v1.0` et déploiement automatique coupé après la remise.

### 8.5 Tests (toujours `fake` ou `mock_gradium.py`, zéro crédit)

- **`test_api.py`** : `list` renvoie un tableau (et 304 sur `If-None-Match`) ; `GET` renvoie `audio/mpeg`, les en-têtes de cache, 206 sur Range, 404 ; `HEAD` répond ; `POST` renvoie 201 puis `GET` fonctionne ; `inline` ; doublon = nouvel id + `cached` ; 400 / 401 / 429 / 503 ; CORS sur tous les `GET` et `HEAD` (y compris les réponses 404) et sur la vérification préalable `OPTIONS` avec `Origin: https://html-classic.itch.zone` et `Range` ; `POST` refusé en vérification préalable.
- **`test_indiscernable.py`** : tous les ids sont des UUID v4 ; un son créé apparaît dans `/audio/list` avec les mêmes champs qu'un son de la bibliothèque ; la liste est triée par id ; `Last-Modified` identique et `ETag` sans lien avec la date pour un son créé et un son de la bibliothèque ; mêmes en-têtes MP3 (en-tête LAME, fréquence, pas d'ID3).
- **`test_audio.py`** : 3,5 s en entrée ressort à ≤ 2,000 s **après redécodage du MP3** ; coupe au mot ; coupe au passage silencieux sans horodatage ; fondu ; silences retirés ; `<break>` retiré par le nettoyage ; « l’eau » garde son apostrophe ; « 1234567 » est refusé.
- **`test_gradium.py`** : client réel contre le faux serveur, avec lecture NDJSON, 500 en texte brut, ligne d'erreur, délai dépassé, repli vers `default` puis bascule durable, `out_of_credits`.
- **`test_library.py`** : `build_library.py --check`.
- **Intégration continue** : un petit workflow GitHub Actions (`uv sync` + `pytest` avec `PROVIDER=fake`), environ 10 min de travail ; le jury note la qualité du build.

**Le faux serveur (`mock_gradium.py`) doit être étendu avant ces tests** (environ 45 min, en J3a) : il ne renvoie aujourd'hui que du PCM 48 kHz brut. À ajouter : mode NDJSON (lignes `audio` base64 + `text` avec `start_s`/`stop_s` + fin), respect de `pcm_24000`, `GET /api/usages/credits`, modes de panne (500 en texte brut « error from server 1008: … », ligne `{type:error}`, délai, 402), port en argument.

### 8.6 Documentation pour le jury

`audio-service/README.md` contient :
- le rôle du service et le schéma du §1 ;
- 3 commandes d'installation ;
- le tableau des variables d'environnement ;
- les endpoints avec exemples `curl` et codes d'erreur ;
- les replis ;
- le **tableau de latence mesurée** (sortie de `bench_service.py`) ;
- les liens `/docs` et `docs/openapi.json` ;
- la section « Tester sans clé : `PROVIDER=fake` » ;
- les crédits (`library/CREDITS.md`, « Voices generated with Gradium AI ») ;
- le tableau « outils utilisés » : Gradium TTS (REST, `gradium-tts-beta`, Voice Design), FastAPI, uvicorn, httpx, numpy, soundfile/libsndfile/LAME, lameenc, uv, Docker, Railway ; hors ligne : imageio-ffmpeg/ffmpeg, pyloudnorm ; sons : Freesound, Kenney, OpenGameArt.

---

## 9. Plan de build

### 9.1 Étapes (une personne ; durées **estimées**)

| # | Durée | Livrable | Débloque |
|---|---|---|---|
| **J0** | 0 h 30 | uv + Python 3.12, squelette, vérification de l'appel MP3 de soundfile. **Poster le §3 et le §3.7 dans le chat de l'équipe**, faire valider en 10 min par Go et le front | contrat figé |
| **J1** | 1 h 00 | **Service bouchon déployé** : `PROVIDER=fake`, les 5 endpoints avec leurs formes finales (y compris `inline`), CORS, `/docs`, 20 à 30 clips Kenney CC0 passés par le prototype, 5 tonalités avec répliques factices, Dockerfile, `railway up` en EU West. Envoyer l'URL publique, le domaine privé et `SERVICE_TOKEN` | **Go** (pioche, POST) et **front** (lecture, formulaire). Fait apparaître tôt les problèmes de région, DNS privé, CORS et sortie réseau |
| **J2** | 0 h 45, en parallèle de J1 | Mesures Gradium depuis Paris (§9.2) + une requête volontairement fausse (format d'erreur, type de `json_config`) | décisions : transport, `MAX_CHARS`, table de débit, horodatages bêta en FR |
| **J3a** | 2 h 45 | Faux serveur étendu (45 min), puis l'indispensable : client NDJSON sur un seul `httpx.AsyncClient` (`keepalive_expiry=120`), `textguard.py`, post-traitement avec plafond à 2,0 s et fondu, sémaphore, `MAX_CHARS`, délai, **un seul repli** (une nouvelle tentative avec `default` si la bêta échoue), tests, déploiement, `bench_service.py` | vraie génération en ligne |
| **J3b** (optionnel) | 1 h 30 | Coupe au mot, cache des doublons, budget du jour et plancher de crédits, bascule durable vers `default`, voix de secours, pool pré-ouvert à plus d'une connexion | robustesse, latence des générations simultanées |
| **J4** | 2 h 00 (un coéquipier peut aider à l'écoute) | `build_library.py`, `sources.yaml`, **120 clips**, 20 à 40 répliques Gradium dont une par tonalité, `CREDITS.md` | parties complètes |
| **J5** | 0 h 45 | Liste de blocage, README du service, `.env.example`, export `openapi.json`, test depuis itch.io (**vérifier dans DevTools l'origine réelle de l'iframe**), test sur un vrai iPhone | critères du jury |
| **J6** (optionnel) | 1 à 2 h | Ce que J2 justifie (§5.5) ; 4 à 8 voix Voice Design ; bibliothèque portée à 300 | qualité, latence |
| **J7** | 0 h 30 | Plan Hobby, dernier `bench_service.py`, chiffres dans le README, vérification qu'aucune clé n'est dans l'historique, tag `v1.0` | version jury |

**Total : environ 8 h 15 sans J3b ni J6 ; 9 h 45 avec J3b ; 10 h 45 à 11 h 45 avec tout (estimation).** Si le temps manque, garder dans l'ordre J1 > J3a > J4 (120 clips) > J5 > J7.

### 9.2 Scripts de mesure

**`tools/probe_latency.py`** (Gradium seul) reprend `SCRATCH/wf/gradium-bench/gradium_probe.py`. Il a été testé de bout en bout contre le faux serveur, mais jamais contre Gradium. Deux adaptations, environ 15 min **(estimation)** :
- `output_format` réglable (`pcm_24000` au lieu de `pcm`) ;
- un transport `rest_ndjson` (`only_audio:false`), celui de la v1, en plus de `ws_cold`, `ws_warm`, `ws_preset` et `rest` (`only_audio:true`).

```bash
GRADIUM_API_KEY=… uv run python tools/probe_latency.py --n 3                       # default vs beta, tous transports
GRADIUM_API_KEY=… uv run python tools/probe_latency.py --models gradium-tts-beta \
   --transports ws_warm --padding=-2,-1,0                                          # caractères/s FR et EN
```

- Il vérifie que la connexion REST est **réutilisée** d'une requête à l'autre (voir §2), mesure l'effet d'une phrase contenant un nombre, puis le temps avant le premier son, **le temps du clip complet**, la durée audio, la durée de parole sans silences et les caractères par seconde. Il sauve aussi des WAV pour écouter.
- Coût : environ 3 000 à 4 000 crédits pour le premier passage **(estimation)**.
- **À lancer depuis Paris, puis une fois depuis le conteneur Railway** (commande ponctuelle, ou chiffres lus dans `/healthz`).

**`tools/bench_service.py`** (de bout en bout) :
- `--url --token --n 30 --concurrency 1|4` ;
- des textes tous différents (pour contourner le cache), sur toutes les tonalités, puis les mêmes textes pour mesurer le cache ;
- lit `timings_ms` et `Server-Timing` ;
- affiche p50/p95/max côté client et côté serveur, plus un `GET` de clip, et écrit un CSV.

Ces chiffres vont dans le README et le pitch. p50 et p95 : la valeur sous laquelle tombent 50 % et 95 % des mesures.

**Règles de décision** (les seuils sont des choix, pas des données) :

| Mesure | Décision |
|---|---|
| Connexion REST non réutilisée, **ou** `ws_warm` < `rest_ndjson` − 30 ms en médiane | construire le client WebSocket |
| Clip complet > 400 ms | génération spéculative |
| Clip complet − premier son > 300 ms | envisager le streaming |
| `setup`→`ready` > 50 ms | setup à l'avance |
| Premier son depuis Railway > premier son depuis Paris + 30 ms | Fly `cdg` pour les deux services |
| Caractères/s réels | `MAX_CHARS`, `recommended_chars` et table de débit |

---

## 10. À caler avec l'équipe (une décision chacune, défaut proposé)

1. **Qui appelle `POST /audio` ?** Défaut : Go seulement (jeton + limite par joueur). Le navigateur ne fait que des `GET`.
2. **Qui télécharge les MP3 ?** Défaut : le navigateur, directement sur l'URL publique du service. Go ne manipule que des ids, plus `mp3_base64` pour le créateur.
3. **Forme de `GET /audio/list` ?** Défaut : tableau nu `[{id, kind, duration_ms}]`, ids en UUID v4, sans titre ni tags, bibliothèque et sons créés mêlés, triés par id ; URL = `AUDIO_PUBLIC_URL + "/audio/" + id`.
4. **Un son créé remplace-t-il une carte, ou la main passe-t-elle à 6 ?** (Le README dit « add it to the hand ».) Défaut : il remplace une carte choisie par le joueur, et 1 création par manche au plus.
5. **Où tourne Go, sur quel compte, qui paie après le hackathon ?** Défaut : même projet Railway EU West, plan Hobby à 5 $/mois payé par un membre de l'équipe pendant au moins un mois.
6. **Dossier du service ?** Défaut : `./audio-service` à la racine, à côté de `./webapp`, et `.env`/`*.env` ajoutés au `.gitignore`.
7. **Qui installe l'app Railway sur le dépôt GitHub ?** Défaut : le propriétaire du dépôt ; en attendant, `railway up` en ligne de commande.
8. **Langues ?** Défaut : FR et EN, avec un sélecteur qui filtre les tonalités.
9. **Longueur du texte ?** Défaut : compteur dans le front, 25 conseillés, 40 au maximum, valeurs lues dans `/audio/tonalities` et recalibrées après J2.
10. **Les sons créés, présents dans `/audio/list`, peuvent-ils être distribués aux autres joueurs ?** Défaut : non, Go les écarte avec les ids reçus en réponse à ses `POST`. Si oui, rien à faire.
    **Domaines CORS** : `*` par défaut ; liste explicite (`CORS_ORIGINS`) si l'équipe le préfère.
11. **Les clips créés doivent-ils survivre à un redéploiement ?** Défaut : non (pas de volume), pas de redéploiement pendant la démo, et Go remplace toute carte en 404.
12. **Qui aide à écouter et trier la bibliothèque (~1 h 30) ?** Défaut : un coéquipier remplit `sources.yaml` pendant que tu écris le client Gradium.
13. **Le front accepte-t-il les consignes du §3.7 ?** Défaut : oui, intégrées dès le service bouchon.
14. **Questions pour le stand Gradium** (défaut en attendant : limites basses) :
    - limite de sessions simultanées de ton offre (défaut : 4) ;
    - la limite de 3000 s vise-t-elle le socket ou chaque `client_req_id` ;
    - délai d'inactivité d'une connexion ouverte ;
    - durée de vie de l'alias `gradium-tts-beta` (et de la version datée `gradium-tts-beta-202609`) ;
    - nombre de voix personnalisées autorisées ;
    - droit de publier les sons générés dans un dépôt public ;
    - **date d'expiration du million de crédits et de la clé** : le jury peut tester après le hackathon.

---

## 11. Risques principaux et parades

| Risque | Parade |
|---|---|
| Le temps du **clip complet** chez Gradium n'est publié nulle part et peut dominer la latence | Mesure dès J2 ; `timings_ms` dans chaque réponse ; options du §5.5 prêtes |
| L'alias bêta change ou tombe pendant que le jury joue | Repli vers `default`, durable 30 min après 3 échecs ; `model` journalisé ; tester la version datée `gradium-tts-beta-202609` |
| Débit du français, silences ajoutés par la bêta, horodatages absents : clips coupés en plein mot | Calibrage avec la sonde ; coupe au passage silencieux en secours ; `spoken_text` affiché |
| Générations simultanées qui paient TCP+TLS (~45 ms mesurés depuis le lieu du hackathon) | 4 connexions pré-ouvertes et entretenues, `keepalive_expiry=120` (défaut httpx : 5 s) ; tester `httpx[http2]` si Gradium le permet (non documenté) |
| Limites Gradium inconnues (sessions simultanées ; 1500 caractères par session sur l'offre gratuite) | Sémaphore à 4, 429 `busy`, question au stand. En REST, chaque requête est une session séparée, donc la limite par session ne gêne pas |
| Clé poussée sur GitHub = disqualification | Variable scellée, `secret/` ignoré, `.env` à ajouter au `.gitignore`, recherche dans l'historique avant le gel |
| Crédits vidés par abus | `X-Service-Token`, limite par joueur dans Go, `DAILY_CHAR_BUDGET`, `CREDIT_FLOOR`, 40 caractères au plus, cache des doublons |
| Service coupé après le hackathon (essai Railway épuisé) | Plan Hobby avant la démo ; tag `v1.0` ; déploiement automatique coupé ; bibliothèque jouable même sans Gradium |
| Hébergement à Amsterdam : +14 ms, et routage Gradium depuis Amsterdam non mesuré | `gradium_ip` et `tls_ms` dans `/healthz` ; plan B Fly `cdg` pour les deux services |
| Redéploiement : clips générés perdus (404 dans les mains) | Go remplace la carte ; pas de redéploiement pendant la démo ; volume `/data` en option |
| Origine de l'iframe itch.io incertaine | `CORS_ORIGINS=*` par défaut ; vérification dans DevTools après le premier envoi |
| Un son créé repérable (nouvel id dans la liste relue avant/après, date du fichier, id) | UUID v4 partout, sons créés dans la liste triée par id, dates de fichier identiques, mêmes réglages d'encodage ; la comparaison de la liste dans le temps reste possible (limite connue, signalée) |
| iOS : interrupteur silencieux, premier décodage lent, pas testé sur un vrai iPhone | `audioSession 'playback'`, décodage de chauffe, test sur téléphone en J5 |
| `soundfile` : paramètres MP3 différents selon la version | Vérification en J0 ; repli lameenc (+64 ms de longueur, départ décalé de 24 à 46 ms) |
| Demande de retrait d'un son (repo public, licences non respectées, risque accepté par Oscar) | Pas d'extraits d'œuvres connues ; `CREDITS.md` avec la source de chaque son pour en retirer un seul vite |
| Charge de travail d'une personne ; curation de la bibliothèque longue | 120 clips d'abord ; aide à l'écoute ; J6 entièrement optionnel |