/**
 * Rolleinnehavere i skjematype-editoren (TODO 39).
 *
 * En rolle uten innehavere ser helt riktig ut i editoren. Feilen viser seg
 * først som en varsling som aldri kom — `samleBehandlerMottakere` hopper
 * stille over når mottakerlista er tom. Derfor er ikke dette bekvemmelighet:
 * antallet skal være synlig mens skjematypen settes opp.
 *
 * Tre ting testes, og to av dem handler om å ikke påstå noe vi ikke vet:
 *
 *   Et oppslag som feiler gir `null`, ikke tom liste. «Ingen innehavere» er en
 *   påstand, og det er nettopp den påstanden som får noen til å legge inn en
 *   person for sikkerhets skyld.
 *
 *   En dynamisk rolle slås ikke opp i det hele tatt. Omfanget kommer fra et
 *   svar i skjemaet, så et oppslag nå ville gitt tomt — eller verre, navnene
 *   til feil klasse.
 *
 *   Cachen spør én gang per rollestreng. En skjematype har mange
 *   tilgang-editorer som peker på de samme rollene.
 *
 * Kjøres med:  node frontend/test/rolleinnehavere.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

async function kjor() {
    const modul = pathToFileURL(path.join(__dirname, '..', 'js', 'tilgang-editor.js')).href;
    const t = await import(modul);

    // ---------- dynamisk rolle kjennes igjen ----------
    {
        sjekk('dynamisk', t.erDynamiskRolle('Klassesjef({2-01})'), true);
        sjekk('fast omfang er ikke dynamisk', t.erDynamiskRolle('Klassesjef(2-01)'), false);
        sjekk('uten omfang', t.erDynamiskRolle('Saksbehandler'), false);
        sjekk('tom', t.erDynamiskRolle(''), false);
        sjekk('undefined', t.erDynamiskRolle(undefined), false);
    }

    // ---------- navn, med fallback til e-post ----------
    {
        sjekk('etternavn, fornavn', t.innehaverNavn({ EN: 'Nordmann', FN: 'Kari', EP: 'kari@fhs.no' }), 'Nordmann, Kari');
        sjekk('bare etternavn', t.innehaverNavn({ EN: 'Nordmann', EP: 'k@fhs.no' }), 'Nordmann');
        sjekk('Navn-feltet brukes når EN/FN mangler', t.innehaverNavn({ Navn: 'Kari N', EP: 'k@fhs.no' }), 'Kari N');
        // Uten navn er e-posten bedre enn ingenting — den identifiserer
        // fortsatt personen for den som setter opp skjematypen.
        sjekk('faller tilbake til e-post', t.innehaverNavn({ EP: 'kari@fhs.no' }), 'kari@fhs.no');
        sjekk('helt tom', t.innehaverNavn({}), '');
    }

    // ---------- oppslaget ----------
    {
        t.invaliderInnehaverCache();
        let kall = 0;
        const api = {
            get: async (url) => {
                kall++;
                if (url.includes('Tom')) return [];
                if (url.includes('Feil')) throw new Error('500');
                return [{ EP: 'kari@fhs.no', EN: 'Nordmann', FN: 'Kari' }];
            }
        };

        sjekk('uten api-klient vet vi ingenting', await t.hentInnehavere(null, 'Saksbehandler'), null);
        sjekk('tom rollestreng', await t.hentInnehavere(api, ''), null);

        const funn = await t.hentInnehavere(api, 'Saksbehandler');
        sjekk('innehaverne kommer tilbake', funn.map(t.innehaverNavn), ['Nordmann, Kari']);

        sjekk('tom rolle er en tom liste, ikke null', await t.hentInnehavere(api, 'Tom'), []);
        sjekk('feilet oppslag er null, ikke tom liste', await t.hentInnehavere(api, 'Feil'), null);

        // ---------- cachen ----------
        const foer = kall;
        await t.hentInnehavere(api, 'Saksbehandler');
        await t.hentInnehavere(api, 'Saksbehandler');
        sjekk('samme rolle spørres bare én gang', kall, foer);

        // Også et feilet oppslag caches. Alternativet er at hver editor på
        // siden prøver på nytt mot et endepunkt som nettopp svarte 500.
        const foerFeil = kall;
        await t.hentInnehavere(api, 'Feil');
        sjekk('også feil caches', kall, foerFeil);

        t.invaliderInnehaverCache();
        await t.hentInnehavere(api, 'Saksbehandler');
        sjekk('invalidering gir nytt oppslag', kall > foerFeil, true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
