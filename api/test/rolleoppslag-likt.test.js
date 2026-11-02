/**
 * «Rolle(svarverdi)» → innehavere: behandlingssteget og nedtrekket skal svare likt.
 *
 * To kallere slår opp det samme:
 *   - behandlingssteg og varsler: ekspanderRolleStreng → rolleForVerdi
 *     (dynamisk-rolle.js). Strengen som fryses i saken slås senere opp
 *     eksakt av tilgang og varsling.
 *   - datakilden Personer med filteret Rolle (oppslag.js,
 *     hentInnehavereForRolle) — nedtrekkslister over f.eks. klassesjefer.
 *
 * Fram til 03.11.2026 hadde oppslag.js sin egen løkke over omfangsaliasene,
 * uten tilbakefallet på store og små bokstaver som behandlingssteget fikk
 * samme dag. Nedtrekket over klassesjefer for «TESTKLASSE» var tomt, mens
 * behandlingssteget fant klassesjefen lagret som «Testklasse».
 *
 * Testen kjører BEGGE veiene mot samme rolleliste og krever samme personer.
 * Hvert tilfelle har også et fasitsvar, så to veier som tar feil likt ikke
 * blir grønne.
 *
 * Rollelista er den ekte roller-storage.js over en stubbet tabell som skiller
 * på store og små bokstaver, slik Table Storage gjør — ikke en oppfunnet
 * hentInnehavere. Bare omfang.js (FS-metadata) er stubbet via Module._load.
 *
 * Kjøres med:  node api/test/rolleoppslag-likt.test.js
 */
const Module = require('module');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- rollelista: ekte roller-storage over stubbet tabell ----------

let RADER = [];
let NEDE = false;
const storage = require('../src/lib/storage');
storage.odata = (deler, ...verdier) =>
    deler.reduce((ut, d, i) => ut + d + (i < verdier.length ? `'${verdier[i]}'` : ''), '');
storage.sikreTabell = async () => ({
    listEntities({ queryOptions }) {
        if (NEDE) throw new Error('rollelista svarer ikke');
        const f = queryOptions.filter;
        const pk = /PartitionKey eq '([^']*)'/.exec(f)?.[1];
        const fra = /RowKey ge '([^']*)'/.exec(f)?.[1];
        const til = /RowKey lt '([^']*)'/.exec(f)?.[1];
        // Strengsammenligning skiller på store og små bokstaver — som Table Storage.
        const treff = RADER.filter(r =>
            r.partitionKey === pk && (fra === undefined || (r.rowKey >= fra && r.rowKey < til)));
        return (async function* () { for (const r of treff) yield r; })();
    }
});
const rad = (rolle, omfang, upn) => ({ partitionKey: rolle, rowKey: `${omfang}|${upn}`, EP: upn });

// ---------- omfangsalias: FS-nøkkel → [nøkkel, klassenavn, klassekode] ----------

const ALIAS = { 'FHSBA|22H|A': ['FHSBA|22H|A', 'KS Kull Rønneberg 22-25', 'A'] };

const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === './omfang') return { hentOmfangsalias: async (v) => ALIAS[String(v)] || [String(v)] };
    return origLoad.apply(this, [req, ...rest]);
};
const dyn = require('../src/lib/dynamisk-rolle');
const oppslag = require('../src/lib/oppslag');
Module._load = origLoad;
const rollerStorage = require('../src/lib/roller-storage');

const seksjoner = (svar) => ([
    { Nummer: 2, Felter: [{ Nummer: '01', Type: 'Dropdown', Svar: svar }] }
]);

/** Behandlingsveien: ekspander malen, slå opp den frosne strengen eksakt. */
async function viaBehandling(verdi) {
    const { roller } = await dyn.ekspanderRolleStreng('Klassesjef({2-01})', seksjoner([verdi]));
    const ut = [];
    for (const r of roller) for (const i of await rollerStorage.hentInnehavere(r)) ut.push(i.EP);
    return ut.sort();
}

/** Nedtrekksveien: datakilden Personer med filteret Rolle. */
async function viaNedtrekk(verdi) {
    const rader = await oppslag.hentDropdownVerdier('Personer', 'Rolle', '=', `Klassesjef(${verdi})`);
    return rader.map(r => r.Verdi).sort();
}

const TILFELLER = [
    {
        navn: 'eksakt skrivemåte',
        rader: [rad('Klassesjef', 'Testklasse', 'ks@fhs.no')],
        verdi: 'Testklasse', fasit: ['ks@fhs.no']
    },
    {
        navn: 'ulik skrivemåte: «TESTKLASSE» mot lagret «Testklasse»',
        rader: [rad('Klassesjef', 'Testklasse', 'ks@fhs.no'), rad('Klassesjef', 'Annen', 'x@fhs.no')],
        verdi: 'TESTKLASSE', fasit: ['ks@fhs.no']
    },
    {
        navn: 'eksakt vinner over ulik skrivemåte',
        rader: [rad('Klassesjef', 'TESTKLASSE', 'eksakt@fhs.no'), rad('Klassesjef', 'Testklasse', 'ks@fhs.no')],
        verdi: 'TESTKLASSE', fasit: ['eksakt@fhs.no']
    },
    {
        navn: 'FS-nøkkel finner klassenavnet',
        rader: [rad('Klassesjef', 'KS Kull Rønneberg 22-25', 'ks@fhs.no')],
        verdi: 'FHSBA|22H|A', fasit: ['ks@fhs.no']
    },
    {
        navn: 'FS-nøkkel finner klassenavnet med ulik skrivemåte',
        rader: [rad('Klassesjef', 'ks kull rønneberg 22-25', 'ks@fhs.no')],
        verdi: 'FHSBA|22H|A', fasit: ['ks@fhs.no']
    },
    {
        navn: 'mer spesifikk aliasform vinner',
        rader: [rad('Klassesjef', 'FHSBA|22H|A', 'nokkel@fhs.no'), rad('Klassesjef', 'A', 'kode@fhs.no')],
        verdi: 'FHSBA|22H|A', fasit: ['nokkel@fhs.no']
    },
    {
        navn: 'lengre omfang med likt prefiks treffer ikke',
        rader: [rad('Klassesjef', 'Testklasse2', 'ks@fhs.no')],
        verdi: 'TESTKLASSE', fasit: []
    },
    {
        navn: 'annen rolle med samme omfang treffer ikke',
        rader: [rad('Bransjeveileder', 'TESTKLASSE', 'bv@fhs.no')],
        verdi: 'TESTKLASSE', fasit: []
    }
];

(async () => {
    for (const t of TILFELLER) {
        RADER = t.rader;
        const b = await viaBehandling(t.verdi);
        const n = await viaNedtrekk(t.verdi);
        sjekk(`${t.navn}: nedtrekket svarer som behandlingssteget`, n, b);
        sjekk(`${t.navn}: behandlingssteget gir fasit`, b, t.fasit);
    }

    // ---------- rollelista svarer ikke: nedtrekket skal ikke bli stille tomt ----------
    {
        RADER = [rad('Klassesjef', 'Testklasse', 'ks@fhs.no')];
        NEDE = true;
        let kastet = null;
        try { await viaNedtrekk('Testklasse'); } catch (e) { kastet = e.message; }
        sjekk('oppslagsfeil når nedtrekket, i stedet for en tom liste', kastet, 'rollelista svarer ikke');
        NEDE = false;
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})();
