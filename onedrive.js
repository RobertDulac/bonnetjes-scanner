/* OneDrive-koppeling via Microsoft Graph.
   Houdt één vast Excel-bestand in de OneDrive van de gebruiker bij, dat na elke
   wijziging volledig wordt herschreven met de actuele lijst van bonnen. */
(function (global) {
  "use strict";

  const CLIENT_ID = "51c3008e-24d3-4557-a18b-15447cd98265";
  const AUTHORITY = "https://login.microsoftonline.com/common";
  const SCOPES = ["Files.ReadWrite", "User.Read"];

  const SLEUTEL_PAD = "bonnetjes:onedrive-pad";
  const STANDAARD_PAD = "administratie/Bonnetjes.xlsx";

  let msalApp = null;
  let account = null;

  function beschikbaar() {
    return typeof msal !== "undefined" && CLIENT_ID && CLIENT_ID.indexOf("__") !== 0;
  }

  async function init() {
    if (!beschikbaar()) return null;
    msalApp = new msal.PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        redirectUri: location.origin + location.pathname,
      },
      cache: { cacheLocation: "localStorage" },
    });
    await msalApp.initialize();

    // Na een terugkeer van de Microsoft-inlogpagina staat het resultaat hier.
    const resultaat = await msalApp.handleRedirectPromise().catch(() => null);
    if (resultaat?.account) account = resultaat.account;
    else {
      const bekende = msalApp.getAllAccounts();
      if (bekende.length) account = bekende[0];
    }
    return account;
  }

  function verbonden() {
    return Boolean(account);
  }

  function pad() {
    return localStorage.getItem(SLEUTEL_PAD) || STANDAARD_PAD;
  }

  function zetPad(waarde) {
    localStorage.setItem(SLEUTEL_PAD, (waarde || "").trim() || STANDAARD_PAD);
  }

  function verbind() {
    if (!msalApp) throw new Error("OneDrive-koppeling is niet beschikbaar.");
    return msalApp.loginRedirect({ scopes: SCOPES });
  }

  async function ontkoppel() {
    if (!msalApp || !account) return;
    await msalApp.clearCache({ account });
    account = null;
  }

  async function token() {
    if (!msalApp || !account) throw new Error("Niet verbonden met OneDrive.");
    try {
      const r = await msalApp.acquireTokenSilent({ scopes: SCOPES, account });
      return r.accessToken;
    } catch (e) {
      // Stilzwijgend hernieuwen lukte niet; de gebruiker moet opnieuw inloggen.
      // Dit gebeurt alleen bij een expliciete actie (Verbinden/Nu synchroniseren),
      // nooit tijdens een automatische achtergrondsynchronisatie.
      throw new Error("HERNIEUW_INLOG");
    }
  }

  /**
   * Schrijft het gegeven Excel-bestand (Blob) volledig naar het ingestelde pad.
   * Bestaat het bestand nog niet, dan wordt het aangemaakt; bestaat het al, dan
   * wordt de inhoud vervangen.
   */
  async function schrijfBestand(blob) {
    const t = await token();
    const segmenten = pad().split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const url = `https://graph.microsoft.com/v1.0/me/drive/root:/${segmenten}:/content`;

    const antwoord = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + t,
        "Content-Type": "application/octet-stream",
      },
      body: blob,
    });

    if (antwoord.status === 423) throw new Error("Het bestand staat open in Excel. Sluit het en probeer opnieuw.");
    if (antwoord.status === 404) throw new Error(`De map bestaat niet in OneDrive: ${pad().split("/").slice(0, -1).join("/")}`);
    if (!antwoord.ok) {
      let bericht = `OneDrive-fout ${antwoord.status}`;
      try {
        const fout = await antwoord.json();
        if (fout?.error?.message) bericht = fout.error.message;
      } catch (e) { /* geen JSON-antwoord */ }
      throw new Error(bericht);
    }
    return antwoord.json();
  }

  global.OneDrive = { init, beschikbaar, verbonden, pad, zetPad, verbind, ontkoppel, schrijfBestand, token, get account() { return account; } };
})(window);
