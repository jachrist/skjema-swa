/**
 * Tester for hvem som kan kjøre en rapport.
 *
 * Bakgrunn: rapportene var låst til admin/Skjemaskaper mens funksjonaliteten
 * var i Utvikling-fase. Da lokket ble tatt av — slik at eiere kan videreutvikle
 * sine egne rapporter uten rollen — ble det fase-filteret som står igjen som
 * eneste vern mot at publikum kjører en uferdig rapport.
 *
 * Uten det ville en rapport under utvikling vært skjult i oversikten, men fullt
 * kjørbar for den som kjente ID-en. Det er en dårlig kombinasjon: usynlig, men
 * åpen.
 *
 * Kjøres med:  node api/test/rapport-tilgang.test.js
 */
// Handleren importerer @azure/functions for å registrere ruta. Deploy kjører
// testene uten node_modules, så der hoppes denne over; CI kjører npm ci først
// og dekker den. Samme mønster som zip-testen i backup-strom.test.js.
let _harTilgang = null;
try { ({ _harTilgang } = require('../src/functions/rapport-kjor')); } catch (_) { /* hoppes over */ }

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rapport = (fase) => ({ id: '7', JSON: { Rapport_navn: 'Test', Fase: fase } });

/** Stub som svarer på hvilken tilgangsrolle brukeren har. */
function deps({ admin = false, eier = false, publikum = false } = {}) {
    return {
        erAdmin: () => admin,
        filtrerTyperPåTilgang: async (typer, _upn, rolle) => {
            if (rolle === 'Eiere') return eier ? typer : [];
            if (rolle === 'Publikum') return publikum ? typer : [];
            return [];
        }
    };
}

async function kjor() {
    if (!_harTilgang) {
        console.log('(hopper over — @azure/functions ikke installert)');
        console.log('\n0 OK, 0 feil, 1 hoppet over');
        process.exit(0);
    }

    // ---------- produksjon ----------
    {
        const r = rapport('Produksjon');
        sjekk('admin slipper til', (await _harTilgang(r, 'a@x', deps({ admin: true }))).ok, true);
        sjekk('eier slipper til', (await _harTilgang(r, 'a@x', deps({ eier: true }))).ok, true);
        sjekk('publikum slipper til', (await _harTilgang(r, 'a@x', deps({ publikum: true }))).ok, true);
        sjekk('uten tilgang avvises', (await _harTilgang(r, 'a@x', deps())).ok, false);
    }

    // ---------- utvikling ----------
    {
        const r = rapport('Utvikling');
        sjekk('eier kan kjøre sin egen under utvikling',
            (await _harTilgang(r, 'a@x', deps({ eier: true }))).ok, true);
        sjekk('admin kan kjøre under utvikling',
            (await _harTilgang(r, 'a@x', deps({ admin: true }))).ok, true);
        // Kjernen: usynlig i lista SKAL bety utilgjengelig, ikke bare uoppdaget.
        sjekk('publikum avvises under utvikling',
            (await _harTilgang(r, 'a@x', deps({ publikum: true }))).ok, false);
        sjekk('uten tilgang avvises også', (await _harTilgang(r, 'a@x', deps())).ok, false);
    }

    // ---------- eier slår publikum ----------
    {
        const r = rapport('Utvikling');
        const res = await _harTilgang(r, 'a@x', deps({ eier: true, publikum: true }));
        sjekk('eier under utvikling er fortsatt eier', res, { ok: true, erEier: true });
    }

    // ---------- manglende fase ----------
    {
        // Eldre rapporttyper har ingen Fase. De skal behandles som Produksjon,
        // ikke som utilgjengelige.
        const utenFase = { id: '7', JSON: { Rapport_navn: 'Gammel' } };
        sjekk('rapport uten fase regnes som produksjon',
            (await _harTilgang(utenFase, 'a@x', deps({ publikum: true }))).ok, true);
        sjekk('helt tomt objekt velter ingenting',
            (await _harTilgang({}, 'a@x', deps({ publikum: true }))).ok, true);
    }

    // ---------- erEier-flagget ----------
    {
        // Flagget styrer om rollebaserte filtre skal slå inn ved kjøring.
        const r = rapport('Produksjon');
        sjekk('publikum er ikke eier',
            (await _harTilgang(r, 'a@x', deps({ publikum: true }))).erEier, false);
        sjekk('eier er eier',
            (await _harTilgang(r, 'a@x', deps({ eier: true }))).erEier, true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
