/* Bonnetjes-scanner — kastickets fotograferen, uitlezen en naar een spreadsheet exporteren. */
(function () {
  "use strict";

  const API_URL = "https://api.anthropic.com/v1/messages";
  const MAX_ZIJDE = 1800;      // langste zijde van de verstuurde foto, in pixels
  const GELIJKTIJDIG = 3;      // aantal foto's dat tegelijk wordt geanalyseerd
  const TOLERANTIE = 0.02;     // afrondingsmarge bij de controleberekeningen, in euro

  // Niet elk model kent adaptief denken en het effort-niveau.
  const ONDERSTEUNT_DENKEN = (model) => !/haiku/i.test(model);

  // ==========================================================================
  // Instellingen
  // ==========================================================================
  const Instellingen = {
    lees() {
      let opgeslagen = {};
      try { opgeslagen = JSON.parse(localStorage.getItem("bonnetjes:instellingen") || "{}"); }
      catch (e) { opgeslagen = {}; }
      return Object.assign({
        sleutel: "",
        model: "claude-opus-5",
        categorie: "etentje",
      }, opgeslagen);
    },
    schrijf(waarden) {
      localStorage.setItem("bonnetjes:instellingen", JSON.stringify(waarden));
    },
  };

  let instellingen = Instellingen.lees();

  // ==========================================================================
  // Opslag (IndexedDB): bonnen + bijbehorende foto's
  // ==========================================================================
  const Opslag = {
    _db: null,

    async db() {
      if (this._db) return this._db;
      this._db = await new Promise((resolve, reject) => {
        const verzoek = indexedDB.open("bonnetjes", 1);
        verzoek.onupgradeneeded = () => {
          const db = verzoek.result;
          if (!db.objectStoreNames.contains("bonnen")) db.createObjectStore("bonnen", { keyPath: "id" });
          if (!db.objectStoreNames.contains("fotos")) db.createObjectStore("fotos", { keyPath: "id" });
        };
        verzoek.onsuccess = () => resolve(verzoek.result);
        verzoek.onerror = () => reject(verzoek.error);
      });
      return this._db;
    },

    async _actie(winkel, modus, werk) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(winkel, modus);
        const verzoek = werk(tx.objectStore(winkel));
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => resolve(verzoek ? verzoek.result : undefined);
      });
    },

    alleBonnen()        { return this._actie("bonnen", "readonly",  s => s.getAll()); },
    bewaarBon(bon)      { return this._actie("bonnen", "readwrite", s => s.put(bon)); },
    verwijderBon(id)    { return this._actie("bonnen", "readwrite", s => s.delete(id)); },
    foto(id)            { return this._actie("fotos",  "readonly",  s => s.get(id)); },
    alleFotos()         { return this._actie("fotos",  "readonly",  s => s.getAll()); },
    bewaarFoto(id, blob){ return this._actie("fotos",  "readwrite", s => s.put({ id, blob })); },
    verwijderFoto(id)   { return this._actie("fotos",  "readwrite", s => s.delete(id)); },
  };

  let bonnen = [];   // in het geheugen, altijd gesorteerd op datum aflopend

  // ==========================================================================
  // Hulpfuncties
  // ==========================================================================
  const $ = (kiezer) => document.querySelector(kiezer);
  const nieuwId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const rond = (n) => Math.round((Number(n) || 0) * 100) / 100;

  function euro(n) {
    return (Number(n) || 0).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function toonMelding(tekst, duur) {
    const el = $("#toast");
    el.textContent = tekst;
    el.classList.remove("hidden");
    clearTimeout(toonMelding._t);
    toonMelding._t = setTimeout(() => el.classList.add("hidden"), duur || 3000);
  }

  function downloadBestand(blob, bestandsnaam) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = bestandsnaam;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function sorteer() {
    bonnen.sort((a, b) => (b.datum || "").localeCompare(a.datum || "") || b.aangemaakt - a.aangemaakt);
  }

  // ==========================================================================
  // Foto's verkleinen
  // ==========================================================================
  async function verkleinAfbeelding(bestand, maxZijde) {
    const bitmap = await createImageBitmap(bestand, { imageOrientation: "from-image" });
    const schaal = Math.min(1, maxZijde / Math.max(bitmap.width, bitmap.height));
    const breedte = Math.max(1, Math.round(bitmap.width * schaal));
    const hoogte = Math.max(1, Math.round(bitmap.height * schaal));

    const canvas = document.createElement("canvas");
    canvas.width = breedte;
    canvas.height = hoogte;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, breedte, hoogte);
    bitmap.close?.();

    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  }

  function blobNaarBase64(blob) {
    return new Promise((resolve, reject) => {
      const lezer = new FileReader();
      lezer.onload = () => resolve(String(lezer.result).split(",")[1]);
      lezer.onerror = () => reject(lezer.error);
      lezer.readAsDataURL(blob);
    });
  }

  // ==========================================================================
  // Claude API
  // ==========================================================================
  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["datum", "etablissement", "plaats", "valuta", "totaal", "btw_totaal",
               "btw_regels", "betaalwijze", "categorie", "leesbaarheid", "opmerking"],
    properties: {
      datum:         { type: "string", description: "Transactiedatum als YYYY-MM-DD; leeg als onleesbaar." },
      etablissement: { type: "string", description: "Handelsnaam van de zaak." },
      plaats:        { type: "string", description: "Gemeente of stad." },
      valuta:        { type: "string", description: "Valutacode, meestal EUR." },
      totaal:        { type: "number", description: "Betaald totaalbedrag inclusief btw." },
      btw_totaal:    { type: "number", description: "Totaal btw-bedrag; 0 als de bon geen btw vermeldt." },
      btw_regels: {
        type: "array",
        description: "Eén item per btw-tarief dat op de bon staat.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["percentage", "grondslag", "btw"],
          properties: {
            percentage: { type: "number", description: "Btw-tarief, bijvoorbeeld 12 of 21." },
            grondslag:  { type: "number", description: "Bedrag exclusief btw voor dit tarief." },
            btw:        { type: "number", description: "Btw-bedrag voor dit tarief." },
          },
        },
      },
      betaalwijze:  { type: "string", description: "Bijvoorbeeld Bancontact, contant, Visa. Leeg als onbekend." },
      categorie:    { type: "string", enum: ["etentje", "lunch", "drank", "hotel", "taxi", "brandstof", "kantoor", "overig"] },
      leesbaarheid: { type: "string", enum: ["goed", "matig", "slecht"] },
      opmerking:    { type: "string", description: "Korte notitie als er iets opvalt, anders leeg." },
    },
  };

  const SYSTEEM = [
    "Je leest kastickets van Belgische en Nederlandse ondernemingen en haalt daar de boekhoudkundige gegevens uit.",
    "",
    "Datum: neem de datum van de transactie. In België en Nederland staat de dag vooraan, dus 03/04/2025 is 3 april 2025.",
    "Etablissement: de handelsnaam zoals die bovenaan de bon staat, niet de juridische naam of het adres.",
    "Bedragen: gebruik een punt als decimaalteken. Een komma op de bon is het decimaalteken, geen duizendtalscheiding.",
    "Totaal: het werkelijk betaalde bedrag inclusief btw, inclusief fooi als die op de bon is afgedrukt.",
    "Btw: horecabonnen hebben vaak twee tarieven (België 12% eten en 21% drank, Nederland 9% eten en 21% alcohol).",
    "Neem elk tarief apart op in btw_regels, met de grondslag (bedrag exclusief btw) en het btw-bedrag.",
    "btw_totaal is de som van de btw-bedragen in btw_regels.",
    "Staat er geen btw-uitsplitsing op de bon, laat btw_regels dan leeg en zet btw_totaal op 0.",
    "",
    "Vul 0 in bij een onbekend bedrag en een lege tekst bij een onbekend tekstveld. Verzin nooit een waarde.",
    "Zet leesbaarheid op 'slecht' als je de datum of een bedrag moest raden.",
  ].join("\n");

  async function leesBonUit(base64, opties) {
    opties = opties || {};
    const inhoud = {
      model: instellingen.model,
      max_tokens: 2048,
      system: SYSTEEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: "Haal de gegevens uit dit kasticket." },
        ],
      }],
    };

    // Grondige modus: laat het model eerst redeneren voordat het antwoordt.
    // Haiku kent adaptief denken en het effort-niveau niet en wijst ze af,
    // dus daar blijft het bij een gewone tweede poging.
    if (opties.grondig && ONDERSTEUNT_DENKEN(instellingen.model)) {
      inhoud.thinking = { type: "adaptive" };
      inhoud.output_config.effort = "high";
      inhoud.max_tokens = 8000;
    }

    let laatsteFout;
    for (let poging = 0; poging < 4; poging++) {
      let antwoord;
      try {
        antwoord = await fetch(API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": instellingen.sleutel,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify(inhoud),
        });
      } catch (e) {
        laatsteFout = new Error("Geen verbinding met de server.");
        await new Promise(r => setTimeout(r, 1500 * (poging + 1)));
        continue;
      }

      if (antwoord.status === 429 || antwoord.status >= 500) {
        const wacht = Number(antwoord.headers.get("retry-after")) * 1000 || 2000 * (poging + 1);
        laatsteFout = new Error(antwoord.status === 429 ? "Te veel verzoeken." : "De server is tijdelijk overbelast.");
        await new Promise(r => setTimeout(r, wacht));
        continue;
      }

      if (!antwoord.ok) {
        let bericht = `Serverfout ${antwoord.status}`;
        try {
          const fout = await antwoord.json();
          if (fout?.error?.message) bericht = fout.error.message;
        } catch (e) { /* geen JSON-antwoord */ }
        if (antwoord.status === 401) bericht = "De API-sleutel wordt niet geaccepteerd. Controleer hem in Instellingen.";
        if (antwoord.status === 400 && /credit|balance/i.test(bericht)) bericht = "Onvoldoende tegoed op het Anthropic-account.";
        throw new Error(bericht);
      }

      const data = await antwoord.json();

      if (data.stop_reason === "refusal") throw new Error("Het model heeft deze afbeelding geweigerd te verwerken.");
      if (data.stop_reason === "max_tokens") throw new Error("Het antwoord was afgekapt. Probeer het opnieuw.");

      const tekstblok = (data.content || []).find(b => b.type === "text");
      if (!tekstblok) throw new Error("Leeg antwoord van het model.");

      try {
        return JSON.parse(tekstblok.text);
      } catch (e) {
        throw new Error("Het antwoord was geen geldige JSON.");
      }
    }
    throw laatsteFout || new Error("Analyse mislukt.");
  }

  // ==========================================================================
  // Controle van de uitgelezen gegevens
  // ==========================================================================
  function controleer(bon) {
    const punten = [];

    if (!bon.datum || !/^\d{4}-\d{2}-\d{2}$/.test(bon.datum)) {
      punten.push("Geen geldige datum herkend.");
    } else {
      const d = new Date(bon.datum + "T12:00:00");
      if (Number.isNaN(d.getTime())) {
        punten.push("Geen geldige datum herkend.");
      } else {
        const nu = new Date();
        if (d > nu) punten.push("De datum ligt in de toekomst.");
        if (d.getFullYear() < nu.getFullYear() - 3) punten.push("De datum is ouder dan drie jaar.");
      }
    }

    if (!bon.etablissement) punten.push("Geen etablissement herkend.");
    if (!(Number(bon.totaal) > 0)) punten.push("Geen totaalbedrag herkend.");

    const regels = bon.btw_regels || [];
    if (regels.length) {
      const somBtw = rond(regels.reduce((t, r) => t + (Number(r.btw) || 0), 0));
      if (Math.abs(somBtw - rond(bon.btw_totaal)) > TOLERANTIE) {
        punten.push(`De btw-uitsplitsing telt op tot ${euro(somBtw)}, maar het btw-totaal is ${euro(bon.btw_totaal)}.`);
      }
      const somGrondslag = rond(regels.reduce((t, r) => t + (Number(r.grondslag) || 0), 0));
      const berekendTotaal = rond(somGrondslag + somBtw);
      if (Number(bon.totaal) > 0 && Math.abs(berekendTotaal - rond(bon.totaal)) > TOLERANTIE) {
        punten.push(`Grondslag plus btw is ${euro(berekendTotaal)}, maar het totaal op de bon is ${euro(bon.totaal)}.`);
      }
    } else if (Number(bon.btw_totaal) > 0) {
      punten.push("Btw-bedrag zonder uitsplitsing per tarief.");
    }

    if (Number(bon.btw_totaal) > Number(bon.totaal)) punten.push("Het btw-bedrag is hoger dan het totaal.");
    if (bon.leesbaarheid === "slecht") punten.push("Het model kon de bon slecht lezen; controleer de bedragen.");

    return punten;
  }

  // ==========================================================================
  // Verwerkingswachtrij
  // ==========================================================================
  const wachtrij = [];
  let actief = 0;

  function tekenTaak(taak) {
    let el = document.getElementById("taak-" + taak.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "taak";
      el.id = "taak-" + taak.id;
      el.innerHTML = '<img alt=""><div class="taak-tekst"><div class="taak-titel"></div><div class="taak-status"></div></div>';
      $("#wachtrij").prepend(el);
    }
    const img = el.querySelector("img");
    if (taak.voorbeeldUrl && img.src !== taak.voorbeeldUrl) img.src = taak.voorbeeldUrl;
    el.querySelector(".taak-titel").textContent = taak.titel;
    const status = el.querySelector(".taak-status");
    status.textContent = taak.status;
    status.className = "taak-status" + (taak.fout ? " fout" : taak.klaar ? " klaar" : "");
  }

  async function voegFotosToe(bestanden) {
    if (!instellingen.sleutel) {
      toonMelding("Stel eerst een API-sleutel in.");
      opendInstellingen();
      return;
    }
    for (const bestand of bestanden) {
      if (!bestand.type.startsWith("image/")) continue;
      const taak = { id: nieuwId(), bestand, titel: bestand.name || "Bonnetje", status: "In de wachtrij" };
      taak.voorbeeldUrl = URL.createObjectURL(bestand);
      wachtrij.push(taak);
      tekenTaak(taak);
    }
    pompWachtrij();
  }

  function pompWachtrij() {
    while (actief < GELIJKTIJDIG) {
      const taak = wachtrij.find(t => !t.bezig && !t.klaar && !t.fout);
      if (!taak) break;
      taak.bezig = true;
      actief++;
      verwerkTaak(taak).finally(() => { actief--; pompWachtrij(); });
    }
  }

  async function verwerkTaak(taak) {
    try {
      taak.status = "Foto voorbereiden…";
      tekenTaak(taak);
      const klein = await verkleinAfbeelding(taak.bestand, MAX_ZIJDE);

      taak.status = "Uitlezen…";
      tekenTaak(taak);
      const base64 = await blobNaarBase64(klein);
      const gelezen = await leesBonUit(base64);

      const bon = maakBon(gelezen);
      await Opslag.bewaarFoto(bon.id, klein);
      await Opslag.bewaarBon(bon);
      bonnen.push(bon);
      sorteer();
      tekenBonnen();
      werkTellingBij();

      taak.klaar = true;
      taak.titel = bon.etablissement || "Bonnetje";
      taak.status = bon.controleren
        ? `${bon.datum || "?"} · ${euro(bon.totaal)} · controleren`
        : `${bon.datum || "?"} · ${euro(bon.totaal)} · opgeslagen`;
    } catch (e) {
      taak.fout = true;
      taak.status = e.message || "Mislukt";
    } finally {
      taak.bezig = false;
      tekenTaak(taak);
      URL.revokeObjectURL(taak.voorbeeldUrl);
    }
  }

  function maakBon(gelezen) {
    const bon = {
      id: nieuwId(),
      aangemaakt: Date.now(),
      datum: gelezen.datum || "",
      etablissement: gelezen.etablissement || "",
      plaats: gelezen.plaats || "",
      valuta: gelezen.valuta || "EUR",
      totaal: rond(gelezen.totaal),
      btw_totaal: rond(gelezen.btw_totaal),
      btw_regels: (gelezen.btw_regels || []).map(r => ({
        percentage: Number(r.percentage) || 0,
        grondslag: rond(r.grondslag),
        btw: rond(r.btw),
      })),
      betaalwijze: gelezen.betaalwijze || "",
      categorie: gelezen.categorie || instellingen.categorie,
      leesbaarheid: gelezen.leesbaarheid || "goed",
      notitie: gelezen.opmerking || "",
    };
    bon.waarschuwingen = controleer(bon);
    bon.controleren = bon.waarschuwingen.length > 0;
    return bon;
  }

  // ==========================================================================
  // Bonnenlijst
  // ==========================================================================
  function zichtbareBonnen() {
    const zoekterm = $("#zoek").value.trim().toLowerCase();
    const alleenControleren = $("#filter-controleren").checked;
    return bonnen.filter(b => {
      if (alleenControleren && !b.controleren) return false;
      if (!zoekterm) return true;
      return (b.etablissement + " " + b.plaats).toLowerCase().includes(zoekterm);
    });
  }

  function maandNaam(iso) {
    if (!/^\d{4}-\d{2}/.test(iso)) return "Zonder datum";
    const d = new Date(iso.slice(0, 7) + "-01T12:00:00");
    return d.toLocaleDateString("nl-NL", { month: "long", year: "numeric" });
  }

  function tekenBonnen() {
    const lijst = $("#bonnenlijst");
    lijst.textContent = "";
    const zichtbaar = zichtbareBonnen();

    if (!zichtbaar.length) {
      const leeg = document.createElement("p");
      leeg.className = "leeg";
      leeg.textContent = bonnen.length ? "Geen bonnen die aan het filter voldoen." : "Nog geen bonnen gescand.";
      lijst.append(leeg);
      return;
    }

    let huidigeMaand = null;
    for (const bon of zichtbaar) {
      const maand = maandNaam(bon.datum);
      if (maand !== huidigeMaand) {
        huidigeMaand = maand;
        const totaalMaand = zichtbaar
          .filter(b => maandNaam(b.datum) === maand)
          .reduce((t, b) => t + (Number(b.totaal) || 0), 0);
        const kop = document.createElement("div");
        kop.className = "maandkop";
        kop.innerHTML = `<span></span><span></span>`;
        kop.children[0].textContent = maand;
        kop.children[1].textContent = "€ " + euro(totaalMaand);
        lijst.append(kop);
      }

      const knop = document.createElement("button");
      knop.className = "bon" + (bon.controleren ? " te-controleren" : "");
      knop.type = "button";
      knop.innerHTML =
        '<div class="bon-hoofd"><div class="bon-naam"></div><div class="bon-sub"></div></div>' +
        '<div class="bon-bedrag"><div class="bon-totaal"></div><div class="bon-btw"></div></div>';
      knop.querySelector(".bon-naam").textContent = bon.etablissement || "(zonder naam)";
      knop.querySelector(".bon-sub").textContent =
        [bon.datum || "geen datum", bon.plaats, bon.controleren ? "controleren" : ""].filter(Boolean).join(" · ");
      knop.querySelector(".bon-totaal").textContent = "€ " + euro(bon.totaal);
      knop.querySelector(".bon-btw").textContent = "btw € " + euro(bon.btw_totaal);
      knop.addEventListener("click", () => opendBon(bon.id));
      lijst.append(knop);
    }
  }

  function werkTellingBij() {
    $("#badge-aantal").textContent = String(bonnen.length);
    werkExportTellingBij();
  }

  // ==========================================================================
  // Detailvenster
  // ==========================================================================
  let bewerkteId = null;
  let dialoogFotoUrl = null;

  function tekenBtwRegels(regels) {
    const houder = $("#f-btw-regels");
    houder.textContent = "";

    const kop = document.createElement("div");
    kop.className = "btw-kop";
    kop.innerHTML = "<span>Tarief %</span><span>Excl. btw</span><span>Btw</span><span></span>";
    houder.append(kop);

    for (const regel of regels) voegBtwRegelToe(regel);
  }

  function voegBtwRegelToe(regel) {
    regel = regel || { percentage: 21, grondslag: 0, btw: 0 };
    const rij = document.createElement("div");
    rij.className = "btw-regel";
    rij.innerHTML =
      '<input type="number" step="0.1" inputmode="decimal" class="r-pct">' +
      '<input type="number" step="0.01" inputmode="decimal" class="r-grondslag">' +
      '<input type="number" step="0.01" inputmode="decimal" class="r-btw">' +
      '<button type="button" class="weg" aria-label="Regel verwijderen">&times;</button>';
    rij.querySelector(".r-pct").value = regel.percentage;
    rij.querySelector(".r-grondslag").value = regel.grondslag;
    rij.querySelector(".r-btw").value = regel.btw;
    rij.querySelector(".weg").addEventListener("click", () => rij.remove());
    $("#f-btw-regels").append(rij);
  }

  function leesBtwRegels() {
    return Array.from(document.querySelectorAll("#f-btw-regels .btw-regel")).map(rij => ({
      percentage: Number(rij.querySelector(".r-pct").value) || 0,
      grondslag: rond(rij.querySelector(".r-grondslag").value),
      btw: rond(rij.querySelector(".r-btw").value),
    })).filter(r => r.percentage || r.grondslag || r.btw);
  }

  async function opendBon(id) {
    const bon = bonnen.find(b => b.id === id);
    if (!bon) return;
    bewerkteId = id;

    $("#dlg-titel").textContent = bon.etablissement || "Bon bewerken";
    $("#f-datum").value = bon.datum || "";
    $("#f-etablissement").value = bon.etablissement || "";
    $("#f-plaats").value = bon.plaats || "";
    $("#f-totaal").value = bon.totaal ?? "";
    $("#f-btw").value = bon.btw_totaal ?? "";
    $("#f-categorie").value = bon.categorie || "overig";
    $("#f-betaalwijze").value = bon.betaalwijze || "";
    $("#f-notitie").value = bon.notitie || "";
    tekenBtwRegels(bon.btw_regels || []);
    toonWaarschuwingen(bon.waarschuwingen || []);

    const fotoEl = $("#dlg-foto");
    fotoEl.classList.add("hidden");
    if (dialoogFotoUrl) { URL.revokeObjectURL(dialoogFotoUrl); dialoogFotoUrl = null; }
    const record = await Opslag.foto(id);
    if (record?.blob) {
      dialoogFotoUrl = URL.createObjectURL(record.blob);
      fotoEl.src = dialoogFotoUrl;
      fotoEl.classList.remove("hidden");
    }

    $("#dlg-bon").showModal();
  }

  function toonWaarschuwingen(punten) {
    const vak = $("#dlg-waarschuwingen");
    if (!punten.length) { vak.classList.add("hidden"); return; }
    vak.textContent = "";
    const titel = document.createElement("div");
    titel.textContent = "Even controleren:";
    const ul = document.createElement("ul");
    for (const p of punten) {
      const li = document.createElement("li");
      li.textContent = p;
      ul.append(li);
    }
    vak.append(titel, ul);
    vak.classList.remove("hidden");
  }

  async function bewaarBewerking() {
    const bon = bonnen.find(b => b.id === bewerkteId);
    if (!bon) return;

    bon.datum = $("#f-datum").value;
    bon.etablissement = $("#f-etablissement").value.trim();
    bon.plaats = $("#f-plaats").value.trim();
    bon.totaal = rond($("#f-totaal").value);
    bon.btw_totaal = rond($("#f-btw").value);
    bon.btw_regels = leesBtwRegels();
    bon.categorie = $("#f-categorie").value;
    bon.betaalwijze = $("#f-betaalwijze").value.trim();
    bon.notitie = $("#f-notitie").value.trim();
    bon.leesbaarheid = "goed";   // handmatig nagekeken
    bon.waarschuwingen = controleer(bon);
    bon.controleren = bon.waarschuwingen.length > 0;

    await Opslag.bewaarBon(bon);
    sorteer();
    tekenBonnen();
    werkTellingBij();
    $("#dlg-bon").close();
    toonMelding(bon.controleren ? "Bewaard, maar er blijven aandachtspunten." : "Bewaard.");
  }

  async function verwijderHuidigeBon() {
    const bon = bonnen.find(b => b.id === bewerkteId);
    if (!bon) return;
    if (!confirm(`"${bon.etablissement || "Deze bon"}" definitief verwijderen?`)) return;
    await Opslag.verwijderBon(bon.id);
    await Opslag.verwijderFoto(bon.id);
    bonnen = bonnen.filter(b => b.id !== bon.id);
    tekenBonnen();
    werkTellingBij();
    $("#dlg-bon").close();
    toonMelding("Verwijderd.");
  }

  async function heranalyseer() {
    const bon = bonnen.find(b => b.id === bewerkteId);
    if (!bon) return;
    const record = await Opslag.foto(bon.id);
    if (!record?.blob) { toonMelding("De foto van deze bon is niet meer beschikbaar."); return; }

    const knop = $("#btn-heranalyse");
    knop.disabled = true;
    knop.textContent = "Bezig…";
    try {
      const base64 = await blobNaarBase64(record.blob);
      const gelezen = await leesBonUit(base64, { grondig: true });
      const vers = maakBon(gelezen);
      Object.assign(bon, vers, { id: bon.id, aangemaakt: bon.aangemaakt });
      await Opslag.bewaarBon(bon);
      sorteer();
      tekenBonnen();
      await opendBon(bon.id);
      toonMelding("Opnieuw geanalyseerd.");
    } catch (e) {
      toonMelding(e.message || "Analyse mislukt.");
    } finally {
      knop.disabled = false;
      knop.textContent = "Opnieuw analyseren";
    }
  }

  // ==========================================================================
  // Export
  // ==========================================================================
  function exportSelectie() {
    const van = $("#export-van").value;
    const tot = $("#export-tot").value;
    return bonnen
      .filter(b => (!van || (b.datum && b.datum >= van)) && (!tot || (b.datum && b.datum <= tot)))
      .slice()
      .sort((a, b) => (a.datum || "").localeCompare(b.datum || ""));   // oplopend op datum
  }

  function werkExportTellingBij() {
    const selectie = exportSelectie();
    const totaal = selectie.reduce((t, b) => t + (Number(b.totaal) || 0), 0);
    const btw = selectie.reduce((t, b) => t + (Number(b.btw_totaal) || 0), 0);
    const teControleren = selectie.filter(b => b.controleren).length;
    $("#export-telling").textContent = selectie.length
      ? `${selectie.length} bonnen · totaal € ${euro(totaal)} · btw € ${euro(btw)}` +
        (teControleren ? ` · ${teControleren} nog te controleren` : "")
      : "Geen bonnen in deze periode.";
  }

  function bouwTabel(selectie) {
    const maxRegels = Math.min(4, Math.max(1, ...selectie.map(b => (b.btw_regels || []).length)));

    const kop = ["Datum", "Etablissement", "Plaats", "Categorie",
                 "Totaal incl. btw", "Btw-totaal", "Bedrag excl. btw"];
    for (let i = 1; i <= maxRegels; i++) kop.push(`Tarief ${i} %`, `Grondslag ${i}`, `Btw ${i}`);
    kop.push("Betaalwijze", "Notitie", "Te controleren");

    const rijen = selectie.map(bon => {
      const rij = [
        { v: bon.datum, t: "datum" },
        { v: bon.etablissement, t: "tekst" },
        { v: bon.plaats, t: "tekst" },
        { v: bon.categorie, t: "tekst" },
        { v: rond(bon.totaal), t: "geld" },
        { v: rond(bon.btw_totaal), t: "geld" },
        { v: rond((Number(bon.totaal) || 0) - (Number(bon.btw_totaal) || 0)), t: "geld" },
      ];
      for (let i = 0; i < maxRegels; i++) {
        const r = (bon.btw_regels || [])[i];
        rij.push(
          { v: r ? r.percentage : "", t: "num" },
          { v: r ? rond(r.grondslag) : "", t: "geld" },
          { v: r ? rond(r.btw) : "", t: "geld" }
        );
      }
      rij.push(
        { v: bon.betaalwijze, t: "tekst" },
        { v: bon.notitie, t: "tekst" },
        { v: bon.controleren ? "ja" : "", t: "tekst" }
      );
      return rij;
    });

    const breedtes = [12, 28, 16, 12, 16, 12, 16];
    for (let i = 0; i < maxRegels; i++) breedtes.push(10, 13, 10);
    breedtes.push(14, 30, 13);

    return { kop, rijen, breedtes };
  }

  function bestandsnaam(extensie) {
    const van = $("#export-van").value;
    const tot = $("#export-tot").value;
    const periode = van || tot ? `_${van || "begin"}_tot_${tot || "nu"}` : "";
    return `bonnetjes${periode}.${extensie}`;
  }

  function exporteerXlsx() {
    const selectie = exportSelectie();
    if (!selectie.length) { toonMelding("Geen bonnen om te exporteren."); return; }
    const { kop, rijen, breedtes } = bouwTabel(selectie);
    const blob = Xlsx.maakWerkboek(kop, rijen, { naam: "Bonnen", breedtes });
    downloadBestand(blob, bestandsnaam("xlsx"));
    toonMelding(`${selectie.length} bonnen geëxporteerd.`);
  }

  function exporteerCsv() {
    const selectie = exportSelectie();
    if (!selectie.length) { toonMelding("Geen bonnen om te exporteren."); return; }
    const { kop, rijen } = bouwTabel(selectie);

    const veld = (cel) => {
      if (cel == null || cel.v == null || cel.v === "") return "";
      if (cel.t === "geld" || cel.t === "num") return String(cel.v).replace(".", ",");
      const tekst = String(cel.v);
      return /[";\n]/.test(tekst) ? '"' + tekst.replace(/"/g, '""') + '"' : tekst;
    };

    const regels = [kop.map(k => veld({ v: k, t: "tekst" })).join(";")]
      .concat(rijen.map(rij => rij.map(veld).join(";")));

    // Byte order mark zodat Excel het bestand als UTF-8 opent
    const blob = new Blob(["﻿" + regels.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    downloadBestand(blob, bestandsnaam("csv"));
    toonMelding(`${selectie.length} bonnen geëxporteerd.`);
  }

  async function maakBackup() {
    if (!bonnen.length) { toonMelding("Er is nog niets om te bewaren."); return; }
    toonMelding("Back-up wordt gemaakt…");
    const fotos = await Opslag.alleFotos();
    const gecodeerd = {};
    for (const f of fotos) {
      if (f.blob) gecodeerd[f.id] = await blobNaarBase64(f.blob);
    }
    const blob = new Blob([JSON.stringify({ versie: 1, bonnen, fotos: gecodeerd })], { type: "application/json" });
    downloadBestand(blob, `bonnetjes_backup_${new Date().toISOString().slice(0, 10)}.json`);
    toonMelding("Back-up gemaakt.");
  }

  async function zetBackupTerug(bestand) {
    let data;
    try {
      data = JSON.parse(await bestand.text());
    } catch (e) {
      toonMelding("Dit is geen geldig back-upbestand.");
      return;
    }
    if (!Array.isArray(data.bonnen)) { toonMelding("Dit back-upbestand bevat geen bonnen."); return; }

    const bestaandeIds = new Set(bonnen.map(b => b.id));
    const nieuwe = data.bonnen.filter(b => b && b.id && !bestaandeIds.has(b.id));
    if (!nieuwe.length) { toonMelding("Alle bonnen uit deze back-up staan er al in."); return; }

    for (const bon of nieuwe) {
      bon.waarschuwingen = controleer(bon);
      bon.controleren = bon.waarschuwingen.length > 0;
      await Opslag.bewaarBon(bon);
      const base64 = data.fotos?.[bon.id];
      if (base64) {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        await Opslag.bewaarFoto(bon.id, new Blob([bytes], { type: "image/jpeg" }));
      }
      bonnen.push(bon);
    }
    sorteer();
    tekenBonnen();
    werkTellingBij();
    toonMelding(`${nieuwe.length} bonnen teruggezet.`);
  }

  // ==========================================================================
  // Instellingenvenster
  // ==========================================================================
  function opendInstellingen() {
    $("#i-sleutel").value = instellingen.sleutel;
    $("#i-model").value = instellingen.model;
    $("#i-categorie").value = instellingen.categorie;
    $("#test-uitslag").textContent = "";
    $("#dlg-instellingen").showModal();
  }

  function bewaarInstellingen() {
    instellingen = {
      sleutel: $("#i-sleutel").value.trim(),
      model: $("#i-model").value,
      categorie: $("#i-categorie").value,
    };
    Instellingen.schrijf(instellingen);
    werkSleutelWaarschuwingBij();
    $("#dlg-instellingen").close();
    toonMelding("Instellingen bewaard.");
  }

  async function testSleutel() {
    const uitslag = $("#test-uitslag");
    const sleutel = $("#i-sleutel").value.trim();
    if (!sleutel) { uitslag.textContent = "Vul eerst een sleutel in."; return; }
    uitslag.textContent = "Bezig met testen…";
    try {
      const antwoord = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": sleutel,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: $("#i-model").value,
          max_tokens: 16,
          messages: [{ role: "user", content: "Antwoord met het woord ok." }],
        }),
      });
      if (antwoord.ok) {
        uitslag.textContent = "De sleutel werkt.";
      } else {
        const fout = await antwoord.json().catch(() => null);
        uitslag.textContent = "Mislukt: " + (fout?.error?.message || antwoord.status);
      }
    } catch (e) {
      uitslag.textContent = "Geen verbinding met api.anthropic.com.";
    }
  }

  function werkSleutelWaarschuwingBij() {
    $("#geen-sleutel").classList.toggle("hidden", Boolean(instellingen.sleutel));
  }

  // ==========================================================================
  // Opstarten en bedieningselementen koppelen
  // ==========================================================================
  function toonView(naam) {
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("is-active", v.id === "view-" + naam));
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("is-active", t.dataset.view === naam));
    if (naam === "export") werkExportTellingBij();
  }

  function koppelBediening() {
    document.querySelectorAll(".tab").forEach(t =>
      t.addEventListener("click", () => toonView(t.dataset.view)));

    $("#btn-camera").addEventListener("click", () => $("#input-camera").click());
    $("#btn-kiezen").addEventListener("click", () => $("#input-kiezen").click());

    for (const id of ["#input-camera", "#input-kiezen"]) {
      $(id).addEventListener("change", (e) => {
        voegFotosToe(Array.from(e.target.files || []));
        e.target.value = "";
      });
    }

    $("#btn-instellingen").addEventListener("click", opendInstellingen);
    $("#link-instellingen").addEventListener("click", opendInstellingen);
    $("#btn-instellingen-bewaar").addEventListener("click", bewaarInstellingen);
    $("#btn-test").addEventListener("click", testSleutel);

    $("#zoek").addEventListener("input", tekenBonnen);
    $("#filter-controleren").addEventListener("change", tekenBonnen);

    $("#btn-bewaar").addEventListener("click", bewaarBewerking);
    $("#btn-verwijder").addEventListener("click", verwijderHuidigeBon);
    $("#btn-heranalyse").addEventListener("click", heranalyseer);
    $("#btn-btw-regel").addEventListener("click", () => voegBtwRegelToe());

    $("#export-van").addEventListener("change", werkExportTellingBij);
    $("#export-tot").addEventListener("change", werkExportTellingBij);
    $("#btn-xlsx").addEventListener("click", exporteerXlsx);
    $("#btn-csv").addEventListener("click", exporteerCsv);
    $("#btn-backup").addEventListener("click", maakBackup);
    $("#btn-herstel").addEventListener("click", () => $("#input-herstel").click());
    $("#input-herstel").addEventListener("change", (e) => {
      if (e.target.files[0]) zetBackupTerug(e.target.files[0]);
      e.target.value = "";
    });

    $("#dlg-bon").addEventListener("close", () => {
      if (dialoogFotoUrl) { URL.revokeObjectURL(dialoogFotoUrl); dialoogFotoUrl = null; }
    });
  }

  async function start() {
    koppelBediening();
    werkSleutelWaarschuwingBij();
    try {
      bonnen = (await Opslag.alleBonnen()) || [];
    } catch (e) {
      toonMelding("De opslag van dit toestel is niet beschikbaar.");
      bonnen = [];
    }
    sorteer();
    tekenBonnen();
    werkTellingBij();

    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("sw.js").catch(() => { /* offline-modus is optioneel */ });
    }
  }

  document.addEventListener("DOMContentLoaded", start);
})();
