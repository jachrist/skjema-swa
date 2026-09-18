/**
 * Interne dialog-innlegg skal ikke ut til innsender — i NOEN kanal.
 *
 * Funnet 18.09.2026, i produksjon: `GET /api/skjemaer/{type}/{id}` filtrerte
 * bort interne innlegg for innsender, men `.../pdf` gjorde det ikke. Den
 * hentet samme skjema, dekrypterte det og sendte det uavkortet til
 * `pdf-generator.js`, som skriver en egen «Intern dialog»-seksjon. Innsender
 * har tilgang til PDF-en for sin egen sak.
 *
 * Behandlernes interne drøfting var altså skjult i grensesnittet og utlevert
 * i PDF-en — og det at lesestien filtrerte er nettopp beviset på at den ikke
 * skulle det.
 *
 * Det var ikke to regler som var uenige. Det var én regel som bare fantes ett
 * av stedene. Derfor tester denne fila både regelen og at begge stiene kaller
 * den: en regel som finnes ett sted, men kalles fra ett av to, er like ille.
 *
 * Kjøres med:  node api/test/dialog-tilgang.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const { tilgangsRolle, skjulInterneInnlegg } = require('../src/lib/dialog-tilgang');

const DIALOG = [
    { Type: 'ekstern', Tekst: 'Vi trenger et vedlegg til', Avsender: 'kari@fhs.no' },
    { Type: 'intern', Tekst: 'Denne søknaden er tynn', Avsender: 'ola@fhs.no' },
    { Type: 'ekstern', Tekst: 'Takk, mottatt', Avsender: 'per@fhs.no' }
];
const skjemaMed = (dialog) => ({ Innsender_Epost: 'per@fhs.no', Dialog: JSON.parse(JSON.stringify(dialog)) });

// ---------- hvem ser hva ----------
{
    const forInnsender = skjulInterneInnlegg(skjemaMed(DIALOG), 'innsender');
    sjekk('innsender ser bare eksterne', forInnsender.Dialog.map(d => d.Type), ['ekstern', 'ekstern']);
    sjekk('teksten er faktisk borte',
        JSON.stringify(forInnsender.Dialog).includes('tynn'), false);

    for (const rolle of ['behandler', 'eier', 'admin']) {
        sjekk(`${rolle} ser alt`, skjulInterneInnlegg(skjemaMed(DIALOG), rolle).Dialog.length, 3);
    }

    // Ukjent rolle skal ikke gi MER enn innsender. Slipper noen forbi
    // tilgangssjekken uten en rolle vi kjenner, er det ikke da de skal få se
    // den interne drøftingen.
    sjekk('ukjent rolle behandles som innsender',
        skjulInterneInnlegg(skjemaMed(DIALOG), null).Dialog.map(d => d.Type), ['ekstern', 'ekstern']);
    sjekk('tom rolle likeså',
        skjulInterneInnlegg(skjemaMed(DIALOG), '').Dialog.map(d => d.Type), ['ekstern', 'ekstern']);
}

// ---------- det gamle feltnavnet ----------
{
    // PDF-generatoren leser `Type || DialogType`. Finnes den gamle formen i
    // data, må filteret kjenne den — ellers slipper innlegget gjennom her og
    // skrives ut som intern der.
    const gammel = skjulInterneInnlegg(
        { Dialog: [{ DialogType: 'intern', Tekst: 'gammelt format' }, { DialogType: 'ekstern', Tekst: 'ok' }] },
        'innsender');
    sjekk('DialogType filtreres også', gammel.Dialog.length, 1);
    sjekk('og det er det eksterne som står igjen', gammel.Dialog[0].Tekst, 'ok');
}

// ---------- ingenting å filtrere ----------
{
    sjekk('uten dialog', skjulInterneInnlegg({ Skjema_id: '1' }, 'innsender').Skjema_id, '1');
    sjekk('tom dialog', skjulInterneInnlegg({ Dialog: [] }, 'innsender').Dialog, []);
    sjekk('bare interne gir tom liste',
        skjulInterneInnlegg({ Dialog: [{ Type: 'intern' }] }, 'innsender').Dialog, []);
}

// ---------- rollen ----------
{
    const før = process.env.ADMIN_UPNS;
    process.env.ADMIN_UPNS = 'sjef@fhs.no';
    try {
        // Begge disse svarer før tabelloppslagene, så de kan testes uten pakker.
        (async () => {
            sjekk('admin', await tilgangsRolle({ Innsender_Epost: 'per@fhs.no' }, 't1', 'sjef@fhs.no'), 'admin');
            sjekk('innsender', await tilgangsRolle({ Innsender_Epost: 'per@fhs.no' }, 't1', 'per@fhs.no'), 'innsender');
            sjekk('innsender uansett skrivemåte',
                await tilgangsRolle({ Innsender_Epost: 'Per@FHS.no' }, 't1', 'per@fhs.no'), 'innsender');
            sjekk('ingen upn', await tilgangsRolle({}, 't1', null), null);

            // Innsender sjekkes FØR eier og behandler. Er man begge deler,
            // regnes man som innsender og ser mindre — riktig vei å ta feil på.
            //
            // At de tre over svarer i det hele tatt, ER beviset: testen kjører
            // uten lagringskonto, så et oppslag mot Skjemadefinisjoner ville
            // kastet. Flyttes innsender-sjekken ned under eier-oppslaget,
            // faller de med en gang.

            avslutt();
        })();
    } finally {
        if (før === undefined) delete process.env.ADMIN_UPNS; else process.env.ADMIN_UPNS = før;
    }
}

// ---------- begge stiene kaller regelen ----------
function avslutt() {
    const les = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', f), 'utf8');

    // Se etter selve KALLET, ikke etter ordet.
    //
    // Første utgave av denne testen sjekket `kilde.includes('skjulInterneInnlegg')`
    // — og besto da kallet ble fjernet, fordi navnet fortsatt sto i en
    // kommentar i samme fil. En test som grønnes av sin egen dokumentasjon er
    // verre enn ingen test: den sier at noe er dekket.
    const KALL = /dialogTilgang\.skjulInterneInnlegg\(/;

    for (const fil of ['pdf.js', 'skjemaer.js']) {
        const kilde = les(fil);
        sjekk(`${fil}: kaller skjulInterneInnlegg`, KALL.test(kilde), true);
        sjekk(`${fil}: har ingen egen kopi av filteret`,
            /Dialog\.filter\([^)]*intern/.test(kilde), false);
    }

    // Filtreringen må skje FØR PDF-en bygges. Etterpå er innlegget allerede
    // tegnet inn på siden.
    const pdf = les('pdf.js');
    sjekk('pdf.js filtrerer før generatoren kalles',
        pdf.search(KALL) < pdf.indexOf('genererOppsummeringPdf(skjema'), true);

    // Samme fil, annen stille feil: `const skjema` med en tilordning under ga
    // «Assignment to constant variable», som catch-en svelget og logget som en
    // dekrypteringsfeil. PDF-en ble laget likevel — med [Kryptert] i hvert
    // felt, og status 200.
    sjekk('pdf.js: skjema kan tilordnes på nytt', /\blet skjema = await forekomstStorage/.test(pdf), true);

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}
