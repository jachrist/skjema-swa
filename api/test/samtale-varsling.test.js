/**
 * Varsling om nye innlegg i samtalen.
 *
 * Fire regler, og tre av dem gir feil som ser ut som «systemet virker»:
 *
 *   **Avsenderen varsles ikke om sitt eget innlegg.** Den enkleste og mest
 *   irriterende feilen i en chat, og den eneste noen faktisk melder fra om.
 *
 *   **Demping gjelder per sak.** En behandler som har dempet SAK A skal
 *   fortsatt varsles om sak B. Slår dempingen for bredt, blir en sak stående
 *   fordi ingen visste at den ventet — og loggen sier at varselet ble hoppet
 *   over, helt etter planen.
 *
 *   **Innsenderen kan ikke dempes bort.** Hen kan ikke dempe selv (se
 *   samtale-tilgang.js), og et feilende dempe-oppslag skal ikke kunne stanse
 *   varselet til den ene som må nås.
 *
 *   **Innsender og behandlere får ULIKE lenker.** Innsender leser samtalen på
 *   kvitteringen, behandlere i evaluering.html. Én felles lenke sender den ene
 *   parten til en side hen ikke har tilgang til, og da ser det ut som at
 *   samtalen er borte.
 *
 * Og én ting til: teksten i innlegget skal ikke være med i varselet. Samtalen
 * er ukryptert nettopp fordi den er en delt kanal med innsenderen til stede.
 * Et varsel går ut av den kanalen, til en innboks vi ikke vet noe om.
 *
 * Kjøres med:  node api/test/samtale-varsling.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

process.env.SWA_URL = 'https://eksempel.net';
process.env.VARSLING_FLOW_URL = 'https://flyt.eksempel.net/varsling';
process.env.VARSLING_DEAKTIVERT = 'false';

const varsling = require('../src/lib/varsling');
const samtaleStorage = require('../src/lib/samtale-storage');

const SKJEMA = {
    Skjema_id: '42',
    Skjematype_id: 't1',
    Innsender_Epost: 'ola@example.no',
    Innsender_Navn: 'Ola Nordmann',
    Skjema_status: 2,
    Behandling: [{
        Steg: 1, Stegnavn: 'Godkjenning', Beslutning: 0,
        Personer: ['kari@fhs.no', 'per@fhs.no']
    }]
};

async function kjor() {
    const origFetch = globalThis.fetch;
    const origDempet = samtaleStorage.erDempet;

    /**
     * Fang payloaden i stedet for å sende den.
     *
     * Stubber `fetch`, ikke `sendEpostViaFlyt`: varsling.js destrukturerer
     * importen (`const { sendEpostViaFlyt } = require('./flyt-kaller')`), så en
     * erstatning på modulobjektet ville ikke blitt sett — funksjonen har
     * allerede sin egen referanse. Det er den fellen `roller-storage.js` og
     * `samtale-storage.js` har en kommentar om.
     *
     * Bieffekten er at testen går gjennom hele flyt-kaller og ser payloaden
     * slik flyten faktisk får den. Det er mer verdt enn å teste et argument
     * som aldri kom lenger.
     */
    function fang({ dempede = [] } = {}) {
        const kall = [];
        globalThis.fetch = async (_url, opts) => {
            kall.push(JSON.parse(opts.body));
            return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
        };
        samtaleStorage.erDempet = async (_t, _s, upn) => dempede.includes(upn);
        return kall;
    }

    try {
        // ---------- behandler skriver ----------
        {
            const kall = fang();
            await varsling.sendSamtaleVarsling(SKJEMA, {},
                { Avsender: 'kari@fhs.no', AvsenderNavn: 'Kari Nordmann', Tekst: 'Vi trenger et vedlegg' });

            const alle = kall.flatMap(k => k.mottakere.map(m => m.epost)).sort();
            sjekk('innsender og den andre behandleren', alle, ['ola@example.no', 'per@fhs.no']);
            sjekk('avsenderen selv er ikke med', alle.includes('kari@fhs.no'), false);

            // To kall: ett per lenke-side.
            const tilInnsender = kall.find(k => k.mottakere.some(m => m.epost === 'ola@example.no'));
            const tilBehandler = kall.find(k => k.mottakere.some(m => m.epost === 'per@fhs.no'));
            // Innsenderen til kvitteringen, som nå viser samtalen selv.
            // Behandleren til behandlingssiden. Én felles lenke ville sendt
            // den ene parten til en side hen ikke har tilgang til.
            sjekk('innsender sendes til kvitteringen', tilInnsender.lenker[0].url.includes('/kvittering.html'), true);
            sjekk('innsender sendes IKKE til behandlingssiden', tilInnsender.lenker[0].url.includes('/evaluering.html'), false);
            sjekk('behandler sendes til evaluering', tilBehandler.lenker[0].url.includes('/evaluering.html'), true);
            sjekk('lenken peker på samtalen', tilInnsender.lenker[0].url.endsWith('#samtale'), true);
            sjekk('også for behandleren', tilBehandler.lenker[0].url.endsWith('#samtale'), true);

            // $lenke må være løst opp FØR kallet. Står den igjen som
            // plassholder, kommer den rått i e-posten.
            sjekk('lenken er substituert i teksten',
                tilInnsender.epost_og_teams.html.includes('$lenke'), false);
            sjekk('og den rette URL-en står der',
                tilInnsender.epost_og_teams.html.includes(tilInnsender.lenker[0].url), true);

            // Teksten i innlegget skal ikke ut av samtalen.
            for (const k of kall) {
                sjekk('innleggsteksten er ikke med', k.epost_og_teams.html.includes('Vi trenger et vedlegg'), false);
            }
            sjekk('men avsenderens navn er', tilInnsender.epost_og_teams.html.includes('Kari Nordmann'), true);
        }

        // ---------- innsender skriver ----------
        {
            const kall = fang();
            await varsling.sendSamtaleVarsling(SKJEMA, {}, { Avsender: 'ola@example.no', Tekst: 'Her er det' });
            const alle = kall.flatMap(k => k.mottakere.map(m => m.epost)).sort();
            sjekk('begge behandlerne varsles', alle, ['kari@fhs.no', 'per@fhs.no']);
            sjekk('innsenderen selv er ikke med', alle.includes('ola@example.no'), false);
            sjekk('bare ett kall når innsender ikke er mottaker', kall.length, 1);
        }

        // ---------- demping ----------
        {
            const kall = fang({ dempede: ['kari@fhs.no'] });
            await varsling.sendSamtaleVarsling(SKJEMA, {}, { Avsender: 'ola@example.no', Tekst: 'x' });
            const alle = kall.flatMap(k => k.mottakere.map(m => m.epost));
            sjekk('dempet behandler hoppes over', alle, ['per@fhs.no']);
        }

        // ---------- innsender kan ikke dempes bort ----------
        {
            // Skulle det ligge en dempe-rad på innsenderen — satt for hånd,
            // eller igjen fra en tidligere rolle — skal den ikke telle.
            const kall = fang({ dempede: ['ola@example.no', 'kari@fhs.no', 'per@fhs.no'] });
            await varsling.sendSamtaleVarsling(SKJEMA, {}, { Avsender: 'kari@fhs.no', Tekst: 'x' });
            const alle = kall.flatMap(k => k.mottakere.map(m => m.epost));
            sjekk('innsenderen varsles likevel', alle, ['ola@example.no']);
        }

        // ---------- ingen andre deltakere ----------
        {
            const kall = fang();
            const alene = { ...SKJEMA, Behandling: [{ Steg: 1, Beslutning: 0, Personer: ['ola@example.no'] }] };
            const res = await varsling.sendSamtaleVarsling(alene, {}, { Avsender: 'ola@example.no', Tekst: 'x' });
            sjekk('hoppes over', res.status, 'hoppet-over');
            sjekk('ingen kall sendt', kall.length, 0);
        }

        // ---------- alle har dempet ----------
        {
            const kall = fang({ dempede: ['kari@fhs.no', 'per@fhs.no'] });
            const utenInnsender = { ...SKJEMA, Innsender_Epost: 'kari@fhs.no' };
            const res = await varsling.sendSamtaleVarsling(utenInnsender, {},
                { Avsender: 'kari@fhs.no', Tekst: 'x' });
            sjekk('hoppes over når alle er dempet', res.status, 'hoppet-over');
            sjekk('og ingenting sendes', kall.length, 0);
        }
    } finally {
        globalThis.fetch = origFetch;
        samtaleStorage.erDempet = origDempet;
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
