const path = require("path");
const express = require("express");
const { getRouter } = require("stremio-addon-sdk");
const landingTemplate = require("stremio-addon-sdk/src/landingTemplate");
const addonInterface = require("./addon");
const { getTopDubbedCatalog } = require("./services/animeunity");

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
app.use(getRouter(addonInterface));
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
  // rebuilds lazily on the first request instead).
  getTopDubbedCatalog(0).catch((err) =>
    console.error("Pre-build top catalog fallito:", err.message)
  );
});
