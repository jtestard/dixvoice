# Dixvoice : plan final du microservice audio

*26 septembre 2026. **Plan aligné le 26/09/2026 sur le contrat de [`spec/`](../spec)** ([`audio-request.schema.json`](../spec/audio-request.schema.json), [`audio-response.schema.json`](../spec/audio-response.schema.json), [`audio-service.openapi.json`](../spec/audio-service.openapi.json)) et sur la section « Audio Generator Microservice » du [README](../README.md). **`spec/` fait foi** : en cas d'écart entre ce plan et `spec/`, c'est `spec/` qui gagne. Chaque chiffre porte sa source. Ce qui n'est pas mesuré ni sourcé est marqué **(estimation)**.*

*J0 à J7 désignent des **jalons** (étapes du build), pas des jours. Ce document intègre les corrections de la relecture finale, puis les exigences du coéquipier du 26/09 : sons créés impossibles à distinguer des sons listés, ids en UUID, puis le contrat choisi par le chef d'équipe (requête `AudioRequest` `{text, emotion}`, réponse `AudioResponse` `{id, text, emotion, voiceId, clipUrl}`, MP3 servis par un CDN, `emotion` en texte libre, pas de jeton, hébergement sur le cluster gcast).*

`SCRATCH` désigne le dossier de travail local d'Oscar, **pas encore dans le repo**. Les outils déjà écrits sont dans `SCRATCH/wf/` :
- `gradium-bench/` : sonde de latence, faux serveur Gradium, script Voice Design ;
- `audio/` : mesures d'encodage et de navigateurs ;
- `library/` : prototype de fabrication de la bibliothèque ;
- `hosting/proto/audio-service/` : brouillons du Dockerfile, de `railway.json` et de `fly.toml` (Railway et Fly.io **abandonnés**, voir §8.4 ; seul le Dockerfile sert encore).

> **Écarts avec le README du 26/09 (commit 24a24c6) : résolus par l'alignement sur `spec/`.**
> - **Salons** : le README réintroduit les salons à code (4 à 8 joueurs) et une main de **6** emplacements (5 distribués + 1 son créé). Pris en compte (§10, question 4).
> - **Hébergement** : **tranché**. Le service audio tourne sur le cluster Kubernetes gcast, à côté du backend Go, sur le réseau privé du cluster (§8.4). Railway et Fly.io sont abandonnés.
> - **Lecture** : **tranché**. Le front joue les clips depuis le CDN (`clipUrl`) avec un élément HTML `<audio>` ; les requêtes `Range` exigées par Safari sont gérées par le CDN, plus par le service.
> - **`tonality`** : **remplacée par `emotion`, texte libre** (1 à 30 caractères). Plus de `GET /audio/tonalities` ni de liste fermée dans le contrat ; le choix de la voix Gradium à partir de l'émotion est un détail interne (§4.1), encore ouvert (§10).
> - **Sons déjà utilisés** : chaque salon garde la liste des ids distribués ou créés et ne les redistribue pas ; un son créé dans un salon peut donc être distribué dans un autre (question 10 du §10).
> - **Formats** : **alignés**. `POST /audio` reçoit un `AudioRequest` `{text, emotion}` ; `/audio/list`, `GET /audio/{id}` et `POST /audio` (201) renvoient des `AudioResponse` : exactement `{id, text, emotion, voiceId, clipUrl}`.

---

## 1. En une phrase

Un petit programme Python, dans un conteneur Docker, qui fait trois choses :
- il **liste** une bibliothèque de sons préparés à l'avance (objets `AudioResponse` `{id, text, emotion, voiceId, clipUrl}`) ;
- il **publie** chaque son en MP3 sur un CDN (à choisir), qui le sert aux navigateurs à l'adresse `clipUrl` ;
- il **fabrique en direct** une réplique de voix d'au plus 2 s avec Gradium, à partir d'un texte et d'une émotion, en moins d'une demi-seconde visée pour la génération elle-même.

Quelques mots utilisés partout dans ce plan :
- **Conteneur** : une boîte qui contient le programme et tout ce dont il a besoin, et qui tourne pareil sur ton Mac et sur le serveur.
- **Endpoint** : une adresse du service, par exemple `GET /audio/list`.
- **Latence** : le temps d'attente entre le clic et le son.
- **Chemin critique** : les étapes que le joueur attend vraiment.

```
Navigateur (jeu itch.io, iframe servie depuis https://html-classic.itch.zone)
   │ WebSocket du jeu (existe déjà)             │ HTTPS public, lecture seule :
   │ « créer un son », état (avec clipUrl)      │ GET <clipUrl>  (MP3, Range géré par le CDN)
   ▼                                            ▼
Backend Go ── HTTP, réseau privé du cluster ──► Service audio (Python, 1 pod) ── HTTPS gardé ouvert ──► Gradium TTS
   GET  /audio/list   (pioche)                      │
   GET  /audio/{id}   (objet audio)                 └── dépôt du MP3 (avant la réponse 201) ──► CDN (à choisir)
   POST /audio        (créer un son)
   (Go et le service tournent tous deux sur le cluster Kubernetes gcast)
```

Qui appelle quoi :
- **Le backend Go** est le seul à appeler `POST /audio`. Il connaît les joueurs, donc c'est lui qui limite chacun, et la clé Gradium ne sort jamais du serveur. Il reçoit des objets audio et met le `clipUrl` de chaque clip dans l'état de jeu envoyé aux joueurs (jamais `text`, `emotion` ni `voiceId`, README, « Protocol »).
- **Le navigateur** télécharge les MP3 directement sur le CDN, à l'adresse `clipUrl` reçue de Go, sans passer par Go ni par le service. Il n'appelle jamais le service : pour la liste ou un son, il passe par les `GET /audio/list` et `GET /audio/{id}` de Go, qui sert de proxy et ne renvoie que `{id, clipUrl}` (§3). Le cache du navigateur et celui du CDN gardent les fichiers.
  - L'ancien écart au README (« fetch them ») est **résolu** : le service ne sert plus de MP3, le CDN s'en charge, et le service reste privé (pas de domaine public, `POST` injoignable depuis Internet).
- **Gradium** n'est appelé que par le service audio. **Le CDN** ne reçoit de fichiers que du service audio.

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

