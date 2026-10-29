const fs = require("fs");
const path = require("path");
const express = require("express");

// Minimal .env loader (no dependency): for local development, load KEY=VALUE
// lines from a gitignored .env into process.env without overriding what's
// already set. Lets `npm run dev` pick up TMDB_API_KEY locally.
(function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch (_) {
    /* no .env file — fine */
  }
})();
const { getRouter } = require("stremio-addon-sdk");
const landingTemplate = require("stremio-addon-sdk/src/landingTemplate");
const addonInterface = require("./addon");
const { getLandscapeArtwork, absoluteArtwork, publicOrigin } = require("./services/artwork");
const {
  getDubbedCatalog,
  getTopDubbedCatalog,
  getTopAiringDubbedCatalog,
} = require("./services/animeunity");

const PORT = process.env.PORT || 7000;

// Extra CSS injected into the SDK landing page: a less-transparent panel behind
// all the texts so they stay readable over the background illustration.
const PANEL_CSS = `
#addon {
  /* Wider than the SDK default (40vh) so the "DubbedAnimeFeed" title fits on one line. */
  width: 52vh;
  background: rgba(18, 13, 28, 0.85);
  padding: 4vh 4vh 5vh;
  border-radius: 2.2vh;
  box-shadow: 0 1.5vh 4vh rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}
.install-link {
  display: block;
}
.config-help {
  font-size: 0.85em;
  line-height: 1.5;
  opacity: 0.85;
  margin-top: 0.7em;
}
#installLink button,
#copyManifestBtn {
  width: 100%;
  margin-left: auto;
  margin-right: auto;
}
`;

// landingTemplate embeds its styles in a single <style> block; append ours so
// it overrides the defaults without forking the SDK template.
const landingHTML = landingTemplate(addonInterface.manifest)
  .replace("</style>", `${PANEL_CSS}</style>`)
  .replace('id="onlyDubbedEpisodes"', 'id="onlyDubbedEpisodes" aria-describedby="dubbedEpisodesHelp"')
  .replace(
    /(<label for="onlyDubbedEpisodes">[\s\S]*?<\/label>)/,
    '$1<p id="dubbedEpisodesHelp" class="config-help">La disponibilità in italiano si basa sulla presenza dell’episodio doppiato su AnimeWorld o AnimeUnity: basta la conferma di una delle due fonti. Se non è possibile verificare, manteniamo l’ultima verifica valida (fino a 24 ore); senza conferme mostriamo tutti gli episodi. La presenza sulle fonti non garantisce uno stream italiano negli addon installati.</p>'
  )
  // Rename the default INSTALL button and add a "copy manifest link" button
  // (for manual installation) right after the install link.
  .replace(
    `<a id="installLink" class="install-link" href="#">
			<button name="Install">INSTALL</button>
			</a>`,
    `<a id="installLink" class="install-link" href="#">
			<button name="Install">INSTALLA SU STREMIO</button>
			</a>
			<button id="copyManifestBtn" type="button" style="margin-top:1.5vh;background:#5a5a7a;">Copia link manifest</button>
			<p style="margin-top:2.5vh;text-align:center;opacity:0.85;">Powered by <a href="https://github.com/DevGizmo86" target="_blank" rel="noopener">DevGizmo</a></p>
			<div style="text-align:center;margin-top:1.5vh;"><a href="https://buymeacoffee.com/devgizmo" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:0.8vh;padding:1.2vh 2.4vh;background:#ffdd00;color:#000;font-weight:600;text-decoration:none;border-radius:2.5vh;">☕ Support me</a></div>`
  )
  // Wire up the copy button: derive the plain-HTTP manifest URL from the
  // stremio:// install link and put it on the clipboard.
  .replace(
    "</script>",
    `
			const copyManifestBtn = document.getElementById('copyManifestBtn')
			if (copyManifestBtn) {
				copyManifestBtn.onclick = async () => {
					if (typeof mainForm !== 'undefined' && !mainForm.reportValidity()) return
					if (typeof updateLink === 'function') updateLink()
					const manifestUrl = installLink.href.replace('stremio://', window.location.protocol + '//')
					const original = copyManifestBtn.textContent
					try {
						await navigator.clipboard.writeText(manifestUrl)
						copyManifestBtn.textContent = 'Link copiato!'
					} catch (e) {
						window.prompt('Copia il link del manifest:', manifestUrl)
					}
					setTimeout(() => { copyManifestBtn.textContent = original }, 2000)
				}
			}
		</script>`
  );

const app = express();
app.use((req, res, next) => {
  const origin = publicOrigin(req);
  return getRouter({
    ...addonInterface,
    get: async (...args) => absoluteArtwork(await addonInterface.get(...args), origin),
  })(req, res, next);
});
const sendLandscape = async (req, res) => {
  const type = req.params.type || "series";
  if (!/^\d+$/.test(req.params.id) || !["series", "movie"].includes(type)) return res.sendStatus(404);
  try {
    const artwork = await getLandscapeArtwork(req.params.id, type);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=21600");
    if (artwork.redirect) return res.redirect(302, artwork.redirect);
    res.type("jpeg").send(artwork.body);
  } catch (error) {
    console.error(`Landscape artwork ${req.params.id} failed: ${error.message}`);
    res.sendStatus(502);
  }
};
app.get("/artwork/landscape/:type/:id.jpg", sendLandscape);
// Keep old catalog URLs usable while clients refresh their cached previews.
app.get("/artwork/landscape/:id.jpg", sendLandscape);
app.use("/assets", express.static(path.join(__dirname, "assets")));

const sendLanding = (_, res) => {
  res.setHeader("content-type", "text/html");
  res.end(landingHTML);
};
app.get("/", (_, res) => res.redirect("/configure"));
app.get("/configure", sendLanding);

app.listen(PORT, () => {
  console.log(`Addon attivo su http://localhost:${PORT}`);
  console.log(`Configura/installa su Stremio: http://localhost:${PORT}/configure`);

  // Warm the "Top anime doppiati ITA" cache in the background: building it cold
  // walks the full dubbed archive + the MAL top list, which is too slow to do
  // inside the first catalog request. Errors here are non-fatal (it just
  // rebuilds lazily on the first request instead). The airing catalog is warmed
  // right after, so it reuses the dubbed-archive index instead of racing a
  // second walk in parallel.
  const tmdbKey = process.env.TMDB_API_KEY || null;
  // Warm both latest catalogs with one shared two-source load. This is
  // independent of the archive/MAL warm-up, so an AnimeUnity outage cannot
  // prevent AnimeWorld's recent dubbed titles from appearing.
  Promise.all([
    getDubbedCatalog("series", 0, tmdbKey),
    getDubbedCatalog("movie", 0, tmdbKey),
  ]).catch((err) => console.error("Pre-build latest catalog fallito:", err.message));
  getTopDubbedCatalog("series", 0, tmdbKey)
    .catch((err) => console.error("Pre-build top catalog fallito:", err.message))
    .then(() => getTopAiringDubbedCatalog(0, tmdbKey))
    .catch((err) => console.error("Pre-build airing catalog fallito:", err.message));
});
