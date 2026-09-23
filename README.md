# Anime Doppiati ITA

Addon per [Stremio](https://www.stremio.com/) che pubblica i **cataloghi di anime doppiati in italiano**, usando come fonte [AnimeUnity](https://www.animeunity.so/).

## Cosa fa

L'addon aggiunge a Stremio quattro cataloghi:

- **`Ultime uscite doppiate ITA`** — elenca gli anime con doppiaggio italiano **ordinati per uscita dell'ultimo episodio**: il primo elemento è l'anime il cui episodio doppiato è uscito più di recente. È mostrato nella home.
- **`Top anime doppiati ITA`** — la **classifica top di [MyAnimeList](https://myanimelist.net/topanime.php)** filtrata ai soli titoli **disponibili doppiati ITA** su AnimeUnity, mantenendo l'ordine di ranking MAL. È mostrato nella home.
- **`Top anime in onda ITA`** — la **classifica degli anime attualmente in onda di [MyAnimeList](https://myanimelist.net/topanime.php?type=airing)** filtrata ai soli titoli **disponibili doppiati ITA** su AnimeUnity, in ordine di ranking MAL. È mostrato solo nella home (non compare in ricerca).
- **`Anime doppiati ITA` (solo ricerca)** — un catalogo **globale** che permette di cercare fra **tutti** gli anime doppiati ITA presenti sull'archivio di AnimeUnity (non solo le ultime uscite). Non compare nella home: viene interrogato **solo quando fai una ricerca** dalla barra di Stremio.

Ogni elemento usa un **id Kitsu** (`kitsu:<id>`) e l'addon fornisce direttamente la **scheda con la lista episodi** (metadati da [Kitsu](https://kitsu.io/)).

L'addon **non riproduce video**: per le **fonti/streaming** serve un addon di streaming anime (vedi sotto). La scheda e gli episodi, invece, vengono caricati dall'addon stesso, senza dipendere da Anime Kitsu. Gli episodi delle serie sono mostrati in un'unica stagione con numerazione progressiva e ID `kitsu:<id>:<episodio>`. Per serie molto lunghe o con un conteggio Kitsu incompleto, una chiave TMDB configurata può integrare gli episodi mancanti e fornire immagini distinte quando disponibili.

### Come funziona (flusso)

**Catalogo home (ultime uscite):**

1. Scorre il feed "ultimi episodi" di AnimeUnity (paginatore embeddato in `<layout-items>` sulla home, via `?page=N`), che è ordinato per data di uscita degli episodi.
2. Tiene solo gli episodi **doppiati** (`anime.dub === 1`) e deduplica per anime, mantenendo la prima occorrenza (la più recente): così l'ordine riflette quale anime ha avuto l'ultimo episodio doppiato per ultimo.
3. Per ogni anime ricava l'id [Kitsu](https://kitsu.io/) tramite il suo `anilist_id` / `mal_id` (endpoint `mappings` di Kitsu, con cache).
4. Restituisce a Stremio le anteprime del catalogo con id `kitsu:<id>`, poster, trama e voto. Il catalogo assemblato è in cache 10 minuti.

**Catalogo top (classifica MAL ∩ doppiati):**

1. Costruisce una sola volta l'**indice dell'intero archivio doppiato** di AnimeUnity (endpoint `archivio/get-animes`, query vuota) chiave `mal_id`, in cache 12 ore.
2. Scarica la **classifica top di MyAnimeList** via [Jikan](https://jikan.moe/) (`/top/anime`), in ordine di ranking.
3. Tiene i titoli MAL presenti nell'indice doppiato (in ordine di ranking), li mappa su id Kitsu e li restituisce come anteprime. Il catalogo è in cache 6 ore e viene pre-costruito all'avvio.

**Catalogo in onda (classifica MAL airing ∩ doppiati):** stesso flusso del catalogo top, ma la classifica scaricata da Jikan è quella degli anime **attualmente in onda** (`/top/anime?filter=airing`, l'equivalente di `topanime.php?type=airing`). I doppiaggi arrivano in ritardo rispetto ai simulcast, quindi i titoli corrispondenti sono pochi: un'unica riga in home, senza divisione serie/film.

**Catalogo ricerca (archivio globale):**

1. Recupera dalla home il token CSRF e i cookie di sessione (l'endpoint dell'archivio è protetto da CSRF), tenuti in cache 30 minuti.
2. Interroga l'endpoint `POST /archivio/get-animes` con filtro `dubbed: true` e il termine cercato, paginando per `offset` (fino a un tetto di pagine per query).
3. Mappa i risultati su id Kitsu e li restituisce come anteprime, esattamente come il catalogo home. I risultati sono in cache 10 minuti per query.

**Scheda (meta):** all'apertura di un elemento, l'addon costruisce la scheda dall'API di Kitsu (dettaglio anime + lista episodi). Gli episodi usano video id nel formato `kitsu:<id>:<episodio>`, lo stesso che si aspettano gli addon di streaming anime, così possono agganciare le fonti.

## Addon consigliati (per lo streaming)

Catalogo e scheda funzionano da soli. Per **guardare** gli episodi serve in più un addon di **streaming anime** (es. Torrentio in modalità anime, o equivalenti) che riconosca gli id `kitsu:`.

## Requisiti

- [Node.js](https://nodejs.org/) **18 o superiore**
- Connessione a internet (l'addon interroga le API pubbliche di AnimeUnity e Kitsu)

## Installazione e avvio

```bash
# Installa le dipendenze
npm install

# Avvia l'addon
npm start
```

L'addon si avvia di default sulla porta **7000**. In console vedrai:

```
Addon attivo su http://localhost:7000
Configura/installa su Stremio: http://localhost:7000/configure
```

Per lo sviluppo è disponibile uno script con log di debug e auto-reload:

```bash
npm run dev
```

### Avvio con Docker

È incluso un `Dockerfile` pronto all'uso in [docker/](docker/):

```bash
docker build -f docker/Dockerfile -t dubbed-anime-feed .
docker run -p 7000:7000 dubbed-anime-feed
```

> Nota: il `Dockerfile` è volutamente fuori dalla root del progetto. Beamup (l'hosting su cui si pubblica l'addon) usa il buildpack Node standard tramite `package.json`; un `Dockerfile` nella root farebbe partire il buildpack Docker, incompatibile con il suo avvio dei processi.

## Deploy su Beamup

L'addon si pubblica su [Beamup](https://github.com/Stremio/stremio-beamup) (hosting Dokku per addon Stremio). Il deploy avviene via `git push`.

```bash
git push beamup
```

> ⚠️ **Importante:** Beamup fa il deploy dal branch **`main`**, non `master`. Configura il refspec corretto:
> ```bash
> git config remote.beamup.push refs/heads/main:refs/heads/main
> ```

### Deploy automatico con un tag

La workflow [`.github/workflows/deploy-beamup.yml`](.github/workflows/deploy-beamup.yml) pubblica su Beamup quando viene inviato un tag `vX.Y.Z` sul commit corrente di `main`. Il tag deve coincidere sia con la versione di `package.json` sia con `manifest.version` in `addon.js`; prima del deploy vengono eseguiti i controlli e i test.

Configura questi **segreti del repository** in GitHub → Settings → Secrets and variables → Actions:

| Segreto | Valore |
|---------|--------|
| `BEAMUP_REMOTE` | URL esatto di `git remote get-url beamup` sul computer da cui pubblichi già l'addon (es. `dokku@deployer.beamup.dev:<account-id>/<addon-slug>`). |
| `BEAMUP_SSH_PRIVATE_KEY` | Chiave privata SSH dedicata alla Action. La chiave pubblica corrispondente deve essere autorizzata sul tuo account GitHub e sincronizzata con Beamup tramite `beamup-cli`. |
| `BEAMUP_SSH_KNOWN_HOSTS` | Riga verificata del server Beamup nel tuo `known_hosts` (puoi individuarla con `ssh-keygen -F <host-beamup>`). |

Dopo aver unito le modifiche su `main` e aggiornato entrambe le versioni, crea e invia il tag:

```bash
git checkout main
git pull --ff-only
git tag v1.5.1
git push origin v1.5.1
```

Sostituisci `v1.5.1` con la versione presente nei file. Il push del tag avvia la Action, che distribuisce esattamente quel commit su Beamup. Un tag su un commit diverso dalla punta corrente di `main` viene rifiutato per evitare distribuzioni accidentali di versioni precedenti.

### Le modifiche non si vedono dopo il deploy?

Davanti a Beamup c'è **Cloudflare**, che mette in cache il manifest. Dopo un deploy riuscito conviene **incrementare il campo `version`** nel manifest ([addon.js](addon.js) e [package.json](package.json)) e, in Stremio, **rimuovere e reinstallare** l'addon per rileggere il manifest aggiornato.

## Variabili d'ambiente

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `PORT` | `7000` | Porta su cui resta in ascolto il server. |
| `DEBUG` | *(disattivo)* | Impostala a `1` o `true` per stampare log dettagliati (richieste/risposte ad AnimeUnity e Kitsu). |

Esempio:

```bash
# PowerShell
$env:DEBUG = "1"; node index.js

# Bash
DEBUG=1 node index.js
```

## Architettura

- **[index.js](index.js)** — Server [Express](https://expressjs.com/) che monta il router dell'addon SDK, serve gli asset statici (logo e sfondo) da [assets/](assets/) e personalizza la pagina di landing/installazione.
- **[addon.js](addon.js)** — Definisce il `manifest` (i tre cataloghi, tipi) e i gestori `catalog` e `meta` che rispondono alle richieste di Stremio. Il gestore `catalog` distingue fra catalogo ultime uscite, top e ricerca (`search` obbligatorio, così quest'ultimo non compare nella home).
- **[services/animeunity.js](services/animeunity.js)** — Integrazione con AnimeUnity: lettura del feed "ultimi episodi", ricerca nell'archivio doppiato (endpoint `archivio/get-animes` con handshake CSRF), indice dell'archivio doppiato per `mal_id` (per il catalogo top), filtro dei doppiati e deduplica per anime, mapping verso gli id Kitsu e cache di cataloghi e ricerche.
- **[services/mal.js](services/mal.js)** — Recupera la classifica top di MyAnimeList tramite l'API Jikan (`/top/anime`), con gestione del rate limit e cache.
- **[services/kitsu.js](services/kitsu.js)** — Costruzione della scheda (meta) dall'API Kitsu: dettaglio anime, generi, lista episodi con video id `kitsu:<id>:<episodio>`, con cache.
- **[debug.js](debug.js)** — Piccola utility di logging condizionata dalla variabile `DEBUG`.

## Limitazioni

- Il catalogo dipende dalla disponibilità dei titoli su AnimeUnity e dalla presenza di un mapping su Kitsu: i titoli senza mapping Kitsu vengono esclusi.
- L'addon si appoggia a un'API pubblica non ufficiale di AnimeUnity: eventuali modifiche lato loro possono richiedere aggiornamenti.
- Per scheda completa e riproduzione servono gli addon anime dell'ecosistema (Anime Kitsu + un provider di stream).
