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

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

deltakere().catch(e => { console.error(e); process.exit(1); });
