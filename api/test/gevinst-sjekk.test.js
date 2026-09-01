/**
 * Tester for nullpunktsjekken (TODO 49).
 *
 * Den farlige feilen her er en FALSK advarsel: sier vi «baseline mangler» til
 * en eier som faktisk har registrert den, mister advarselen all verdi og blir
 * klikket bort. Derfor testes normaliseringen grundig — svaret kan komme som
 * tall, streng med mellomrom, eller pakket i et objekt fra et valgfelt.
 *
 * Motsatt vei er også viktig: er innstillingen ikke satt, skal vi tie helt.
 * Å gjette på hvilken skjematype som er baseline ville advart om alt.
 *
 * Kjøres med:  node api/test/gevinst-sjekk.test.js
 */
const g = require('../src/lib/gevinst-sjekk');
const innstillinger = require('../src/lib/innstillinger-storage');
const forekomst = require('../src/lib/skjema-forekomst-storage');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/**
 * Baseline-skjema med skjematype-ID i felt 1-01.
 *
 * Merk feltnavnet: oppslaget matcher på `Nummer`, ikke `Felt_nummer`. Det er
 * ikke opplagt, og en fixture med feil navn ville gitt en sjekk som aldri
 * finner noe — altså advarsel om at baseline mangler for absolutt alle.
 */
function baselineSkjema(peker, status = 2) {
    return {
        Skjema_status: status,
        Seksjoner: [{
            Seksjon_nummer: 1,
            Felter: [{ Nummer: 1, Type: 'Tekst', Svar: peker === null ? [] : [peker] }]
        }]
    };
}

/** Bytter ut lagringslaget mens en sjekk kjører. */
async function medData({ baselineId, skjemaer = [], listeFeiler = false }, fn) {
    const origHent = innstillinger.hent;
    const origListe = forekomst.hentAlleSkjemaerForType;
    innstillinger.hent = async (n) =>
        n === 'Gevinstestimat.SkjemaId' && baselineId !== null ? { Verdi: baselineId } : null;
    forekomst.hentAlleSkjemaerForType = async () => {
        if (listeFeiler) throw new Error('TableNotFound');
        return skjemaer;
    };
    try { return await fn(); }
    finally {
        innstillinger.hent = origHent;
        forekomst.hentAlleSkjemaerForType = origListe;
    }
}

async function kjor() {
    // ---------- normalisering ----------
    {
        sjekk('tall blir streng', g.normaliser(113), '113');
        sjekk('mellomrom trimmes', g.normaliser(' 113 '), '113');
        sjekk('liste tar første verdi', g.normaliser(['113', '99']), '113');
        sjekk('objekt med Verdi', g.normaliser({ Verdi: '113' }), '113');
        sjekk('objekt med Tekst', g.normaliser({ Tekst: '113' }), '113');
        sjekk('null blir tom', g.normaliser(null), '');
        sjekk('undefined blir tom', g.normaliser(undefined), '');
        sjekk('tom liste blir tom', g.normaliser([]), '');
    }

    // ---------- uten konfigurasjon skal vi tie ----------
    {
        const res = await medData({ baselineId: null }, () => g.nullpunktRegistrert('42'));
        sjekk('usatt innstilling gir ingen sjekk', res.sjekket, false);
        sjekk('og ingen påstand om at den mangler', res.registrert, false);
        const dek = await medData({ baselineId: null }, () => g.hentDekkede());
        sjekk('oversikten melder ikke konfigurert', dek.konfigurert, false);
    }

    // ---------- registrert nullpunkt ----------
    {
        const skjemaer = [baselineSkjema('42'), baselineSkjema('99')];
        const res = await medData({ baselineId: '113', skjemaer }, () => g.nullpunktRegistrert('42'));
        sjekk('registrert nullpunkt godtas', res.registrert, true);
        sjekk('og sjekken ble faktisk kjørt', res.sjekket, true);
        sjekk('ingen melding når alt er i orden', res.melding, '');

        const mangler = await medData({ baselineId: '113', skjemaer }, () => g.nullpunktRegistrert('7'));
        sjekk('manglende nullpunkt oppdages', mangler.registrert, false);
        sjekk('meldingen sier hvilken skjematype som skal brukes',
            /skjematype 113/.test(mangler.melding), true);
        sjekk('og hvilken ID som skal stå i feltet', /\b7\b/.test(mangler.melding), true);
    }

    // ---------- ulike former på svaret ----------
    {
        // Feltet kan være tall, ha mellomrom, eller komme fra et valgfelt.
        // Ingen av delene skal gi falsk advarsel.
        for (const [beskrivelse, verdi] of [
            ['tall', 42], ['streng med mellomrom', ' 42 '], ['ren streng', '42']
        ]) {
            const res = await medData(
                { baselineId: '113', skjemaer: [baselineSkjema(verdi)] },
                () => g.nullpunktRegistrert(42));
            sjekk(`nullpunkt lagret som ${beskrivelse} godtas`, res.registrert, true);
        }
    }

    // ---------- mellomlagret teller ikke ----------
    {
        // Et påbegynt baseline-skjema er ikke et registrert nullpunkt.
        const res = await medData(
            { baselineId: '113', skjemaer: [baselineSkjema('42', 1)] },
            () => g.nullpunktRegistrert('42'));
        sjekk('mellomlagret baseline teller ikke', res.registrert, false);

        const innsendt = await medData(
            { baselineId: '113', skjemaer: [baselineSkjema('42', 5)] },
            () => g.nullpunktRegistrert('42'));
        sjekk('avsluttet baseline teller', innsendt.registrert, true);
    }

    // ---------- tomt felt ----------
    {
        const res = await medData(
            { baselineId: '113', skjemaer: [baselineSkjema(null)] },
            () => g.nullpunktRegistrert('42'));
        sjekk('baseline uten utfylt peker dekker ingenting', res.registrert, false);
        const dek = await medData(
            { baselineId: '113', skjemaer: [baselineSkjema(null)] }, () => g.hentDekkede());
        sjekk('og havner ikke i dekket-lista', dek.dekkede, []);
    }

    // ---------- baseline-skjemaet selv ----------
    {
        // Gevinstskjemaene skal ikke kreve sitt eget nullpunkt.
        const res = await medData({ baselineId: '113', skjemaer: [] }, () => g.nullpunktRegistrert('113'));
        sjekk('baseline-typen unntas', res.sjekket, false);
        sjekk('og regnes som i orden', res.registrert, true);
    }

    // ---------- lagringsfeil skal ikke advare feilaktig ----------
    {
        // Finnes ikke baseline-tabellen ennå, vet vi ingenting — men
        // oversikten skal fortsatt komme opp.
        const dek = await medData({ baselineId: '113', listeFeiler: true }, () => g.hentDekkede());
        sjekk('feil ved oppslag gir tom dekket-liste', dek.dekkede, []);
        sjekk('men melder fortsatt konfigurert', dek.konfigurert, true);
    }

    // ---------- oversikten ----------
    {
        const skjemaer = [baselineSkjema('42'), baselineSkjema('42'), baselineSkjema('99')];
        const dek = await medData({ baselineId: '113', skjemaer }, () => g.hentDekkede());
        sjekk('duplikater telles én gang', dek.dekkede.sort(), ['42', '99']);
        sjekk('baseline-typen følger med ut', dek.baselineTypeId, '113');
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
