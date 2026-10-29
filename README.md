# Anime Doppiati ITA

Addon per [Stremio](https://www.stremio.com/) che pubblica i **cataloghi di anime doppiati in italiano**. Le ultime uscite combinano [AnimeUnity](https://www.animeunity.so/) e [AnimeWorld](https://www.animeworld.ac/); classifiche e ricerca usano l'archivio AnimeUnity.

## Cosa fa

L'addon aggiunge a Stremio quattro cataloghi:

- **Ultime uscite doppiate ITA** — i cataloghi `Ultime serie doppiate ITA` e `Ultimi film doppiati ITA` combinano i feed doppiati di entrambe le fonti, senza duplicati, con ordine di recenza approssimativo. Sono mostrati nella home.
- **`Top anime doppiati ITA`** — la **classifica top di [MyAnimeList](https://myanimelist.net/topanime.php)** filtrata ai soli titoli **disponibili doppiati ITA** su AnimeUnity, mantenendo l'ordine di ranking MAL. È mostrato nella home.
- **`Top anime in onda ITA`** — la **classifica degli anime attualmente in onda di [MyAnimeList](https://myanimelist.net/topanime.php?type=airing)** filtrata ai soli titoli **disponibili doppiati ITA** su AnimeUnity, in ordine di ranking MAL. È mostrato solo nella home (non compare in ricerca).
- **`Anime doppiati ITA` (solo ricerca)** — un catalogo **globale** che permette di cercare fra **tutti** gli anime doppiati ITA presenti sull'archivio di AnimeUnity (non solo le ultime uscite). Non compare nella home: viene interrogato **solo quando fai una ricerca** dalla barra di Stremio.

Ogni elemento usa un **id Kitsu** (`kitsu:<id>`) e l'addon fornisce direttamente la **scheda con la lista episodi** (metadati da [Kitsu](https://kitsu.io/)).

L'addon **non riproduce video**: per le **fonti/streaming** serve un addon di streaming anime (vedi sotto). La scheda e gli episodi, invece, vengono caricati dall'addon stesso, senza dipendere da Anime Kitsu. Gli episodi delle serie sono mostrati in un'unica stagione con numerazione progressiva e ID `kitsu:<id>:<episodio>`. Per serie molto lunghe o con un conteggio Kitsu incompleto, una chiave TMDB configurata può integrare gli episodi mancanti e fornire immagini distinte quando disponibili.

### Come funziona (flusso)

**Catalogo home (ultime uscite):**

1. Recupera in parallelo il feed "ultimi episodi" di AnimeUnity e la sezione **Dub-ITA** della home AnimeWorld. Ogni fonte ha un budget di recupero di 20 secondi; AnimeWorld recupera le schede con al massimo 6 richieste simultanee e conserva i dettagli validi per 12 ore.
2. Tiene solo i doppiati e, in ciascun feed, la prima occorrenza di ogni anime. Le schede AnimeWorld forniscono ID MyAnimeList/AniList e categoria; le schede non riconosciute vengono saltate.
3. Alterna le posizioni dei due feed (AU1, AW1, AU2, AW2, …), poi mappa su [Kitsu](https://kitsu.io/) e rimuove i duplicati per **ID Kitsu** prima della paginazione. Titoli diversi dello stesso anime non producono due locandine.
4. L'ordine combinato è **approssimativo**: AnimeWorld non espone date di pubblicazione nel feed verificato. Non vengono inventate date né confrontati numeri episodio fra anime diversi. Non viene mantenuto uno storico persistente delle prime rilevazioni.
5. Le due categorie condividono il recupero delle fonti, con cache di 10 minuti e pre-caricamento all'avvio. Se una fonte fallisce, i risultati freschi dell'altra precedono l'ultima copia disponibile della fonte fallita. Le copie delle fonti e l'ultimo catalogo valido sono conservati **in memoria**, per un massimo di 24 ore; si perdono al riavvio. Se entrambe falliscono, si ritenta dopo un minuto. Errori di fonte o indisponibilità totale dei mapping Kitsu non sono memorizzati come cataloghi vuoti.

Le ultime uscite e i cataloghi Top usano AnimeWorld come alternativa quando AnimeUnity non risponde; la ricerca continua a dipendere dall'archivio AnimeUnity. ID cataloghi, ID Kitsu, configurazione e orientamento immagini restano compatibili.

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
- **[services/animeworld.js](services/animeworld.js)** — Lettura dei metadati del feed Dub-ITA e delle schede AnimeWorld. I risultati confluiscono nelle ultime uscite gestite da `animeunity.js`, con deduplica per ID Kitsu. Non vengono interrogati server video.
- **[services/mal.js](services/mal.js)** — Recupera la classifica top di MyAnimeList tramite l'API Jikan (`/top/anime`), con gestione del rate limit e cache.
- **[services/kitsu.js](services/kitsu.js)** — Costruzione della scheda (meta) dall'API Kitsu: dettaglio anime, generi, lista episodi con video id `kitsu:<id>:<episodio>`, con cache.
- **[debug.js](debug.js)** — Piccola utility di logging condizionata dalla variabile `DEBUG`.

## Limitazioni

- Il catalogo dipende dalla disponibilità dei titoli su AnimeUnity e dalla presenza di un mapping su Kitsu: i titoli senza mapping Kitsu vengono esclusi.
- L'addon si appoggia a un'API pubblica non ufficiale di AnimeUnity: eventuali modifiche lato loro possono richiedere aggiornamenti.
- Per scheda completa e riproduzione servono gli addon anime dell'ecosistema (Anime Kitsu + un provider di stream).


### Metadati in Nuvio (1.5.6)

I cataloghi usano i tipi standard `series` e `movie`, mantenendo gli ID Kitsu.
Dopo l'aggiornamento, aggiorna/reinstalla l'addon e modifica il `type` nelle
collezioni JSON che usavano `anime`; addonId e catalogId non cambiano.
Le vecchie richieste meta con tipo `anime` restano disponibili.

Le schede integrano cast, trailer e trame degli episodi dall'endpoint pubblico
EasyCatalogs, senza richiedere una chiave TMDB nell'addon. Questo recupero
aggiuntivo richiede che il servizio sia disponibile e che abbia metadati per
quel titolo. In caso di errore o timeout vengono mantenuti i dati Kitsu.
Il collegamento degli episodi avviene per ID esatto, senza cambiare numerazione
né ID delle fonti. La chiave TMDB opzionale nell'addon mantiene la priorità
per le traduzioni italiane; la chiave impostata in Nuvio è usata dall'app.


### Orientamento immagini e chiave TMDB (1.5.14)

Nella configurazione scegli `portrait` (predefinito) o `landscape`, per tutti i
cataloghi e la ricerca. Per i veri backdrop TMDB inserisci nel campo **Chiave
API TMDB** la stessa chiave che usi in Nuvio, poi reinstalla il link generato.
Nuvio non trasmette la propria chiave al server dell'addon.

Il resolver legge il titolo tramite ID Kitsu e prova le corrispondenze TMDB,
IMDb e TVDB disponibili, poi una ricerca per titolo esatto e anno. Il tipo
TMDB viene determinato dal sottotipo Kitsu: ONA e OVA vengono cercate come
serie, anche quando compaiono nella nostra riga film. L'ID del catalogo e gli
ID degli episodi rimangono Kitsu.

Le immagini provengono direttamente da TMDB, senza EasyCatalogs. Si preferiscono
backdrop 16:9 in italiano, senza testo oppure in inglese. Se mancano, si cerca
un vero fotogramma TMDB, una copertina orizzontale Kitsu o un'immagine di episodio
Kitsu. Non vengono usati poster verticali, bande aggiunte o sfondi sfocati.
Se nessuna fonte ha un'immagine orizzontale, l'addon non inventa un'immagine di
ripiego. Le nuove anteprime espongono URL CDN diretti, senza la chiave API negli
URL delle immagini. La chiave resta nella configurazione dell'addon.

I vecchi URL immagine restano supportati durante il rinnovo delle cache. Per
proxy personalizzati è disponibile `PUBLIC_URL=https://dominio.example`;
gli hostname interni Beamup vengono convertiti al dominio pubblico HTTPS.

### Recupero dei tre cataloghi Top (1.5.14)

La classifica e l'ordine rimangono MyAnimeList (tramite Jikan o MAL). Il filtro
ITA usa l'archivio AnimeUnity; in caso di errore DNS o indisponibilità usa
l'archivio doppiato AnimeWorld e i titoli doppiati recenti. Per AnimeWorld sono
richiesti sia il badge DUB nell'elenco sia l'audio italiano nella scheda, oltre
all'ID MAL esatto per l'incrocio con la classifica.

La scansione alternativa lavora a lotti limitati e riprende dalle pagine e
schede non completate. Finché è parziale, l'indice e i cataloghi derivati
scadono dopo un minuto, così nuovi risultati entrano senza attendere sei ore.
Per “in onda”, se l'indice è parziale o senza corrispondenze, vengono cercati
anche i titoli della classifica MAL direttamente su AnimeWorld. Dalla 1.5.16
la ricerca riprende al lotto successivo anche dopo timeout, senza fermarsi ai
primi 40 titoli; conserva i risultati verificati e mantiene l'ordine MAL. Ogni
risultato deve confermare lo stesso ID MAL e l'audio italiano. Le richieste
dispongono di 12 secondi, entro un limite totale di 30 secondi per scansione.
Se tutte le fonti sono indisponibili, si conserva l'ultimo indice valido per
un massimo di 24 ore; nessun risultato vuoto dovuto a un errore viene trattato
come una verifica di doppiaggio.

### Filtro episodi doppiati (1.5.10)

Nella pagina di configurazione puoi attivare **Mostra solo episodi confermati
ITA**. L’opzione è disattivata per impostazione predefinita. Installa il link
manifest generato per applicarla. Il prefisso `[ITA]` nei titoli è stato rimosso.

La disponibilità in italiano si basa sulla presenza dell’episodio doppiato su
**AnimeWorld o AnimeUnity**: basta la conferma di una delle due fonti. Il controllo
unisce i numeri effettivi delle liste episodi e dei feed doppiati recenti, senza
dedurre intervalli dal conteggio o dall’ultimo episodio. Su AnimeWorld è richiesto
l’audio Italiano e la corrispondenza degli ID MyAnimeList/AniList.

Quando attivo, il filtro viene applicato dopo tutte le integrazioni di metadati,
TMDB compreso. Mantiene titoli, ID, stagione e numerazione degli episodi conservati:
se sono confermati 1 e 3, il 2 viene nascosto senza rinumerare il 3. Speciali e
numerazioni senza corrispondenza esatta non sono considerati confermati.

Le verifiche sono condivise fra richieste simultanee e aggiornate ogni 10 minuti.
In caso di mancata conferma o errore viene mantenuta l’ultima verifica positiva
per un massimo di 24 ore, con tentativi ogni minuto; la cache è in memoria e si
perde al riavvio. Senza conferme utilizzabili viene mostrata la lista completa,
anche se il filtro è attivo, per evitare schede vuote per errori delle fonti.

Il filtro riguarda le schede fornite da questo addon, anche aprendo lo stesso
anime da un altro catalogo se Nuvio sceglie questi metadati. Non richiede modifiche
a Nuvio; se il client sceglie un altro provider meta, viene usata la sua lista.
La presenza sulle fonti monitorate non garantisce uno stream italiano negli
addon di riproduzione installati.
