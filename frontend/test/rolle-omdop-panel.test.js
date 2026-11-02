/**
 * Forhåndsvisningen av en omdøping i rolleadmin (omdopPlanHtml i admin.html).
 *
 * Planen lages av den EKTE kjøringen i api/src/lib/rolle-omdoping-kjoring.js,
 * mot stubbet lagring, og gis til den ekte funksjonen klippet ut av
 * admin.html. Ellers kunne panelet lest et feltnavn API-et ikke har — og vist
 * «0 saker» for en omdøping som flytter femti.
 *
 * Kjøres med:  node frontend/test/rolle-omdop-panel.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const kilde = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const start = kilde.indexOf('function omdopPlanHtml(');
if (start === -1) { console.log('FEIL  fant ikke omdopPlanHtml'); process.exit(1); }
const slutt = kilde.indexOf('\n        }\n', start) + '\n        }'.length;
const { escapeHtml } = require('../js/escape.js');
const omdopPlanHtml = new Function('escHtml', `${kilde.slice(start, slutt)}\nreturn omdopPlanHtml;`)(escapeHtml);

const { kjorOmdoping } = require('../../api/src/lib/rolle-omdoping-kjoring');

/** Stubbet lagring med valgfri ondsinnet tekst i navnene. */
function deps({ navn = 'Permisjon', team = 'Klasse 1' } = {}) {
    return {
        roller: {
            hentAlle: async () => [
                { Rolle: 'Klassesjef', Omfang: 'MILM23-1', UPN: 'a@mil.no', Kilde: 'manuell' },
                { Rolle: 'Klassesjef', Omfang: 'MILM23-1A', UPN: 'a@mil.no', Kilde: 'manuell' }
            ],
            utforBatch: async () => ({})
        },
        grupper: {
            hentAlle: async () => [
                { Rolle: 'Klassesjef', Omfang: 'MILM23-1', Team: team, EierRolle: '' },
                { Rolle: 'Klassesjef', Omfang: 'MILM23-1A', Team: 'Annet', EierRolle: '' }
            ],
            skrivGruppe: async () => {}, slettGruppe: async () => {}
        },
        skjematyper: {
            hentAlleSkjematyper: async () => [{ id: '12', navn, JSON: { Skjematype_id: '12', Eiere: { Roller: ['Klassesjef(MILM23-1)'] } } }],
            lagreSkjematype: async () => {}
        },
        rapporter: { hentAlleRapporttyper: async () => [], lagreRapporttype: async () => {} },
        saker: {
            hentAlleSkjemaerForType: async () => [
                { Skjema_id: '12-1', Skjematype_id: '12', Skjema_status: 2, Behandling: [{ Roller: ['Klassesjef(MILM23-1)'] }] },
                { Skjema_id: '12-2', Skjematype_id: '12', Skjema_status: 5, Behandling: [{ Roller: ['Klassesjef(MILM23-1)'] }] }
            ],
            erstattJson: async () => {}
        },
        nokler: { hentNokkel: async () => null },
        kryptering: require('../../api/src/lib/kryptering')
    };
}

const OP = { type: 'omfang', rolle: 'Klassesjef', fra: 'MILM23-1', til: 'MILM23-1A' };
const tekst = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
    // ---------- 1. tallene fra den ekte planen ----------
    {
        const plan = await kjorOmdoping(OP, { deps: deps() });
        const t = tekst(omdopPlanHtml(plan));
        sjekk('viser fra og til', t.includes('«Klassesjef(MILM23-1)» → «Klassesjef(MILM23-1A)»'), true);
        sjekk('medlemskap', /1 medlemskap flyttes/.test(t), true);
        sjekk('og at personen sto i målet fra før', /1 sto allerede i/.test(t), true);
        sjekk('skjematyper med navn', /1 skjematype: Permisjon/.test(t), true);
        sjekk('saker under behandling og avsluttet', /1 sak under behandling og 1 avsluttet/.test(t), true);
        sjekk('målet finnes fra før: sammenslåing', /finnes fra før\. Medlemmene slås sammen/.test(t), true);
        sjekk('ulikt team: konflikt vises', /beholder sitt oppsett \(team «Annet»\)/.test(t), true);
        sjekk('begrensningen står', /fjernet rollen etter at saker ble sendt inn/.test(t), true);
    }

    // ---------- 2. ingenting å endre ----------
    {
        const plan = await kjorOmdoping({ type: 'navn', fra: 'Finnesikke', til: 'Ny' }, { deps: deps() });
        sjekk('ingenting å endre sies rett ut', /Ingenting å endre/.test(omdopPlanHtml(plan)), true);
    }

    // ---------- 3. tekst fra lagring escapes ----------
    {
        const ond = '<img src=x onerror=alert(1)>';
        const plan = await kjorOmdoping(OP, { deps: deps({ navn: ond, team: ond }) });
        const html = omdopPlanHtml(plan);
        sjekk('skjematypenavn og teamnavn escapes', html.includes('<img'), false);
    }

    // ---------- 4. panelet kaller ruta via startJobb ----------
    {
        sjekk('forhåndsvisning via startJobb', /startJobb\('\/api\/roller\/omdop', body\)/.test(kilde), true);
        sjekk('utførelse sender bekreft', /startJobb\('\/api\/roller\/omdop', \{ \.\.\.body, bekreft: true \}\)/.test(kilde), true);
        sjekk('knappen står ved Slett rollen', /onclick="rollerVisOmdop\(\)"/.test(kilde), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message); console.log(e.stack); process.exit(1); });
