/* Minimale XLSX-schrijver: bouwt een geldig .xlsx-bestand zonder externe bibliotheek.
   Ondersteunt tekst, getallen, bedragen en datums met de juiste celopmaak. */
(function (global) {
  "use strict";

  const enc = new TextEncoder();

  // ---------- CRC32 ----------
  const crcTabel = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTabel[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- ZIP (opslagmethode, geen compressie) ----------
  function dosTijd(d) {
    const tijd = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const datum = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { tijd, datum };
  }

  function zip(bestanden) {
    const { tijd, datum } = dosTijd(new Date());
    const stukken = [];
    const centraal = [];
    let offset = 0;

    for (const b of bestanden) {
      const naam = enc.encode(b.naam);
      const data = b.data;
      const crc = crc32(data);

      const lokaal = new Uint8Array(30 + naam.length);
      const lv = new DataView(lokaal.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);          // versie
      lv.setUint16(6, 0x0800, true);      // vlag: UTF-8 bestandsnamen
      lv.setUint16(8, 0, true);           // methode 0 = opslaan
      lv.setUint16(10, tijd, true);
      lv.setUint16(12, datum, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, naam.length, true);
      lv.setUint16(28, 0, true);
      lokaal.set(naam, 30);

      stukken.push(lokaal, data);

      const cd = new Uint8Array(46 + naam.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, tijd, true);
      cv.setUint16(14, datum, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, naam.length, true);
      cv.setUint32(42, offset, true);
      cd.set(naam, 46);
      centraal.push(cd);

      offset += lokaal.length + data.length;
    }

    const cdStart = offset;
    let cdLengte = 0;
    for (const c of centraal) cdLengte += c.length;

    const eind = new Uint8Array(22);
    const ev = new DataView(eind.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, centraal.length, true);
    ev.setUint16(10, centraal.length, true);
    ev.setUint32(12, cdLengte, true);
    ev.setUint32(16, cdStart, true);

    const alles = [...stukken, ...centraal, eind];
    let totaal = 0;
    for (const a of alles) totaal += a.length;
    const uit = new Uint8Array(totaal);
    let p = 0;
    for (const a of alles) { uit.set(a, p); p += a.length; }
    return uit;
  }

  // ---------- XML-hulp ----------
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // verwijder tekens die XML niet toestaat
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  }

  function kolomLetter(n) { // 1 -> A
    let s = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // Excel-serienummer: dagen sinds 1899-12-30
  function datumNaarSerie(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return null;
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return Math.round((d - Date.UTC(1899, 11, 30)) / 86400000);
  }

  const STIJL = { tekst: 0, kop: 1, datum: 2, geld: 3 };

  /**
   * @param {string[]} kopregel
   * @param {Array<Array<{v:any, t:'tekst'|'num'|'geld'|'datum'}>>} rijen
   * @param {{naam?:string, breedtes?:number[]}} opties
   * @returns {Blob}
   */
  function maakWerkboek(kopregel, rijen, opties) {
    opties = opties || {};
    const bladnaam = (opties.naam || "Blad1").replace(/[\\\/\?\*\[\]:]/g, "").slice(0, 31);

    const xmlRijen = [];

    // kopregel
    let cellen = kopregel.map((k, i) =>
      `<c r="${kolomLetter(i + 1)}1" s="${STIJL.kop}" t="inlineStr"><is><t>${esc(k)}</t></is></c>`
    ).join("");
    xmlRijen.push(`<row r="1">${cellen}</row>`);

    rijen.forEach((rij, ri) => {
      const r = ri + 2;
      cellen = rij.map((cel, ci) => {
        const ref = `${kolomLetter(ci + 1)}${r}`;
        if (cel == null || cel.v == null || cel.v === "") return "";
        if (cel.t === "datum") {
          const serie = datumNaarSerie(cel.v);
          if (serie == null) return `<c r="${ref}" t="inlineStr"><is><t>${esc(cel.v)}</t></is></c>`;
          return `<c r="${ref}" s="${STIJL.datum}"><v>${serie}</v></c>`;
        }
        if (cel.t === "geld" || cel.t === "num") {
          const getal = Number(cel.v);
          if (!Number.isFinite(getal)) return "";
          const s = cel.t === "geld" ? STIJL.geld : STIJL.tekst;
          return `<c r="${ref}" s="${s}"><v>${getal}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t>${esc(cel.v)}</t></is></c>`;
      }).join("");
      xmlRijen.push(`<row r="${r}">${cellen}</row>`);
    });

    const breedtes = opties.breedtes || [];
    const cols = breedtes.length
      ? `<cols>${breedtes.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
      : "";

    const laatsteKolom = kolomLetter(kopregel.length);
    const laatsteRij = rijen.length + 1;

    const sheet =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetViews><sheetView workbookViewId="0" tabSelected="1">` +
      `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
      `</sheetView></sheetViews>` +
      cols +
      `<sheetData>${xmlRijen.join("")}</sheetData>` +
      `<autoFilter ref="A1:${laatsteKolom}${laatsteRij}"/>` +
      `</worksheet>`;

    const contentTypes =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`;

    const rels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`;

    const workbook =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${esc(bladnaam)}" sheetId="1" r:id="rId1"/></sheets>` +
      `</workbook>`;

    const workbookRels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`;

    const styles =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="2">` +
      `<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>` +
      `<numFmt numFmtId="165" formatCode="#,##0.00"/>` +
      `</numFmts>` +
      `<fonts count="2">` +
      `<font><sz val="11"/><name val="Calibri"/></font>` +
      `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
      `</fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
      `<fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="4">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`;

    const bytes = zip([
      { naam: "[Content_Types].xml", data: enc.encode(contentTypes) },
      { naam: "_rels/.rels", data: enc.encode(rels) },
      { naam: "xl/workbook.xml", data: enc.encode(workbook) },
      { naam: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels) },
      { naam: "xl/styles.xml", data: enc.encode(styles) },
      { naam: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) },
    ]);

    return new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  global.Xlsx = { maakWerkboek, _zip: zip, _crc32: crc32 };
})(window);
