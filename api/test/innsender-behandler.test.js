/**
 * «Innsender» som behandler på et steg (`InnsenderBehandler: true`).
 *
 * Ønsket 11.11.2026: etter et vedtak skal innsenderen selv kunne si om hen vil
 * klage. Adressen fryses inn i `steg.Personer` ved innsending, så alt som
 * leser Personer — tilgang, beslutning, varsling — virker uendret.
 *
 * Testene kjører de ekte funksjonene, og passer på:
 *   - at innsenderen faktisk blir behandler (tilgangsregelen sier ja)
 *   - at en ekstern IKKE legges til, og at grunnen står
 *   - at en ny innsending etter ompuss ikke legger adressen inn to ganger
 *   - at diagnosen teller innsenderen, og advarer når eksterne kan sende inn
 *   - rekkefølgen i lagringen: etter feltreferansene, før skip og reserverolle
 *
 * Kjøres med:  node api/test/innsender-behandler.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { leggTilInnsenderSomBehandler } = require('../src/lib/feltperson');
const { erBehandlerPaaNoeSteg } = require('../src/lib/behandling');
const { diagnoser } = require('../src/lib/skjematype-diagnose');

const sak = (ekstra = {}) => ({
    Skjematype_id: '70', Skjema_id: '1', Skjema_status: 2,
    Innsender_Epost: 'Kari@JCCodevel.onmicrosoft.com',
    Behandling: [
        { Steg: 1, Stegnavn: 'Vedtak', Personer: ['saksbehandler@jccodevel.onmicrosoft.com'], Roller: [], Team: [], Beslutning: 0 },
        { Steg: 2, Stegnavn: 'Klage?', Personer: [], Roller: [], Team: [], AvhengigAv: 1, InnsenderBehandler: true, Beslutning: 0 }
    ],
    ...ekstra
});

(async () => {
    // ---------- 1. innlogget innsender blir behandler ----------
    {
        const s = sak();
        const ut = leggTilInnsenderSomBehandler(s);
        sjekk('steg 2 fikk innsenderen', s.Behandling[1].Personer, ['kari@jccodevel.onmicrosoft.com']);
        sjekk('steg 1 er urørt', s.Behandling[0].Personer, ['saksbehandler@jccodevel.onmicrosoft.com']);
        sjekk('rapporten sier det', ut, [{ steg: 2, innsender: 'kari@jccodevel.onmicrosoft.com', lagtTil: true }]);
        // Den ekte tilgangsregelen — den som bestemmer om hen slipper inn.
        sjekk('tilgangsregelen godtar innsenderen', await erBehandlerPaaNoeSteg(s, 'kari@jccodevel.onmicrosoft.com'), true);

        // Ny innsending etter ompuss: samme steg, kjøres på nytt.
        leggTilInnsenderSomBehandler(s);
        sjekk('ingen dobbel adresse ved ny innsending', s.Behandling[1].Personer, ['kari@jccodevel.onmicrosoft.com']);
    }

    // ---------- 2. andre behandlere på samme steg blir stående ----------
    {
        const s = sak();
        s.Behandling[1].Personer = ['juridisk@jccodevel.onmicrosoft.com'];
        leggTilInnsenderSomBehandler(s);
        sjekk('innsenderen kommer i tillegg', s.Behandling[1].Personer,
            ['juridisk@jccodevel.onmicrosoft.com', 'kari@jccodevel.onmicrosoft.com']);
    }

    // ---------- 3. eksterne legges ikke til, og grunnen står ----------
    for (const [navn, merke] of [['OTP', { EksternInnsender: true }], ['utsending', { Utsending_BatchId: 'b1' }]]) {
        const s = sak({ Innsender_Epost: 'ola@example.no', ...merke });
        const ut = leggTilInnsenderSomBehandler(s);
        sjekk(`${navn}: ikke lagt til`, s.Behandling[1].Personer, []);
        sjekk(`${navn}: grunnen står`, ut[0].lagtTil === false && /ekstern/.test(ut[0].grunn), true);
        sjekk(`${navn}: og hen er ikke behandler`, await erBehandlerPaaNoeSteg(s, 'ola@example.no'), false);
    }
    {
        const s = sak({ Innsender_Epost: '' });
        sjekk('uten innsender: meldes', leggTilInnsenderSomBehandler(s)[0].grunn, 'skjemaet har ingen innsender');
    }

    // ---------- 4. diagnosen ----------
    const def = (ekstra = {}, steg2 = {}) => ({
        Skjematype_id: '70', Seksjoner: [], ...ekstra,
        Behandling: [
            { Steg: 1, Personer: ['saksbehandler@jccodevel.onmicrosoft.com'], Roller: [], Team: [] },
            { Steg: 2, Personer: [], Roller: [], Team: [], AvhengigAv: 1, InnsenderBehandler: true, ...steg2 }
        ]
    });
    const koder = async (d) => (await diagnoser(d, { antallInnehavere: async () => 1 })).funn
        .filter(f => /^steg\.(ingen-behandlere|innsender-ekstern)$/.test(f.kode))
        .map(f => `${f.kode}:${f.alvor}`);
    sjekk('innsenderen alene er nok', await koder(def()), []);
    sjekk('uten innsender og uten andre: feil', await koder(def({}, { InnsenderBehandler: false })), ['steg.ingen-behandlere:feil']);
    sjekk('eksterne + innsender alene: feil', await koder(def({ EksternTilgang: true })), ['steg.innsender-ekstern:feil']);
    sjekk('eksterne + andre behandlere: advarsel',
        await koder(def({ EksternTilgang: true }, { Personer: ['juridisk@jccodevel.onmicrosoft.com'] })),
        ['steg.innsender-ekstern:advarsel']);

    // ---------- 5. rekkefølgen i lagringen ----------
    {
        const kilde = fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'skjemaer.js'), 'utf8');
        const iFelt = kilde.indexOf('feltperson.ekspanderBehandlingPersoner(skjemaData)');
        const iInnsender = kilde.indexOf('feltperson.leggTilInnsenderSomBehandler(skjemaData)');
        const iSkip = kilde.indexOf('skipStegSomIkkeSkalKjore(skjemaData)');
        const iReserve = kilde.indexOf('dynamiskRolle.sikreBehandler(skjemaData');
        sjekk('lagringen kaller den', iInnsender > 0, true);
        sjekk('etter feltreferansene', iInnsender > iFelt, true);
        sjekk('før skip-logikken og reserverollen', iInnsender < iSkip && iInnsender < iReserve, true);
        // Inne i innsendingsblokka, ikke ved hver mellomlagring.
        const blokk = kilde.lastIndexOf('if (erInnsending && Array.isArray(skjemaData.Behandling))', iInnsender);
        sjekk('bare ved innsending', blokk > iFelt - 2000 && blokk < iInnsender, true);
    }

    // ---------- 6. editoren ----------
    {
        const ed = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'editor.html'), 'utf8');
        sjekk('avkrysningen finnes', /onchange="setStegInnsenderBehandler\(\$\{idx\}, this\.checked\)"/.test(ed), true);
        sjekk('og leser feltet', /steg\.InnsenderBehandler === true \? 'checked'/.test(ed), true);
        sjekk('setteren lagrer true eller fjerner feltet',
            /if \(v\) data\.Behandling\[idx\]\.InnsenderBehandler = true;\s*else delete data\.Behandling\[idx\]\.InnsenderBehandler;/.test(ed), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
