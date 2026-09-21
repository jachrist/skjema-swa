/**
 * Hvem slipper inn i samtalen, og når er den åpen.
 *
 * Samtalen er en gruppechat uten interne innlegg, så det finnes bare ett
 * tilgangsspørsmål: er du deltaker eller ikke. Til gjengjeld må det svaret
 * være riktig — alt en deltaker skriver, ser alle de andre.
 *
 * Fire ting testes, og tre av dem feiler stille hvis de er gale:
 *
 *   **Et eksternt token gjelder én sak.** Et gyldig OTP-token binder en
 *   identitet, ikke et skjema. Uten en match mot sakens Innsender_Epost ville
 *   en ekstern bruker med et gyldig token kommet inn i andres samtaler — og
 *   den som skrev der ville ikke sett noen forskjell.
 *
 *   **Ukjent status lukker.** Dukker det opp en ny statuskode, skal den ikke
 *   åpne en samtale ved et uhell.
 *
 *   **Innsender kan ikke dempe seg selv.** En innsender som demper og siden
 *   lurer på hvorfor ingen svarte, er verre enn ett varsel for mye.
 *
 *   **Mellomlagret er ikke åpent.** Skjemaet er ikke sendt inn, så det finnes
 *   ingen behandler å snakke med.
 *
 * Kjøres med:  node api/test/samtale-tilgang.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const t = require('../src/lib/samtale-tilgang');

// ---------- åpen eller lukket ----------
{
    sjekk('mellomlagret er lukket', t.samtaleErAapen({ Skjema_status: 1 }), false);
    sjekk('under behandling er åpen', t.samtaleErAapen({ Skjema_status: 2 }), true);
    // Til revidering er nettopp når det er mest å snakke om.
    sjekk('til revidering er åpen', t.samtaleErAapen({ Skjema_status: 3 }), true);
    sjekk('avsluttet er lukket', t.samtaleErAapen({ Skjema_status: 5 }), false);

    // En statuskode ingen har tenkt på skal ikke åpne noe.
    sjekk('ukjent status er lukket', t.samtaleErAapen({ Skjema_status: 4 }), false);
    sjekk('uten status', t.samtaleErAapen({}), false);
    sjekk('uten skjema', t.samtaleErAapen(null), false);
    // Status kommer som streng fra enkelte kilder.
    sjekk('status som streng', t.samtaleErAapen({ Skjema_status: '2' }), true);
}

// ---------- ekstern identitet mot sak ----------
{
    const sak = { Innsender_Epost: 'ola@example.no' };
    sjekk('innsenderen selv', t.eksternErInnsender(sak, 'ola@example.no'), true);
    sjekk('skrivemåte spiller ingen rolle', t.eksternErInnsender(sak, 'Ola@Example.NO'), true);

    // Et gyldig token for en ANNEN sak skal ikke slippe inn her.
    sjekk('en annen ekstern', t.eksternErInnsender(sak, 'kari@example.no'), false);
    sjekk('tom identitet', t.eksternErInnsender(sak, ''), false);
    // Et skjema uten innsender skal ikke matche en tom identitet til seg selv.
    sjekk('sak uten innsender', t.eksternErInnsender({}, ''), false);
    sjekk('sak uten innsender, ekte id', t.eksternErInnsender({}, 'ola@example.no'), false);

    sjekk('kompakt feltnavn', t.eksternErInnsender({ Innsender_epost: 'ola@example.no' }, 'ola@example.no'), true);
    // SMS-innsendere er merket med prefiks for å ikke forveksles med e-post.
    sjekk('sms-innsender', t.eksternErInnsender({ Innsender_Epost: 'mobil:99887766' }, 'mobil:99887766'), true);
    sjekk('nummeret alene holder ikke',
        t.eksternErInnsender({ Innsender_Epost: 'mobil:99887766' }, '99887766'), false);
}

// ---------- demping ----------
{
    for (const rolle of ['behandler', 'eier', 'admin']) {
        sjekk(`${rolle} kan dempe`, t.kanDempe(rolle), true);
    }
    sjekk('innsender kan ikke dempe', t.kanDempe('innsender'), false);
    sjekk('ingen rolle kan ikke dempe', t.kanDempe(null), false);
}

// ---------- innstillingen på skjematypen ----------
{
    const medSteg = (samtale) => ({ Behandling: [{ Steg: 1 }], Samtale: samtale });

    sjekk('av', t.samtaleInnstilling(medSteg('Av')), 'Av');
    sjekk('behandlere', t.samtaleInnstilling(medSteg('Behandlere')), 'Behandlere');
    sjekk('alle', t.samtaleInnstilling(medSteg('Alle')), 'Alle');

    // Standard er Av. Skjematypene som allerede ligger i produksjon skal ikke
    // plutselig få en samtaleflate fordi vi rullet ut en ny funksjon.
    sjekk('uten innstilling er den av', t.samtaleInnstilling({ Behandling: [{ Steg: 1 }] }), 'Av');
    sjekk('tom innstilling', t.samtaleInnstilling(medSteg('')), 'Av');
    sjekk('ukjent verdi', t.samtaleInnstilling(medSteg('Kanskje')), 'Av');
    sjekk('uten skjematype', t.samtaleInnstilling(null), 'Av');

    // Uten behandlingssteg finnes det ingen behandler å snakke med, og da er
    // samtalen av uansett hva som står lagret.
    sjekk('uten behandlingssteg', t.samtaleInnstilling({ Samtale: 'Alle' }), 'Av');
    sjekk('tom stegliste', t.samtaleInnstilling({ Behandling: [], Samtale: 'Alle' }), 'Av');
}

// ---------- hvem kan skrive, og hvem kan starte ----------
{
    const kan = (o) => t.kanSkrive({ apen: true, ...o });

    // Av slår alt.
    sjekk('av: behandler kan ikke', kan({ rolle: 'behandler', innstilling: 'Av' }), false);
    sjekk('av: innsender kan ikke', kan({ rolle: 'innsender', innstilling: 'Av' }), false);

    for (const rolle of ['behandler', 'eier', 'admin']) {
        sjekk(`${rolle} kan starte`, kan({ rolle, innstilling: 'Behandlere', antallInnlegg: 0 }), true);
    }

    // Kjernen i spørsmålet: innsender kan svare, men ikke starte.
    sjekk('innsender kan ikke starte under Behandlere',
        kan({ rolle: 'innsender', innstilling: 'Behandlere', antallInnlegg: 0 }), false);
    sjekk('men kan svare når tråden finnes',
        kan({ rolle: 'innsender', innstilling: 'Behandlere', antallInnlegg: 1 }), true);
    sjekk('og kan starte under Alle',
        kan({ rolle: 'innsender', innstilling: 'Alle', antallInnlegg: 0 }), true);

    // En lukket sak er lukket for alle, også behandlere.
    sjekk('lukket sak: behandler kan ikke',
        t.kanSkrive({ rolle: 'behandler', innstilling: 'Alle', antallInnlegg: 3, apen: false }), false);
    sjekk('lukket sak: innsender kan ikke',
        t.kanSkrive({ rolle: 'innsender', innstilling: 'Alle', antallInnlegg: 3, apen: false }), false);

    sjekk('uten rolle', kan({ rolle: null, innstilling: 'Alle' }), false);
}

// ---------- når vises samtalen ----------
{
    const synlig = (o) => t.samtaleErSynlig({ apen: true, ...o });

    // En innsender som verken kan skrive eller har noe å lese, skal ikke se en
    // låst boks. Da lurer hen på hva den er og hvorfor den ikke virker.
    sjekk('innsender, tom tråd, Behandlere → skjult',
        synlig({ rolle: 'innsender', innstilling: 'Behandlere', antallInnlegg: 0 }), false);
    sjekk('innsender, tom tråd, Alle → vises',
        synlig({ rolle: 'innsender', innstilling: 'Alle', antallInnlegg: 0 }), true);
    sjekk('innsender, med innlegg → vises',
        synlig({ rolle: 'innsender', innstilling: 'Behandlere', antallInnlegg: 2 }), true);

    // En lukket samtale med innhold vises fortsatt, for begge parter. Det er
    // hele poenget med at den følger saken.
    sjekk('lukket sak med innlegg vises',
        t.samtaleErSynlig({ rolle: 'innsender', innstilling: 'Behandlere', antallInnlegg: 2, apen: false }), true);
    sjekk('lukket sak uten innlegg vises ikke',
        t.samtaleErSynlig({ rolle: 'behandler', innstilling: 'Alle', antallInnlegg: 0, apen: false }), false);

    sjekk('av vises aldri',
        synlig({ rolle: 'behandler', innstilling: 'Av', antallInnlegg: 5 }), false);
}

// ---------- deltakeren ----------
async function deltakere() {
    const sak = { Innsender_Epost: 'ola@example.no', Skjema_status: 2 };

    const ekstern = await t.finnDeltaker({ skjema: sak, skjematypeId: 't1', eksternId: 'ola@example.no', kilde: 'otp' });
    sjekk('ekstern innsender slipper inn', ekstern.rolle, 'innsender');
    sjekk('kilden følger med', ekstern.kilde, 'otp');
    sjekk('id-en normaliseres',
        (await t.finnDeltaker({ skjema: sak, skjematypeId: 't1', eksternId: 'OLA@example.no' })).id, 'ola@example.no');

    sjekk('ekstern på feil sak avvises',
        await t.finnDeltaker({ skjema: sak, skjematypeId: 't1', eksternId: 'kari@example.no' }), null);

    // En ekstern identitet gir ALDRI mer enn innsender-rollen, uansett hva
    // som ellers står i requesten.
    const medUpn = await t.finnDeltaker({
        skjema: sak, skjematypeId: 't1', eksternId: 'ola@example.no', upn: 'sjef@fhs.no'
    });
    sjekk('ekstern token trumfer upn', medUpn.rolle, 'innsender');
    sjekk('og identiteten er den eksterne', medUpn.id, 'ola@example.no');

    sjekk('verken upn eller ekstern id',
        await t.finnDeltaker({ skjema: sak, skjematypeId: 't1' }), null);

    // Innlogget innsender: `tilgangsRolle` svarer før noe tabelloppslag, så
    // dette kan testes uten lagringskonto.
    const innlogget = await t.finnDeltaker({
        skjema: { Innsender_Epost: 'per@fhs.no' }, skjematypeId: 't1', upn: 'per@fhs.no', navn: 'Per Hansen'
    });
    sjekk('innlogget innsender', innlogget.rolle, 'innsender');
    sjekk('navnet er med', innlogget.navn, 'Per Hansen');
    sjekk('kilden er swa', innlogget.kilde, 'swa');

    // ---------- varsel bare ved første innlegg ----------
{
    // Avtalt med oppdragsgiver (TODO 69): varsel ved det første innlegget,
    // ikke ved hvert svar. Det første er det eneste som forteller mottakeren
    // at saken har fått en samtale — resten kommer til folk som vet det.
    sjekk('tom tråd varsles', t.skalVarsle({ antallInnleggFoer: 0 }), true);
    sjekk('svar nummer to varsles ikke', t.skalVarsle({ antallInnleggFoer: 1 }), false);
    sjekk('og heller ikke nummer ti', t.skalVarsle({ antallInnleggFoer: 9 }), false);

    // Mangler tallet, regnes tråden som tom. Det sender ett varsel for mye
    // heller enn å tie stille — en stille varsling er den feilen ingen melder.
    sjekk('manglende tall varsler', t.skalVarsle({}), true);
    sjekk('undefined varsler', t.skalVarsle({ antallInnleggFoer: undefined }), true);
}

// ---------- endepunktet bruker regelen ----------
{
    // Regelen er verdiløs hvis POST-endepunktet ikke spør om den. Uten denne
    // sjekken kunne `skalVarsle` vært riktig og likevel aldri kalt.
    const fs = require('fs');
    const path = require('path');
    const kode = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'functions', 'samtale.js'), 'utf8')
        .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    sjekk('endepunktet spør skalVarsle',
        /samtaleTilgang\.skalVarsle\(/.test(kode), true);
    // Antallet må være det som gjaldt FØR innlegget ble lagt til. Telles det
    // på nytt etterpå, er tråden aldri tom og ingen blir varslet.
    sjekk('med antallet talt før innlegget',
        /skalVarsle\(\{ antallInnleggFoer: antallInnlegg \}\)/.test(kode), true);
    sjekk('og varslingen ligger inne i sjekken',
        /skalVarsle\([^)]*\)\)\s*\{[\s\S]*?sendSamtaleVarsling/.test(kode), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

deltakere().catch(e => { console.error(e); process.exit(1); });