**Le contrat fait foi dans `spec/`** : [`spec/audio-request.schema.json`](../spec/audio-request.schema.json) (`AudioRequest`, le corps de `POST /audio`), [`spec/audio-response.schema.json`](../spec/audio-response.schema.json) (`AudioResponse`, l'objet audio renvoyé) et [`spec/audio-service.openapi.json`](../spec/audio-service.openapi.json) (les endpoints). Cette section le résume et précise ce que le service fait en interne pour le respecter ; en cas d'écart, `spec/` gagne.

### L'objet audio : `AudioRequest` et `AudioResponse`

**`AudioRequest`** (corps de `POST /audio`), exactement ces deux champs (`additionalProperties: false`) :

| Champ | Type | Contenu |
|---|---|---|
| `text` | chaîne, 1 à 100 caractères | le texte à prononcer ; 25 conseillés pour tenir en 2 s au plus sans coupe (§4) |
| `emotion` | chaîne, 1 à 30 caractères | l'émotion demandée, **texte libre** (par exemple `joyful`, `eerie`, `angry`) |

**`AudioResponse`** (renvoyé par `POST /audio`, `GET /audio/{id}` et chaque élément de `GET /audio/list`, **pour les sons de la bibliothèque comme pour les sons créés**) : les champs de l'`AudioRequest` plus ceux fixés par le service, **exactement ces cinq champs, rien d'autre** (`additionalProperties: false`) :

| Champ | Type | Contenu |
|---|---|---|
| `id` | chaîne, UUID v4 | identifiant unique (règles ci-dessous) |
| `text` | chaîne, 1 à 100 caractères | le texte à partir duquel la voix a été générée, **le même que dans l'`AudioRequest`** |
| `emotion` | chaîne, 1 à 30 caractères | l'émotion, **la même que dans l'`AudioRequest`** |
| `voiceId` | chaîne, non vide | l'id de la **voix Gradium choisie par le service** pour ce clip (§4.1) |
| `clipUrl` | URL | adresse publique du MP3 sur le CDN (CDN à choisir), de la forme `<CDN_PUBLIC_URL>/audio/<id>.mp3` |

```json
{
  "id": "3f1c2b8e-9a4d-4e6f-8b21-5c7d9e0a1f34",
  "text": "Is anyone there?",
  "emotion": "eerie",
  "voiceId": "gradium-voice-id",
  "clipUrl": "https://cdn.example.com/audio/3f1c2b8e-9a4d-4e6f-8b21-5c7d9e0a1f34.mp3"
}
```

- `voiceId` est **obligatoire sur chaque objet, bibliothèque comprise** : il ne distingue donc jamais un son créé d'un son listé (voir « Indiscernabilité »).
- Le choix de la voix à partir de l'émotion reste une **décision interne** du service (§4.1) ; seul son résultat est exposé, dans `voiceId`.
- Ce qui n'est **plus** dans les réponses : `kind`, `duration_ms`, `tonality`, `spoken_text`, `truncated`, `cached`, `timings_ms`, `mp3_base64`. Le service peut toujours calculer et **journaliser** ces valeurs en interne (durée, coupe, texte réellement prononcé, doublon, temps de chaque étape), mais elles ne sortent pas dans l'API.

### Règles communes

- **Format d'erreur unique, à plat**, que Go décode dans une seule structure : `{"error": "<code>", "message": "<texte lisible>"}`. Codes HTTP du contrat : **400** (entrée invalide), **404** (id inconnu), **502** (génération impossible). La valeur de `error` précise le cas (liste au §3.3). On remplace le gestionnaire 422 par défaut de FastAPI (qui répondrait 422) pour renvoyer 400 dans ce format partout.
- **Pas d'authentification** : pas de jeton, pas d'en-tête `X-Service-Token`. Le service n'est joignable que **depuis l'intérieur du cluster** gcast (Service Kubernetes sans Ingress public, §8.4). C'est le réseau qui protège `POST /audio`.
- **Pas de CORS sur le service.** Le navigateur n'appelle jamais le service : **Go sert de proxy** pour les lectures. Il expose lui-même `GET /audio/list` et `GET /audio/{id}` au front, les transmet au service et ne renvoie que `{id, clipUrl}` par son (jamais `text`, `emotion` ni `voiceId`). Le service n'a donc ni `CORSMiddleware` ni `CORS_ORIGINS` ; le CORS vers le front est l'affaire de Go (`ALLOWED_ORIGINS`, README).
- **CORS des MP3 : l'affaire du CDN.** Un élément `<audio>` (choix du README) lit un MP3 d'un autre domaine sans CORS. Si le front passe un jour par `fetch()` ou la Web Audio API, le CDN devra envoyer `Access-Control-Allow-Origin` et exposer `Content-Range, Accept-Ranges, ETag, Content-Length`. Origines : `*` convient (pas de cookies, https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS), et c'est le plus sûr parce que le domaine des iframes itch.io a déjà changé (https://itch.io/t/3661515/cors-errors) ; sinon `https://html-classic.itch.zone`, `https://html.itch.zone`, `http://localhost:5173` et les sous-domaines `*.itch.zone`.
- Un `GET` sans en-tête personnalisé ne déclenche pas de *preflight*, la requête `OPTIONS` de vérification qui ajoute un aller-retour (même source MDN).
- **Ids : UUID version 4 pour tous les sons**, bibliothèque et sons créés, en minuscules, forme canonique de 36 caractères (`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`). Un UUID v4 est tiré au hasard (122 bits aléatoires, `uuid.uuid4()`), donc impossible à deviner et sans lien avec le texte, l'auteur ou la date.
  - **Jamais de v1 ni de v7** : ils contiennent l'heure de création, qui trahirait un son créé pendant la partie.
  - **Jamais de v3 ni de v5** (UUID calculés à partir d'un contenu) pour la bibliothèque : leur chiffre de version (3 ou 5) les distinguerait des sons créés (4).
  - Un id mal formé reçoit une 404 sans consulter le registre.
- **Indiscernabilité (exigence du coéquipier, reprise par le README)** : rien ne doit permettre de distinguer un son créé d'un son de la bibliothèque. Ce qui est garanti :
  - même forme d'id (UUID v4) ;
  - **les sons créés apparaissent dans `/audio/list`** dès leur création, avec exactement les mêmes champs (`id, text, emotion, voiceId, clipUrl`) ;
  - **`voiceId` présent partout**, bibliothèque comprise, et tiré des **mêmes voix Gradium** ;
  - même forme de `clipUrl` (`<CDN_PUBLIC_URL>/audio/<id>.mp3`), même CDN, mêmes métadonnées de dépôt (`Content-Type: audio/mpeg`, même `Cache-Control`) ;
  - liste **triée par id** : l'ordre est aléatoire et ne révèle pas l'ordre d'ajout ;
  - **mêmes réglages d'encodage** (soundfile, MP3 24 kHz mono VBR, mêmes versions figées dans `uv.lock`), aucune métadonnée ID3 ;
  - **en-têtes HTTP du CDN** : l'ancienne parade (`os.utime` à une date fixe) ne s'applique plus, puisque le service ne sert plus les fichiers. Le CDN risque d'envoyer un `Last-Modified` égal à la date de dépôt, qui trahirait un son déposé pendant la partie. **À régler selon le CDN choisi** (supprimer `Last-Modified` en sortie, ou déposer avec une date fixe si le CDN le permet ; question ouverte au §10) ;
  - les répliques de voix de la bibliothèque viennent des **mêmes voix Gradium** : une réplique parlée ne désigne pas forcément un son créé ;
  - Go ne transmet jamais au navigateur un champ du genre `generated`, ni `text`, `emotion` ou `voiceId` (README, « Protocol »).

### 3.1 `GET /audio/list` (contrat)

Appelé par Go au démarrage et à chaque partie. Réponse 200 `application/json` : un **tableau nu d'`AudioResponse`**, bibliothèque et sons créés mêlés :

```json
[
  {"id": "3f6c2a1e-8b4d-4c7a-9e21-5d0b7a6f1c93", "text": "Hahaha !", "emotion": "moqueur", "voiceId": "ZeSg853xFACESHHI",
   "clipUrl": "https://cdn.example.com/audio/3f6c2a1e-8b4d-4c7a-9e21-5d0b7a6f1c93.mp3"},
  {"id": "5d2b8f60-e1a7-4a3c-8c94-71f0b2d6e4a8", "text": "Is anyone there?", "emotion": "eerie", "voiceId": "POBHtemksfWQbng0",
   "clipUrl": "https://cdn.example.com/audio/5d2b8f60-e1a7-4a3c-8c94-71f0b2d6e4a8.mp3"}
]
```

- L'URL d'un clip est **`clipUrl`**, telle que renvoyée ; ni Go ni le front ne la reconstruisent.
- **Pas de titre ni de tags** : ils donneraient la réponse sans écouter. Ils restent dans `library/manifest.json`. (Pour les bruitages et ambiances de la bibliothèque, qui n'ont ni texte prononcé ni voix, le contenu de `text`, `emotion` et `voiceId` reste à décider : question ouverte au §10.)
- En-têtes (hors contrat, sans effet sur le corps) : `Cache-Control: no-cache` (le client revérifie à chaque fois, puisque la liste grandit avec les sons créés) et `ETag: "<hash de l'ensemble des ids>"` : un `If-None-Match` identique reçoit une 304, sans corps. Go peut s'en passer.
- Contenu : **la bibliothèque (clips `enabled && deal`) et tous les sons créés connus du registre**, mêmes champs, triés par id (§6.5).

### 3.2 `GET /audio/{id}` (contrat)

- **200** `application/json` : **l'`AudioResponse`** (pas le MP3). `Cache-Control: public, max-age=31536000, immutable` : un id ne change jamais de contenu.
- **404** `{"error": "not_found", "message": "…"}`, avec `Cache-Control: no-store`. Un id mal formé reçoit aussi une 404, sans consulter le registre.
- **Le MP3 lui-même est servi par le CDN** à `clipUrl`, pas par le service : plus de `HEAD`, de `FileResponse` ni de gestion de `Range` côté service. Le CDN doit accepter les requêtes `Range` (réponse 206) : Apple l'exige pour les médias sur iOS, et Safari macOS envoie d'abord une sonde `Range: bytes=0-1` (mesuré, `SCRATCH/wf/audio/web/range_log.jsonl`). **À vérifier sur le CDN choisi.** Le MP3 est déposé avec `Content-Type: audio/mpeg` et `Cache-Control: public, max-age=31536000, immutable` (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control).

### 3.3 `POST /audio` (contrat)

Appelé **par Go seulement**, par le réseau privé du cluster. **Synchrone** : le service répond une fois le MP3 **disponible sur le CDN** à `clipUrl`.

Requête :

```
POST /audio
Content-Type: application/json
X-Player-Id: p_42            (facultatif, hors contrat, pour les journaux)

{"text": "Où est passé mon sandwich ?", "emotion": "espiègle"}
```

Le corps est un `AudioRequest` (`spec/audio-request.schema.json`). Réponse **201** (un `AudioResponse`), avec l'en-tête `Location: /audio/c47e19b2-6a0d-4e5f-a813-9b2c7d04e6f1` :

```json
{
  "id": "c47e19b2-6a0d-4e5f-a813-9b2c7d04e6f1",
  "text": "Où est passé mon sandwich ?",
  "emotion": "espiègle",
  "voiceId": "FXxJ9mANRq6BCTX5",
  "clipUrl": "https://cdn.example.com/audio/c47e19b2-6a0d-4e5f-a813-9b2c7d04e6f1.mp3"
}
```

- `text` et `emotion` sont **les mêmes que dans l'`AudioRequest`** (`spec/audio-response.schema.json`). Si la fin du clip a été coupée pour tenir en 2 s (§4.3), `text` n'est pas raccourci : le texte réellement prononcé et la coupe sont **journalisés seulement** (les anciens `spoken_text` et `truncated` disparaissent).
- `voiceId` est la voix Gradium retenue pour ce clip (après repli éventuel sur `fallback_voice_id`, §7.4).
- **Doublon** : même texte nettoyé et même émotion normalisée qu'un clip déjà généré. On réutilise le son sous un **nouvel** UUID v4, déposé sur le CDN comme un nouveau fichier : zéro crédit et aucune collision d'id dans le vote. Le fait que ce soit un doublon est **journalisé seulement** (plus de champ `cached`).
- Les temps de chaque étape (`queue`, `provider_first_audio`, `provider_done`, `postprocess`, `cdn_upload`, `total`) sont **journalisés seulement** (plus de `timings_ms` dans la réponse). Pas d'en-tête `Server-Timing` : `POST /audio` n'est jamais appelé par le navigateur.
- **Plus de `?inline=true` ni de `mp3_base64`** : le créateur télécharge son clip sur le CDN comme les autres (coût : un `GET` de plus, environ 50 ms en bonne 4G **(estimation)**, §5.3).

Codes d'erreur (champ `error` de la réponse) :

| HTTP | `error` | Cas |
|---|---|---|
| 400 | `invalid_request` | JSON illisible, champ manquant ou de mauvais type, champ en trop, `emotion` vide ou de plus de 30 caractères |
| 400 | `text_empty` | aucune lettre après nettoyage |
| 400 | `text_too_long` | plus de `MAX_CHARS` (100) après nettoyage ; **refus prévu dans une version ultérieure** (le front limite déjà à 100) |
| 400 | `text_has_digits` | chiffres refusés : « écris les nombres en lettres » (Gradium développe « 2500000 » en « 2 million 500 thousand », ce qui ferait exploser les 2 s) |
| 400 | `text_rejected` | mot de la liste de blocage, dans `text` ou dans `emotion` |
| 404 | `not_found` | (`GET /audio/{id}`) id inconnu ou mal formé |
| 502 | `busy` | pas de place libérée dans le sémaphore en 2 s, ou budget du jour épuisé (ancien 429) |
| 502 | `provider_unavailable` | pas de clé, clé révoquée, crédits sous le plancher, ou `PROVIDER=off` (ancien 503) |
| 502 | `provider_timeout` | Gradium a dépassé `PROVIDER_TIMEOUT_S` (5 s) (ancien 504) |
| 502 | `provider_error` | Gradium a renvoyé une erreur, même après le repli de modèle |
| 502 | `cdn_upload_failed` | le dépôt du MP3 sur le CDN a échoué ou dépassé `CDN_TIMEOUT_S` (5 s) |

Le code générique du contrat pour un 502 est `generation_failed` ; les codes ci-dessus le précisent. Il n'y a plus d'`unknown_tonality` (l'émotion est libre, §4.1) ni de 401 (plus de jeton).

**Proposition à ajouter à `spec/`, si l'équipe le veut** : distinguer « réessaie plus tard » (**429** `busy` avec `Retry-After`, **503** `provider_unavailable`) et **504** `provider_timeout` au lieu de tout replier en 502. Tant que ce n'est pas dans `spec/`, le service n'utilise que 400, 404 et 502.

Côté Go : **délai d'au moins 30 s** (exigence du contrat). Le pire cas du service reste en dessous : attente du sémaphore (2 s) + `PROVIDER_TIMEOUT_S` (5 s) + post-traitement (< 10 ms) + dépôt CDN (`CDN_TIMEOUT_S`, 5 s) ≈ 12 s, ce qui laisse de la marge (on pourra allonger l'attente du sémaphore si la mesure le justifie) ; aucun réglage interne ne doit faire dépasser 30 s. Go accepte **201** (pas seulement 200), décode `{error, message}` et affiche un message par code (`text_too_long`, `text_has_digits`, `text_rejected`, `busy`, `provider_unavailable`). Les 502 peuvent être retentés (avec une pause pour `busy`) ; les 400 s'affichent au joueur. La génération se fait en tâche de fond côté jeu (README) : le joueur voit l'état « generating » de sa case.

### 3.4 `GET /audio/tonalities` : supprimé

Cet endpoint n'est **plus dans le contrat** : l'émotion est un texte libre, il n'y a plus de liste fermée à afficher. Le formulaire « Create a sound » du front a un champ texte (100 caractères au plus) et un champ émotion (30 au plus), envoyés à Go (README). Si l'équipe veut des suggestions d'émotions ou des répliques d'exemple à écouter, c'est à ajouter à `spec/` d'abord (question ouverte au §10).

### 3.5 `GET /healthz` (hors contrat, pour Kubernetes)

Les sondes Kubernetes (liveness et readiness) l'utilisent pour savoir si le service a démarré, et c'est la première chose à regarder en cas de problème. Il n'est pas dans `spec/` (à y ajouter si l'équipe veut le documenter).
- **200** dès que la bibliothèque est chargée, **503** sinon (code réservé aux sondes, pas à Go).
- **N'appelle jamais Gradium ni le CDN** : une panne de Gradium ne doit pas faire redémarrer le pod.
- Le service n'étant joignable que dans le cluster, la réponse détaillée est renvoyée à tous (plus de jeton). Go ne relaie pas `/healthz` au front.

```json
{"status": "ok", "version": "<commit>", "clips": 312, "generated": 57,
 "generation_available": true, "provider": "gradium", "provider_state": "ok", "model_in_use": "gradium-tts-beta",
 "credits_remaining": 987654, "last_total_ms": 309, "gradium_ip": "163.172.130.79", "tls_ms": 47}
```

`provider_state` vaut `ok`, `degraded`, `down` ou `out_of_credits`.

### 3.6 `GET /docs` et `/openapi.json` (automatique)

FastAPI les génère. **Le contrat de référence reste `spec/audio-service.openapi.json`** : un test compare les chemins, codes et schémas générés par FastAPI à ceux de `spec/` (§8.5), pour que le code ne dérive pas du contrat.

### 3.7 Consignes à coller dans le chat de l'équipe

**Pour Go :**

*Note (portée) : la première version du web app distribue les 6 clips depuis `GET /audio/list` et n'appelle pas encore `POST /audio` ; les sons créés (case « custom ») arrivent dans une itération suivante du web app. Le service construit quand même `POST /audio` dès J3a ; les consignes sur `POST` ci-dessous s'appliquent à cette itération.*

- adresse du service dans `AUDIO_SERVICE_URL` (URL interne du cluster, par exemple `http://audio-service:8080`, à confirmer ; en local, le service fictif du backend ou `http://localhost:8080`) ;
- `GET /audio/list` au démarrage et à chaque partie (avec `If-None-Match` si tu veux économiser le corps) ; chaque élément est un `AudioResponse` `{id, text, emotion, voiceId, clipUrl}` ;
- distribuer depuis cette liste moins les sons déjà utilisés du salon (README) ;
- **servir de proxy** au front pour `GET /audio/list` et `GET /audio/{id}` : transmettre au service et ne renvoyer que `{id, clipUrl}` par son (jamais `text`, `emotion` ni `voiceId`) ; le service n'a pas de CORS, c'est Go qui gère les origines du front ;
- `POST /audio` avec un `AudioRequest` `{"text": …, "emotion": …}`, **délai d'au moins 30 s**, **un seul client HTTP réutilisé**, pas de jeton ; réponse **201** avec un `AudioResponse`, à mettre dans la case « custom » du joueur ;
- erreurs au format `{"error": "<code>", "message": "…"}` : 400 = à afficher au joueur (message par code), 502 = génération impossible, à retenter (état « failed » avec « retry ») ;
- limiter chaque joueur (1 génération toutes les 5 s, 1 par manche proposé) ;
- envoyer aux joueurs **`clipId` (= `id`) et `clipUrl` seulement**, jamais `text`, `emotion` ni `voiceId` ; au vote, les clips **mélangés, envoyés d'un coup, jamais dans l'ordre des soumissions**, qui trahirait les auteurs ;
- remplacer par un clip de la bibliothèque toute carte dont `GET /audio/{id}` renvoie 404 ;
- ne jamais envoyer au navigateur d'information qui distingue un son créé (pas de champ `generated` ; `custom: true` seulement à son propriétaire, README) ;
- les sons créés sont dans `/audio/list` : ajouter l'id de chaque son créé aux sons utilisés du salon (README) ; si l'équipe ne veut pas qu'ils partent dans la pioche d'autres salons, **Go les écarte lui-même** avec les ids reçus en réponse à ses `POST` (voir §10).

**Pour le front :**
- **ne jamais appeler le service** : chaque clip de l'état envoyé par Go porte son `clipUrl` (CDN). Si le front a besoin de la liste ou d'un son, il passe par les `GET /audio/list` et `GET /audio/{id}` **de Go** (proxy), qui ne renvoient que `{id, clipUrl}` ;
- lire les clips avec un élément HTML `<audio>` sur `clipUrl` (README) ; le CDN gère `Range`, exigé par Safari ;
- au premier clic, mettre `navigator.audioSession.type = 'playback'` si la propriété existe (sinon l'interrupteur silencieux d'iOS coupe le son) ; toute lecture part d'un geste du joueur (README) ;
- précharger la main dès la distribution (`<audio preload="auto">` ou un `fetch` qui remplit le cache) ; au vote, précharger tous les clips en parallèle ;
- si vous passez à la Web Audio API : **un seul** `AudioContext` créé ou repris au premier clic, décoder un son minuscule au démarrage (le premier décodage d'une session Safari coûte 85 à 112 ms, mesuré), décoder chaque clip une fois et garder l'`AudioBuffer` par id ; il faut alors que le CDN envoie les en-têtes CORS (§3) ;
- `<link rel="preconnect" href="<domaine du CDN>" crossorigin>` vers le domaine du CDN, une fois celui-ci choisi ;
- formulaire « Create a sound » (itération suivante du web app, comme `POST`) : compteur de caractères, **25 conseillés, 100 au maximum** (`maxLength` du contrat, appliqué par le front dès maintenant), champ émotion libre de 30 caractères au plus ; bouton grisé si Go signale la génération indisponible ;
- un texte long peut être coupé à la fin pour tenir en 2 s : le conseil de 25 caractères sert à l'éviter ; ni le service ni Go ne signalent la coupe au joueur.

Sources : https://developer.chrome.com/blog/autoplay, https://developer.mozilla.org/docs/Web/API/AudioSession/type.

---

## 4. L'« émotion » et la limite de 2 secondes

### 4.1 De l'émotion (texte libre) à une voix Gradium : détail interne

Gradium n'a **aucun réglage d'émotion ni de style, et pas de SSML** (un langage de balises pour guider une voix). Il ne comprend que deux balises, `<flush>` et `<break time="…"/>`, et lit tout le reste à voix haute (`SCRATCH/gradium/guides_voices_voice-design.md`).

Le contrat reçoit une **émotion en texte libre** (`emotion`, 1 à 30 caractères, par exemple `joyful`, `eerie`, `angry`) et la renvoie telle quelle dans l'`AudioResponse`. Gradium ne sait pas quoi en faire directement : **le service la traduit en interne** en un préréglage (voix + réglages). Cette traduction **n'est pas dans le contrat** et peut changer sans prévenir Go ni le front ; **seul son résultat est exposé**, la voix retenue, dans le champ `voiceId` de l'`AudioResponse`. **Elle reste une question ouverte** (§10) ; ce qui suit est la proposition de départ.

Proposition : un **préréglage interne**, stocké dans `config/presets.json` (versionné ; les ids de voix ne sont pas secrets), et une table `config/emotions.json` qui associe des émotions courantes, en FR et en EN, à un préréglage (`"joyeux"`, `"joyful"`, `"happy"` → `solene-fr`/`zoey-en`…). L'émotion reçue est mise en minuscules et sans accents ; si elle n'est pas dans la table, on prend le préréglage par défaut (jamais d'erreur : l'émotion est libre). Le mot d'émotion n'est **jamais envoyé à Gradium** dans le texte, sinon il serait lu à voix haute.

```json
{"id": "noemie-fr", "label": "Espiègle", "language": "fr",
 "voice_id": "FXxJ9mANRq6BCTX5", "fallback_voice_id": "YhIHaAfQ0cQPDV9R",
 "temp": 0.7, "padding_bonus": 0.0, "enabled": true}
```

- `temp` : variabilité de la voix, de 0,0 à 1,4, 0,7 par défaut.
- `padding_bonus` : débit, de −4 à 4 ; **négatif = plus rapide**. C'est le seul réglage de vitesse (`SCRATCH/gradium/guides_voice-settings.md`).
- On **n'envoie pas** `cfg_coef` : le modèle bêta l'ignore (`SCRATCH/gradium/guides_release-notes_2026-09.md`).
- `fallback_voice_id` : une voix du catalogue utilisée si une voix créée disparaît.

**Première liste de préréglages internes** (voix « flagship » fournies par Gradium ; ids tirés de `SCRATCH/gradium/guides_voices_flagship-voices.md`, à revérifier avec `GET https://api.gradium.ai/api/voices/?include_catalog=true`) :

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

**Langue** : la langue du texte doit suivre celle de la voix : les règles de réécriture du texte suivent la langue de la voix (`guides_voice-settings.md`), et un texte français lu par une voix anglaise sonne faux. Le contrat n'ayant ni langue ni liste de voix, le service doit **deviner la langue du texte** (proposition : mots outils et accents, sans bibliothèque lourde) pour choisir la variante FR ou EN du préréglage. Question ouverte au §10. (L'ancien sélecteur FR/EN avec un bouton ▶ par tonalité côté joueur disparaît avec `GET /audio/tonalities`.)

### 4.2 Combien de caractères tiennent en 2 s

- Gradium donne environ 750 caractères par minute, soit **12,5 caractères/s**, donc **25 caractères en 2,0 s** (https://docs.gradium.ai/guides/credits.md ; calcul).
- Avec 0,2 à 0,3 s de silence au début et à la fin, il en reste 21 à 22 (calcul).
- Le débit du français n'est pas documenté : **à mesurer** (§9).
- **Le contrat accepte jusqu'à 100 caractères** (`maxLength` de `text`), soit environ 8 s de parole au débit normal (calcul). Au-delà de 25 à 30 caractères, la tenue en 2 s repose sur l'accélération (`padding_bonus`) **et surtout sur la coupe au dernier mot** (§4.3) : l'accélération plafonne vite (−4 au plus), donc un texte long sera presque toujours coupé (la coupe est journalisée ; `text` dans la réponse reste celui de la requête).
- Un dépôt de Gradium affirme que `padding_bonus` à ±2 change la durée d'environ ±30 % (`SCRATCH/wf/gradium-extra/gh-skills/…/SKILL.md`, **non vérifié**).

### 4.3 Garantir 2 s au plus, en trois couches

1. **Front** : compteur, conseil à 25 caractères, blocage à 100 (`maxLength` du contrat, déjà appliqué par le front). Ces valeurs sont des constantes du front (plus de `GET /audio/tonalities` pour les lire).
2. **Serveur, avant Gradium** :
   - nettoyage : normalisation Unicode NFC, **remplacement des apostrophes et guillemets typographiques** (`’ ‘ ʼ` → `'`, `« » “ ”` → `"`, `– —` → `-` ; iOS et macOS tapent `’` par défaut, sinon « l’eau » deviendrait « leau »), **refus des chiffres** (400 `text_has_digits`), suppression des caractères de contrôle, **suppression de `<` et `>`** (sinon un joueur glisse `<break time="2.0s"/>` et ajoute 2 s de silence), on ne garde que les lettres, les chiffres, les espaces et `. , ! ? ' - … : ;`, espaces multiples réduits, au moins une lettre ;
   - refus au-delà de 100 caractères (`MAX_CHARS=100`, limite du contrat) **prévu dans une version ultérieure** de `POST /audio` ; en attendant, le front et Go limitent. L'émotion (1 à 30 caractères) passe par le même nettoyage, sans être envoyée à Gradium ;
   - débit selon la longueur, `padding_bonus = préréglage + ajustement`, borné à [−4, 4]. Valeurs de départ **(estimation, à calibrer)** :

     | Longueur | Ajustement |
     |---|---|
     | ≤ 25 caractères | 0 |
     | 26 à 32 | −1 |
     | 33 à 40 | −2 |
     | 41 à 50 | −3 |
     | 51 à 100 | −4 (plafond de Gradium) ; au-delà de ~50 caractères, **c'est la coupe au dernier mot qui garantit les 2 s**, pas le débit |

3. **Après génération** (numpy, environ 0,1 ms, mesuré) :
   - retrait du silence au début et à la fin : seuil −45 dB, fenêtres de 10 ms, 20 ms de marge ;
   - si la parole dépasse encore 2,0 s, **coupe à la fin du dernier mot terminé avant 1,97 s**. On lit la fin des mots dans les messages `text` de Gradium (`start_s`/`stop_s`, `SCRATCH/gradium/guides_text-to-speech.md`), moins le silence retiré au début ;
   - sans horodatage, ou si un seul mot dépasse : coupe au passage de 10 ms le plus silencieux entre 1,6 et 2,0 s ;
   - fondu de sortie de 30 ms (le volume descend jusqu'à zéro, ce qui évite un « clic ») ;
   - plafond absolu à 2,000 s ; la coupe et le texte réellement prononcé sont journalisés (le champ `text` de la réponse reste celui de l'`AudioRequest`, contrat).

   Un test vérifie la durée **après décodage du MP3**.

### 4.4 Même volume que la bibliothèque

- Le volume est réglé sur le **RMS** (niveau moyen du signal), avec un plafond de crête à −1 dBFS.
- La cible RMS est calibrée une fois, hors ligne, pour sonner comme la bibliothèque à −16 LUFS. Le LUFS mesure le volume perçu. La norme AES TD1008 recommande −16 LUFS pour la musique, −18 pour la parole et −1 dBTP de crête (https://aes.org/wp-content/uploads/2024/01/20210924_TD1008_v3.13.pdf).
- On n'utilise pas pyloudnorm en direct, sinon scipy entrerait dans l'image.

---

## 5. Une génération en direct, étape par étape

### 5.1 Au démarrage (hors chemin critique)

1. Charger `library/manifest.json`, `config/presets.json` et `config/emotions.json`, vérifier que chaque fichier existe, **vérifier que chaque clip de la bibliothèque est présent sur le CDN** (dépôt des manquants, idempotent, §6.5) et recharger le registre des sons créés (§7.1). Encoder une fois 100 ms de silence pour payer l'import de soundfile (15 ms) et de numpy (38 ms), mesurés.
2. Créer un `httpx.AsyncClient` avec `limits=httpx.Limits(max_connections=8, max_keepalive_connections=4, keepalive_expiry=120)`. **Attention** : httpx ferme par défaut une connexion inactive après 5 s. Sans ce réglage, la connexion gardée ouverte ne sert à rien.
3. **Pré-ouvrir 4 connexions** (autant que `MAX_CONCURRENCY`) en lançant 4 `GET https://api.gradium.ai/api/usages/credits` en parallèle (schéma `CreditsSummary`, `SCRATCH/wf/gradium-extra/openapi.json`). Sinon, chaque génération simultanée au-delà de la première paierait TCP+TLS, environ 45 ms mesurés depuis le lieu du hackathon. On note l'IP résolue et le temps TLS dans `/healthz`. Même principe pour le client du CDN : un client réutilisé, connexion ouverte au démarrage.
4. **Requête de chauffe** : générer « Ok. » (3 crédits). Elle vérifie la clé, le modèle et le format, et remplit `last_total_ms`. Si Gradium est injoignable, le service **démarre quand même** (`provider_state: down`) et réessaie en fond.
5. **Tâche de fond** : un appel léger toutes les 25 à 30 s sur une connexion inactive à la fois (comme le `POOL_TTL` de 25 s de la démo `tts-latency-race`), et lecture des crédits une fois par minute. Le délai d'inactivité et les limites de débit de Gradium ne sont pas documentés : à demander au stand.

### 5.2 Chemin critique d'un `POST /audio`

1. Go reçoit l'action sur la WebSocket du jeu, déjà ouverte, et fait `POST /audio` (`{"text", "emotion"}`) sur le réseau privé du cluster.
2. Nettoyage, longueur, liste de blocage, budget du jour, choix du préréglage à partir de l'émotion (§4.1) : moins de 1 ms **(estimation)**.
3. **Cache des doublons** : `clé = sha256(texte_normalisé | émotion_normalisée | préréglage | modèle | version_du_traitement)`. Si la clé existe, on dépose une copie du MP3 (environ 11 Ko) sur le CDN sous un nouvel UUID v4 (copie côté CDN si possible), on l'ajoute à la liste et on répond 201 ; le doublon n'est que journalisé. Temps : celui d'un dépôt CDN **(estimation)**.
4. Place dans le sémaphore (un compteur qui limite les générations simultanées) : `MAX_CONCURRENCY=4`. Si aucune place ne se libère en 2 s : 502 `busy`.
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
8. **Dépôt du MP3 sur le CDN** à `audio/<uuid>.mp3`, avec `Content-Type: audio/mpeg` et `Cache-Control: public, max-age=31536000, immutable`, délai `CDN_TIMEOUT_S` (5 s) ; en cas d'échec, 502 `cdn_upload_failed` et rien n'est ajouté à la liste. Puis enregistrement de l'`AudioResponse` `{id, text, emotion, voiceId, clipUrl}` dans le registre persistant (§7.1), **ajout à la liste** (le hash de l'`ETag` change), enregistrement dans le cache des doublons, **réponse 201 avec l'`AudioResponse`**. Le service ne répond qu'une fois le fichier disponible à `clipUrl` (exigence du contrat).
9. Après la réponse : une ligne de journal JSON (`id, emotion, preset, chars, model, cached, truncated, duration_ms, timings`), **sans le texte**.

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
| Service → Gradium, ½ aller-retour | ~7 ms si le cluster gcast et Gradium sont proches (Paris) | ½ des 13,85 ms Paris↔Amsterdam (https://wondernetwork.com/pings/Paris/Amsterdam), ordre de grandeur. Depuis le lieu du hackathon, `api.gradium.ai` résout vers Scaleway Paris (mesuré), mais **la région du cluster gcast n'est pas connue et Gradium peut router ailleurs depuis là** : à lire dans `/healthz` |
| Gradium, premier son (bêta) | < 50 ms mesuré par Gradium **en WebSocket avec le setup envoyé à l'avance** (225 ms pour `default`) ; **en REST, inconnu** (la mise en place de la session est payée à chaque requête) | chiffre de Gradium, qui « varies with network conditions and input » (`guides_release-notes_2026-09.md`) ; **à mesurer en J2** |
| **Gradium, reste du clip (~2 s de voix)** | **inconnu ; provision de 100 à 400 ms** | **estimation non sourcée : c'est l'inconnue n° 1**, rien n'est publié |
| Gradium → service, ½ aller-retour | ~7 ms | **estimation** |
| Post-traitement + MP3 | 2,6 à 3,2 ms sur M3 Pro ; ≤ 10 ms sur un vCPU cloud | mesuré (`out_bench.txt`) ; facteur cloud ×2-3 **(estimation)** |
| **Dépôt du MP3 sur le CDN** (~11 Ko) | **inconnu ; provision de 20 à 150 ms** | **estimation**, dépend du CDN choisi ; **à mesurer** |
| Service → Go → navigateur (objet JSON, puis état de jeu) | 20 à 50 ms | **estimation** |
| `GET` du MP3 sur le CDN (`clipUrl`) | ~50 ms en bonne 4G ; plus si le CDN va chercher le fichier à l'origine au premier accès | modèle de livraison (`SCRATCH/wf/audio`), **estimation** |
| Démarrage de la lecture (`<audio>`, ou `decodeAudioData` à chaud avec la Web Audio API) | 1 à 5 ms pour `decodeAudioData` ; `<audio>` non mesuré | mesuré (Chromium 152, Safari 27) |

- **Total hors génération Gradium : environ 120 à 325 ms (estimation), dont le dépôt CDN et le `GET` du MP3 qui remplacent l'ancien `inline`. Total : environ 0,3 à 0,9 s (estimation).**
- **Objectifs** : médiane du temps `total` journalisé par le service (dépôt CDN compris) ≤ 400 ms, et médiane client ≤ 800 ms. À confirmer par la mesure. La génération se fait de toute façon en tâche de fond côté jeu (README) : elle ne bloque pas la manche.
- Le contrat demande à Go un délai d'au moins 30 s : ce n'est pas un objectif de latence, seulement une borne pour les pires cas (sémaphore plein, Gradium lent, CDN lent).
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
| Génération spéculative | clip complet > ~400 ms | Go envoie `POST /audio` avec `"speculative": true` quand le joueur arrête de taper ~700 ms. Le clic final tombe dans le cache des doublons. Environ 25 à 40 crédits par brouillon **(estimation)**. **Demande d'abord un changement de `spec/`** : le corps de `POST /audio` n'accepte pas d'autre champ que `text` et `emotion`, et un brouillon ne doit pas apparaître dans `/audio/list`. |
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
  - 10 à 15 % de répliques de 1 à 5 mots, rendues avec les voix des préréglages internes (§4.1) ;
  - 10 % de jingles ;
  - 5 à 10 % de sons abstraits.

  On choisit des sons qui évoquent une situation ou une émotion. On évite les sons de marque et les voix de personnes réelles.
- **Répliques Gradium** : 40 à 80 lignes × 3 prises ≈ 6 000 crédits, soit 0,6 % du million **(estimation)**. Tester d'abord 10 onomatopées (« Hahaha ! », « Pfff… ») : aucune balise de rire n'est documentée.

### 6.3 Script de fabrication (hors ligne, sur ton Mac ; résultat committé)

`tools/build_library.py`, à partir de `SCRATCH/wf/library/poc_build.py`, qui fait déjà les étapes 3 à 6 en environ 38 ms par clip (une entrée de 2000 ms ressort à 2000 ms au décodage, mesuré). Il lit `tools/sources.yaml` (fournisseur, id ou prompt, kind, catégorie, tags, licence, décalage de départ, et les `text` et `emotion` exposés par le contrat), puis :

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

On y ajoute deux champs pour le contrat : `text` (1 à 100 caractères) et `emotion` (1 à 30 caractères) ; `voiceId` vient de `generator.voice_id`.

Le service ne lit que `id, file, text, emotion, voice_id, deal, enabled` ; il construit `clipUrl` à partir de `CDN_PUBLIC_URL` et de l'id.
- `/audio/list` renvoie les clips `enabled && deal`, **plus les sons créés** (§6.5), sous forme d'`AudioResponse` `{id, text, emotion, voiceId, clipUrl}`.
- Pour une réplique parlée, `text` est le texte prononcé, `emotion` celle qu'on a demandée et `voiceId` la voix Gradium utilisée. **Pour un bruitage, une ambiance ou un jingle (sans paroles ni voix Gradium), le contenu de `text`, `emotion` et `voiceId` reste à décider** (le schéma les exige tous, `voiceId` compris, et il ne doit pas trahir un son créé ; ils ne doivent pas donner la réponse ; Go ne les envoie pas aux joueurs, README). Question ouverte au §10.
- Les anciennes répliques d'exemple des tonalités n'ont plus d'usage dans le contrat ; si on les garde, `deal: false` : absentes de `/audio/list`, jamais distribuées.

### 6.5 Service et clips générés

- `library/` est **copiée dans l'image**. Le service ne sert pas les MP3 : **au démarrage, il dépose sur le CDN les clips de la bibliothèque qui n'y sont pas encore** (idempotent : liste ou `HEAD` du CDN, puis dépôt des manquants à `audio/<id>.mp3`, avec les mêmes métadonnées que les sons créés). Alternative : `build_library.py --upload` lancé à la main. À trancher avec le choix du CDN.
- **Les sons créés rejoignent `/audio/list` dès leur création** (exigence du coéquipier) : sinon, un joueur qui compare l'id d'un candidat à la liste saurait qu'il a été créé pendant la partie.
- Conséquence : ils peuvent être distribués aux autres joueurs. Le service ne les marque pas (ce serait un indice) ; si l'équipe ne le veut pas, Go les écarte avec les ids reçus en réponse à ses `POST`. Leur texte n'étant relu par personne, la liste de mots bloqués compte davantage.
- `library/manifest.json` ne doit **pas** être servi par le service ni publié ailleurs que dans le repo : il contient titres et tags.
- **Limite connue (active)** : Go sert `/audio/list` au front par son proxy, avec les ids. Un joueur qui relit cette liste avant et après la création d'un son voit donc apparaître un nouvel id, et sait qu'il s'agit d'un son créé. Risque faible en hackathon, mais **à traiter avec l'itération des sons créés** (pistes pour Go : ne pas exposer la liste complète, ou n'y ajouter les sons créés qu'en fin de partie). À signaler à l'équipe.

---

## 7. Stockage, cache, sécurité, replis

### 7.1 Stockage

- **Bibliothèque** : dans l'image, en lecture seule, et **copiée sur le CDN** au démarrage (§6.5).
- **MP3 des clips générés** : **sur le CDN** seulement, à `audio/<uuid>.mp3` (même chemin et mêmes métadonnées que la bibliothèque). L'id est un UUID v4 (§3). Le service ne sert aucun MP3 : `Range`/206 et les en-têtes de cache sont l'affaire du CDN. Un fichier temporaire local (`/tmp`) ne sert qu'au dépôt.
- **Registre** : un simple `dict id → AudioResponse {id, text, emotion, voiceId, clipUrl}` pour la bibliothèque et les sons créés, reconstruit au démarrage à partir du manifeste et des objets des sons créés.
- **Où garder les objets des sons créés** (`text`, `emotion`) : proposition, un `<uuid>.json` déposé à côté du MP3 **sous un préfixe non public** du même stockage que le CDN (ou un volume persistant Kubernetes). Sinon, après un redémarrage du pod, le MP3 existe encore à `clipUrl` mais `GET /audio/{id}` répond 404 et le son disparaît de `/audio/list`. Question ouverte au §10.
- **Redéploiement** : avec le registre persistant ci-dessus, rien n'est perdu. Sans lui, les sons créés disparaissent de la liste (404) et Go remplace la carte. L'état de jeu de Go est lui aussi en mémoire, d'après le README. **Pas de redéploiement pendant la démo.**
- **Pas de nettoyage automatique** : 11 Ko par clip.

### 7.2 Cache HTTP

| Ressource | Cache-Control |
|---|---|
| `/audio/{id}` (objet JSON) | `immutable`, un an ; 404 en `no-store` |
| `/audio/list` | `no-cache`, avec ETag (304 si rien n'a changé) |
| MP3 sur le CDN (`clipUrl`) | `public, max-age=31536000, immutable`, fixé au dépôt |

Pas de gzip sur les MP3, qui sont déjà compressés (à vérifier dans le réglage du CDN).

### 7.3 Sécurité

- **Clé Gradium** :
  - seulement en variable d'environnement, injectée depuis un **Secret Kubernetes** du cluster gcast (idem pour les identifiants de dépôt sur le CDN) ;
  - en local, dans `secret/gradium.env`, puisque le `.gitignore` actuel ne contient que `secret` ;
  - proposer à l'équipe d'ajouter `.env` et `*.env`, et committer un `.env.example` vide ;
  - la protection de GitHub contre les secrets poussés ne reconnaît peut-être pas le format Gradium (https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection) ; or une clé poussée = disqualification. Vérification avant le gel, en cherchant **la valeur exacte de la clé** dans tout l'historique sans l'afficher : `git grep -lF "$(cut -d= -f2 ../secret/gradium.env)" $(git rev-list --all) && echo FUITE || echo ok`, plus un passage de gitleaks (binaire téléchargeable) avant de rendre le dépôt public. **Si une fuite est trouvée, révoquer la clé** : réécrire l'historique ne suffit pas ;
  - **aucune clé du compte Google du sponsor** dans ce service.
- **Pas de jeton** : `POST /audio` n'est protégé que par le réseau. Le service n'a pas de domaine public, seulement un Service Kubernetes interne au cluster. Proposition : une `NetworkPolicy` qui n'autorise que les pods du backend Go à joindre le port du service. Le service n'est jamais exposé hors du cluster : Go relaie les `GET` au front (proxy).
- **Garde-fous de crédits, dans le service** :
  - `MAX_CHARS=100` (limite du contrat ; refus côté service prévu dans une version ultérieure) ;
  - `MAX_CONCURRENCY=4` (la limite de sessions simultanées de ton offre n'est pas publiée, `guides_limits.md`) ;
  - `DAILY_CHAR_BUDGET=50000`, soit environ 500 à 2 000 clips par jour selon la longueur **(estimation)**, 502 `busy` au-delà ;
  - `CREDIT_FLOOR=20000` : en dessous, 502 `provider_unavailable`, ce qui garde une réserve pour le pitch.
  - Un clip coûte 1 crédit par caractère, soit 25 à 100 crédits (la partie coupée est payée quand même) ; 1 M de crédits ≈ 10 000 à 40 000 clips (https://docs.gradium.ai/guides/credits.md, calcul).
- **Dans Go** : 1 génération par joueur toutes les 5 s et 1 par manche (proposé), plus une limite par connexion.
- **Modération** : `config/blocklist.txt`, quelques dizaines de mots FR/EN, comparés sur le texte et l'émotion en minuscules sans accents ; 400 `text_rejected`. Pas de LLM.
- **Pas de clonage de voix en direct** (les voix sont des préréglages), ce qui respecte la règle de Gradium contre l'usurpation. **Mention « Voices generated with Gradium AI »** dans les crédits et sur la page itch.io, parce que les conditions demandent d'informer qu'on entend de l'IA (https://gradium.ai/terms-of-service).

### 7.4 Replis (la bibliothèque reste toujours jouable)

`PROVIDER` vaut `gradium` (production), `fake` (développement et tests seulement, jamais pour le jury) ou `off` (génération coupée proprement).

| Panne | Réaction |
|---|---|
| Échec de connexion **avant** l'envoi du texte | Une seule nouvelle tentative. Jamais après l'envoi, pour ne pas payer deux fois. |
| Erreur du modèle bêta | Une tentative avec `GRADIUM_FALLBACK_MODEL=default` (225 ms au premier son). **Après 3 échecs de suite de la bêta, `default` pendant 30 min.** On journalise `model`. La bêta est publique depuis le 22/09 et peut changer pendant que le jury joue. |
| Voix introuvable | Nouvel essai avec `fallback_voice_id` |
| Réponse contenant `revoked`, `expired`, `credit`, un code 1008, ou HTTP 402 | `provider_state=out_of_credits` : chaque POST répond tout de suite 502 `provider_unavailable`, jusqu'à ce que la lecture des crédits redevienne bonne et dépasse le plancher |
| Plus de 5 s | 502 `provider_timeout` |
| Dépôt sur le CDN en échec ou plus de 5 s | Une seule nouvelle tentative (le dépôt est idempotent), puis 502 `cdn_upload_failed` ; rien n'est ajouté à la liste |
| Gradium injoignable au démarrage | Le service démarre, `generation_available: false` dans `/healthz`, reconnexion en fond ; chaque `POST` répond 502 `provider_unavailable` |
| CDN injoignable au démarrage | Le service démarre quand même (les objets de la liste restent valides si les MP3 y sont déjà), réessaie en fond le dépôt des clips manquants |
| Après le hackathon | Rien ne dépend du compte Google temporaire. Si la clé ou les crédits disparaissent, `POST /audio` répond 502 et Go grise « Créer un son ». |

---

## 8. Code, Docker, développement, déploiement, tests, documentation

### 8.1 Arborescence (`./audio-service/` dans le monorepo)

```
audio-service/
  pyproject.toml  uv.lock  .python-version  Dockerfile  .dockerignore
  k8s/deployment.yaml  k8s/service.yaml  k8s/networkpolicy.yaml   # railway.json et fly.toml abandonnés (§8.4)
  .env.example  README.md
  config/presets.json  config/emotions.json  config/blocklist.txt
  library/manifest.json  library/CREDITS.md  library/clips/*.mp3
  src/audio_service/
    main.py        # app FastAPI, démarrage/arrêt, format d'erreur, routes, run() lit HOST/PORT
    settings.py    # variables d'environnement
    store.py       # registre bibliothèque + générés (AudioResponse), ids, persistance, cache des doublons
    cdn.py         # dépôt des MP3 (et des objets des sons créés) : backend `local` (dev) et backend du CDN choisi
    emotion.py     # émotion libre -> préréglage interne (voix, temp), padding_bonus selon la longueur
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
    test_api.py  test_contract.py  test_indiscernable.py  test_audio.py  test_gradium.py  test_library.py
```

Environ 500 lignes de code pour le service **(estimation)**.

Dépendances :
- **exécution** : `fastapi`, `uvicorn[standard]`, `httpx`, `numpy`, `soundfile>=0.13`, `lameenc` ;
- **groupe `dev`** : `pytest`, `pytest-asyncio`, `websockets` (le faux serveur l'importe) ;
- **groupe `tools`** : `pyloudnorm`, `imageio-ffmpeg`, `pyyaml`.

Dans `pyproject.toml` : `[project.scripts] audio-service = "audio_service.main:run"` **et** une section `[build-system]` (`uv_build`, déjà dans le prototype `SCRATCH/wf/hosting/proto/audio-service/pyproject.toml`) : sans elle, le script `audio-service` n'est pas installé et le `CMD` du Dockerfile échoue.

**Pièges FastAPI** : déclarer `/audio/list` **avant** `/audio/{id}` (sinon « list » est pris pour un id) ; `If-None-Match`/304 se code à la main pour `/audio/list` ; enregistrer des gestionnaires pour `StarletteHTTPException` et `RequestValidationError` qui renvoient `{"error": "<code>", "message": "…"}` (à plat), avec **400** au lieu du 422 par défaut ; modèle Pydantic de la requête avec `extra="forbid"` (le contrat refuse les champs en trop) ; `status_code=201` sur la route `POST`.

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
- **Pas de cache BuildKit** : c'était une contrainte de Railway (https://docs.railway.com/builds/dockerfiles.md), abandonné ; on peut le réactiver si la CI qui construit l'image pour gcast le permet.
- `CMD` en forme exec : Python reçoit directement le signal d'arrêt (doc FastAPI).
- `HOST=""` écoute en IPv4 **et** IPv6 ; `"::"` seul n'accepterait que l'IPv6 (vérifié sur Python 3.12.14).
- `run()` lance uvicorn avec `workers=1` et `timeout_graceful_shutdown=8`. Une requête en cours finit bien après SIGTERM (mesuré, `SCRATCH/wf/hosting`).

### 8.3 Développement local sur ton Mac (sans Docker, sans ffmpeg, Python 3.9 système intact)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env          # ou ouvrir un nouveau terminal ; puis uv --version
uv python install 3.12
cd audio-service && uv sync
(mkdir -p /tmp/cdn && cd /tmp/cdn && python3 -m http.server 8081) &   # faux CDN local
PROVIDER=fake CDN=local LOCAL_CDN_DIR=/tmp/cdn CDN_PUBLIC_URL=http://localhost:8081 uv run audio-service   # http://localhost:8080/docs
uv run pytest
# avec la vraie clé (fichier dans secret/, ignoré par git) :
set -a; source ../secret/gradium.env; set +a; PROVIDER=gradium uv run audio-service
# client réel contre le faux Gradium :
uv run python tests/mock_gradium.py &  PROVIDER=gradium GRADIUM_BASE_URL=http://127.0.0.1:18766/api uv run audio-service
```

- **Coéquipiers** : côté Go, `AUDIO_SERVICE_URL=http://localhost:8080` avec `PROVIDER=fake` et `CDN=local` (latence réglable avec `FAKE_LATENCY_MS=250`). Ni clé, ni crédit, ni jeton. Le backend a aussi son propre service audio fictif (liste figée conforme au schéma et quelques MP3, README) : le vrai service n'est nécessaire que pour tester la génération.
- **On ne construit pas l'image sur le Mac pour la production** : le Mac est en arm64, le cluster probablement en amd64 (à confirmer). L'image est construite par la CI et poussée dans le registre utilisé par gcast (à décider, comme pour Go).
- Pour un test de conteneur local, si besoin : Docker Desktop, gratuit pour les étudiants (https://docs.docker.com/subscription/desktop-license/).

### 8.4 Déploiement : cluster Kubernetes gcast, à côté du backend Go

Le backend Go tourne sur le cluster Kubernetes gcast (README, « Deployment ») ; le service audio tourne **sur le même cluster**, ce qui garde un réseau privé entre Go et le service et évite tout jeton.

- **Deployment `audio-service`** avec exactement **1 réplica** : la liste des clips et le cache des doublons sont en mémoire, et uvicorn tourne avec un seul worker (§2). Même raisonnement que pour Go.
- **Service Kubernetes** (ClusterIP) `audio-service`, port 8080, **sans Ingress public**. Go l'appelle par `AUDIO_SERVICE_URL=http://audio-service:8080` (nom exact et namespace à confirmer) et sert lui-même de proxy au front pour les `GET` : le service n'est jamais exposé hors du cluster.
- **NetworkPolicy** (proposée) : seuls les pods du backend Go joignent le port 8080. **Sortie réseau** autorisée vers `api.gradium.ai:443` et vers le CDN ; à vérifier dès J1 depuis le pod.
- **Sondes** : readiness et liveness sur `GET /healthz` (qui n'appelle ni Gradium ni le CDN) ; `terminationGracePeriodSeconds` ≥ 10, pour laisser finir une génération en cours (`timeout_graceful_shutdown=8`, §8.2).
- **Secret Kubernetes** : `GRADIUM_API_KEY` et les identifiants de dépôt sur le CDN.
- **Variables** : `PORT=8080`, `PROVIDER=gradium`, `GRADIUM_BASE_URL=https://api.gradium.ai/api`, `GRADIUM_MODEL=gradium-tts-beta`, `GRADIUM_FALLBACK_MODEL=default`, `MAX_CHARS=100`, `MAX_CONCURRENCY=4`, `DAILY_CHAR_BUDGET=50000`, `CREDIT_FLOOR=20000`, `PROVIDER_TIMEOUT_S=5`, `CDN` (backend de dépôt), `CDN_PUBLIC_URL` (base de `clipUrl`), `CDN_TIMEOUT_S=5`. Plus de `SERVICE_TOKEN` ni de `CORS_ORIGINS`.
- **Manifests** dans `audio-service/k8s/` (ou à côté de ceux de Go, `./webapp/backend/k8s`, au choix de l'équipe). Image construite par la CI ; registre, nom d'image et namespace **à décider** (les mêmes « TBD » que pour Go).
- **Région** : celle du cluster gcast, **inconnue à ce jour**. Si Gradium répond depuis Paris et que le cluster est loin, chaque clip paie la distance. On lit `gradium_ip` et `tls_ms` dans `/healthz` dès J1.
- **Version jury figée** : tag `v1.0` et déploiement automatique coupé après la remise.

**Brouillons abandonnés (gardés pour mémoire).** Avant le choix du cluster gcast, le plan prévoyait Railway en EU West (Amsterdam), dans le même projet que Go : Root Directory `/audio-service`, `railway.json` en chemin absolu (builder `DOCKERFILE`, `healthcheckPath /healthz`, `drainingSeconds 10`, `overlapSeconds 5`), mise en veille désactivée, réseau privé `RAILWAY_PRIVATE_DOMAIN` pour Go et domaine public HTTPS pour le front, plan Hobby à 5 $/mois **(estimation)** ; avec un plan B Fly.io `cdg` (Paris) pour les deux services (`auto_stop_machines="off"`, environ 3,6 $/mois par machine de 512 Mo, calcul d'après https://docs.fly.io/about/pricing.md). Le raisonnement qui reste valable : **mettre le service au plus près de Go** (déplacer seulement le service audio ne gagne rien, le trajet Go → audio s'allonge d'autant), **pas de mise en veille**, et **mesurer la distance à Gradium** depuis l'hébergement réel. Les fichiers `railway.json` et `fly.toml` de `SCRATCH/wf/hosting/proto/` ne sont plus utilisés.

### 8.5 Tests (toujours `fake` ou `mock_gradium.py`, zéro crédit)

- **`test_api.py`** : `list` renvoie un tableau d'`AudioResponse` (et 304 sur `If-None-Match`) ; `GET /audio/{id}` renvoie l'`AudioResponse` en JSON, ou 404 `{"error": "not_found", …}` ; `POST` renvoie 201 avec un `AudioResponse` dont le `clipUrl` répond (faux CDN local), puis `GET` renvoie le même objet ; champ en trop ou manquant = 400 (jamais 422) ; doublon = nouvel id (le doublon n'apparaît que dans le journal) ; 400 / 502 avec les codes du §3.3, au format à plat ; échec du dépôt CDN = 502 `cdn_upload_failed` et rien dans la liste.
- **`test_contract.py`** : chaque réponse est validée contre `spec/audio-response.schema.json`, chaque corps de requête accepté contre `spec/audio-request.schema.json`, et les chemins, méthodes et codes de `/openapi.json` (FastAPI) sont comparés à `spec/audio-service.openapi.json`.
- **`test_indiscernable.py`** : tous les ids sont des UUID v4 ; un son créé apparaît dans `/audio/list` avec les mêmes champs qu'un son de la bibliothèque (`voiceId` compris) ; la liste est triée par id ; `clipUrl` de même forme ; mêmes métadonnées de dépôt sur le CDN (`Content-Type`, `Cache-Control`) ; mêmes en-têtes MP3 (en-tête LAME, fréquence, pas d'ID3). Le `Last-Modified` du CDN se vérifie à la main sur le CDN choisi (§3).
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
- les liens `/docs` et vers le contrat `spec/` (`audio-request.schema.json`, `audio-response.schema.json`, `audio-service.openapi.json`) ;
- la section « Tester sans clé : `PROVIDER=fake` » ;
- les crédits (`library/CREDITS.md`, « Voices generated with Gradium AI ») ;
- le tableau « outils utilisés » : Gradium TTS (REST, `gradium-tts-beta`, Voice Design), FastAPI, uvicorn, httpx, numpy, soundfile/libsndfile/LAME, lameenc, uv, Docker, Kubernetes (cluster gcast), le CDN retenu ; hors ligne : imageio-ffmpeg/ffmpeg, pyloudnorm ; sons : Freesound, Kenney, OpenGameArt.

---

## 9. Plan de build

### 9.1 Étapes (une personne ; durées **estimées**)

| # | Durée | Livrable | Débloque |
|---|---|---|---|
| **J0** | 0 h 30 | uv + Python 3.12, squelette, vérification de l'appel MP3 de soundfile. **Poster le §3 et le §3.7 dans le chat de l'équipe**, faire valider en 10 min par Go et le front | contrat figé |
| **J1** | 1 h 00 | **Service bouchon déployé** : `PROVIDER=fake`, les 3 endpoints du contrat avec leurs formes finales (`AudioRequest`/`AudioResponse`, erreurs à plat) + `/healthz`, `/docs`, dépôt sur le CDN (ou, s'il n'est pas encore choisi, un stockage bouchon qui fournit déjà un `clipUrl` public), 20 à 30 clips Kenney CC0 passés par le prototype, Dockerfile, manifests Kubernetes, déploiement sur le cluster gcast. Envoyer l'URL interne du service (`AUDIO_SERVICE_URL`) et le domaine du CDN | **Go** (pioche ; `POST` seulement dans une itération suivante du web app, la première version ne fait que distribuer depuis la liste) et **front** (lecture des `clipUrl` ; formulaire plus tard). Fait apparaître tôt les problèmes de namespace, DNS du cluster, sortie réseau vers Gradium et dépôt sur le CDN |
| **J2** | 0 h 45, en parallèle de J1 | Mesures Gradium depuis Paris (§9.2) + une requête volontairement fausse (format d'erreur, type de `json_config`) | décisions : transport, table de débit, horodatages bêta en FR (`MAX_CHARS` reste 100, limite du contrat) |
| **J3a** | 2 h 45 | Faux serveur étendu (45 min), puis l'indispensable : client NDJSON sur un seul `httpx.AsyncClient` (`keepalive_expiry=120`), `textguard.py`, `emotion.py` (émotion → préréglage, par défaut sinon), post-traitement avec plafond à 2,0 s et fondu, sémaphore, `MAX_CHARS`, délai, dépôt CDN et registre persistant, **un seul repli** (une nouvelle tentative avec `default` si la bêta échoue), tests, déploiement, `bench_service.py` | vraie génération en ligne |
| **J3b** (optionnel) | 1 h 30 | Coupe au mot, cache des doublons, budget du jour et plancher de crédits, bascule durable vers `default`, voix de secours, pool pré-ouvert à plus d'une connexion | robustesse, latence des générations simultanées |
| **J4** | 2 h 00 (un coéquipier peut aider à l'écoute) | `build_library.py`, `sources.yaml` (avec `text`, `emotion` et la voix de chaque clip), **120 clips**, 20 à 40 répliques Gradium réparties sur les préréglages, `CREDITS.md`, dépôt de la bibliothèque sur le CDN | parties complètes |
| **J5** | 0 h 45 | Liste de blocage, README du service, `.env.example`, test de conformité à `spec/`, test depuis itch.io (**vérifier dans DevTools l'origine réelle de l'iframe**), test sur un vrai iPhone | critères du jury |
| **J6** (optionnel) | 1 à 2 h | Ce que J2 justifie (§5.5) ; 4 à 8 voix Voice Design ; bibliothèque portée à 300 | qualité, latence |
| **J7** | 0 h 30 | Dernier `bench_service.py`, chiffres dans le README, vérification qu'aucune clé n'est dans l'historique, tag `v1.0` | version jury |

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
- **À lancer depuis Paris, puis une fois depuis le pod du cluster gcast** (`kubectl exec`, ou chiffres lus dans `/healthz`).

**`tools/bench_service.py`** (de bout en bout) :
- `--url --n 30 --concurrency 1|4` (plus de `--token`) ; lancé depuis le cluster (`kubectl port-forward` ou un pod) ;
- des textes tous différents (pour contourner le cache), sur une dizaine d'émotions couvrant tous les préréglages, puis les mêmes textes pour mesurer le cache ;
- mesure côté client le temps du `POST` (dépôt CDN compris) puis du `GET` de `clipUrl` ; les temps côté serveur (`timings`) viennent des **journaux** du service (`kubectl logs`), plus de la réponse ;
- affiche p50/p95/max côté client et côté serveur, et écrit un CSV.

Ces chiffres vont dans le README et le pitch. p50 et p95 : la valeur sous laquelle tombent 50 % et 95 % des mesures.

**Règles de décision** (les seuils sont des choix, pas des données) :

| Mesure | Décision |
|---|---|
| Connexion REST non réutilisée, **ou** `ws_warm` < `rest_ndjson` − 30 ms en médiane | construire le client WebSocket |
| Clip complet > 400 ms | génération spéculative |
| Clip complet − premier son > 300 ms | envisager le streaming |
| `setup`→`ready` > 50 ms | setup à l'avance |
| Premier son depuis le cluster gcast > premier son depuis Paris + 30 ms | Le signaler à l'équipe ; pas de plan B d'hébergement (le service reste à côté de Go, §8.4) ; les options du §5.5 compensent en partie |
| Dépôt CDN > 150 ms en médiane | Revoir le CDN ou sa région ; client gardé ouvert |
| Caractères/s réels | Conseil de longueur du front (25) et table de débit (`MAX_CHARS` = 100 fixé par le contrat) |

---

## 10. À caler avec l'équipe (une décision chacune, défaut proposé)

1. **Qui appelle `POST /audio` ?** **Tranché** (README, `spec/`) : Go seulement, sans jeton, avec une limite par joueur. Le navigateur n'appelle pas le service.
2. **Qui télécharge les MP3 ?** **Tranché** : le navigateur, directement sur le CDN à `clipUrl`, reçu dans l'état de jeu de Go. Go ne manipule que des `AudioResponse` (et n'envoie aux joueurs que `id` et `clipUrl`).
3. **Forme de `GET /audio/list` ?** **Tranché** (`spec/`) : tableau nu d'`AudioResponse` `{id, text, emotion, voiceId, clipUrl}`, ids en UUID v4, sans titre ni tags, bibliothèque et sons créés mêlés, triés par id.
4. **Un son créé remplace-t-il une carte, ou la main passe-t-elle à 6 ?** **Tranché** (README) : main de 6, 5 cartes distribuées + 1 case « custom » facultative.
5. **Où tournent Go et le service ?** **Tranché** : cluster Kubernetes gcast, tous les deux, réseau privé du cluster (§8.4). Restent à décider : namespace, registre d'images, nom du Service.
6. **Dossier du service ?** Défaut : `./audio-service` à la racine, à côté de `./webapp`, et `.env`/`*.env` ajoutés au `.gitignore`.
7. **Quel CDN, et avec quels identifiants ?** Défaut : à choisir par l'équipe (README : « CDN to be decided »). Exigences : dépôt par API depuis le pod, `Range`/206, `Cache-Control` réglable au dépôt, **pas de `Last-Modified` qui trahisse la date de dépôt** (§3), CORS réglable si le front passe un jour par `fetch()`.
8. **Émotion → voix Gradium : comment traduire le texte libre ?** Défaut : table interne `config/emotions.json` (émotions courantes FR/EN) vers une dizaine de préréglages, préréglage par défaut sinon, langue du texte devinée pour choisir la voix FR ou EN (§4.1). Détail interne au service ; seul le résultat est exposé dans `voiceId`. À valider après écoute.
9. **Longueur du texte ?** **Tranché** : 100 caractères au maximum (contrat, appliqué par le front ; par le service dans une version ultérieure). Défaut pour le reste : compteur dans le front, 25 conseillés ; table de débit recalibrée après J2.
10. **Les sons créés, présents dans `/audio/list`, peuvent-ils être distribués aux autres joueurs ?** Défaut : dans le même salon non (ils sont dans les sons utilisés du salon, README) ; dans d'autres salons, oui sauf si l'équipe préfère que Go les écarte avec les ids reçus en réponse à ses `POST`.
    **Domaines CORS** : plus rien à régler sur le service (Go sert de proxy). Seuls Go (`ALLOWED_ORIGINS`) et, si le front lit un jour les MP3 par `fetch()`, le CDN en ont besoin.
11. **Où garder les objets des sons créés pour qu'ils survivent à un redémarrage du pod ?** Défaut : un `<uuid>.json` sous un préfixe non public du stockage du CDN (§7.1) ; sinon un volume persistant Kubernetes ; sinon rien, pas de redéploiement pendant la démo, et Go remplace toute carte en 404.
12. **`text`, `emotion` et `voiceId` des sons sans paroles de la bibliothèque** (bruitages, ambiances, jingles), que le schéma exige ? Défaut proposé : `text` = une onomatopée ou un mot neutre qui ne donne pas la réponse, `emotion` = l'émotion évoquée, `voiceId` = celui d'une voix des préréglages (le champ doit exister sans trahir un son créé). Autre option : limiter la bibliothèque aux répliques parlées, puisque `spec/` décrit l'objet comme « a generated speech clip ». **À trancher avant J4.**
13. **Qui aide à écouter et trier la bibliothèque (~1 h 30) ?** Défaut : un coéquipier remplit `sources.yaml` pendant que tu écris le client Gradium.
14. **Le front accepte-t-il les consignes du §3.7 ?** Défaut : oui, intégrées dès le service bouchon.
15. **Questions pour le stand Gradium** (défaut en attendant : limites basses) :
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
| Le temps du **clip complet** chez Gradium n'est publié nulle part et peut dominer la latence | Mesure dès J2 ; temps de chaque étape dans les journaux du service ; options du §5.5 prêtes |
| L'alias bêta change ou tombe pendant que le jury joue | Repli vers `default`, durable 30 min après 3 échecs ; `model` journalisé ; tester la version datée `gradium-tts-beta-202609` |
| Débit du français, silences ajoutés par la bêta, horodatages absents : clips coupés en plein mot | Calibrage avec la sonde ; coupe au passage silencieux en secours ; texte réellement prononcé journalisé ; conseil de 25 caractères dans le front |
| Générations simultanées qui paient TCP+TLS (~45 ms mesurés depuis le lieu du hackathon) | 4 connexions pré-ouvertes et entretenues, `keepalive_expiry=120` (défaut httpx : 5 s) ; tester `httpx[http2]` si Gradium le permet (non documenté) |
| Limites Gradium inconnues (sessions simultanées ; 1500 caractères par session sur l'offre gratuite) | Sémaphore à 4, 502 `busy`, question au stand. En REST, chaque requête est une session séparée, donc la limite par session ne gêne pas |
| Clé poussée sur GitHub = disqualification | Secret Kubernetes, `secret/` ignoré, `.env` à ajouter au `.gitignore`, recherche dans l'historique avant le gel |
| Crédits vidés par abus | Service privé au cluster (pas d'Ingress, `NetworkPolicy` proposée), limite par joueur dans Go, `DAILY_CHAR_BUDGET`, `CREDIT_FLOOR`, 100 caractères au plus (front ; service plus tard), cache des doublons |
| Service coupé après le hackathon (cluster gcast, crédits Gradium, CDN) | Tag `v1.0` ; déploiement automatique coupé ; bibliothèque jouable même sans Gradium (MP3 déjà sur le CDN) |
| Région du cluster gcast inconnue : distance à Gradium et au CDN non mesurée | `gradium_ip` et `tls_ms` dans `/healthz`, temps de dépôt CDN journalisé, mesure en J1 ; options du §5.5 |
| Choix du CDN encore ouvert (bloque `clipUrl`) | Stockage bouchon en J1, abstraction `cdn.py` ; décision à prendre avant J3a |
| Redémarrage du pod : registre des sons créés perdu (404 sur `GET /audio/{id}` alors que le MP3 est sur le CDN) | Registre persistant (§7.1) ; Go remplace la carte ; pas de redéploiement pendant la démo |
| Origine de l'iframe itch.io incertaine | Le front ne lit que le CDN avec `<audio>` (pas de CORS nécessaire) et Go pour le reste (`ALLOWED_ORIGINS`) ; vérification dans DevTools après le premier envoi |
| Un son créé repérable (nouvel id dans la liste relue avant/après, `Last-Modified` du CDN, id, `voiceId`) | UUID v4 partout, sons créés dans la liste triée par id, `voiceId` sur tous les objets et mêmes voix dans la bibliothèque, mêmes réglages d'encodage et de dépôt ; `Last-Modified` à neutraliser sur le CDN (question 7 du §10) ; les ids restent visibles par le proxy de Go (limite connue, §6.5, à traiter avec l'itération des sons créés) |
| iOS : interrupteur silencieux, premier décodage lent, pas testé sur un vrai iPhone | `audioSession 'playback'`, préchargement (et décodage de chauffe si Web Audio), `Range` vérifié sur le CDN, test sur téléphone en J5 |
| `soundfile` : paramètres MP3 différents selon la version | Vérification en J0 ; repli lameenc (+64 ms de longueur, départ décalé de 24 à 46 ms) |
| Demande de retrait d'un son (repo public, licences non respectées, risque accepté par Oscar) | Pas d'extraits d'œuvres connues ; `CREDITS.md` avec la source de chaque son pour en retirer un seul vite |
| Charge de travail d'une personne ; curation de la bibliothèque longue | 120 clips d'abord ; aide à l'écoute ; J6 entièrement optionnel |