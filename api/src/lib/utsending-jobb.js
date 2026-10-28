/**
 * Utsendingene som JOBB — uavhengig av hva som startet dem.
 *
 * To jobber deler denne modulen, fordi de deler nesten alt: de bygger den
 * samme mottakerlista, kaller den samme flyten, og skiller seg på `handling`
 * og på hva de markerer etterpå.
 *
 *   `kjorSendForfalte` — sender lenker for batcher der datoen er passert.
 *   `kjorPurring`      — purrer de ubesvarte.
 *
 * **DISSE SENDER TIL EKSTERNE MOTTAKERE.** Det er den strengeste grensen i
 * hele migreringen: en feil her går ut av huset, til folk som ikke kan gjøre
 * noe med den.
 *
 * Den ene forskjellen mellom de to er med vilje, og den er eldre enn
 * timerne: purringen markerer som purret også når flyten KOM FRAM og så
 * feilet, for å slippe å purre alle på nytt dagen etter. Utsendingen gjør
 * ikke det — der ville det samme betydd at mottakeren aldri fikk lenka. Se
 * `lib/flyt-utfall.js`.
 *
 * Flyttet hit fra `functions/utsending.js` 17.10.2026, da jobbene fikk
 * timer-triggere i dev.
 */
const utsendingStorage = require('./utsending-storage');
const utsendingToken = require('./utsending-token');
const flytUtfall = require('./flyt-utfall');
const { miljo, flytHeadere, varslingAv } = require('./flyt-kaller');
const hendelser = require('./hendelser-storage');
const skjemaStorage = require('./skjema-storage');

const SEND_PK = 'Meta';
const SEND_RK = 'Jobb-Utsending-Send';
const PURRE_PK = 'Meta';
const PURRE_RK = 'Jobb-Utsending-Purre';

// Skjemaforklaringen er skrevet for skjemasida og kan være lang. I en purring
// trengs bare nok til å kjenne igjen skjemaet, og teksten sendes per mottaker.
const BESKRIVELSE_MAKS = 1000;

/**
 * Adressen lenkene i e-posten skal peke på.
 *
 * **KASTER heller enn å gjette når den ikke vet.** En timer har ingen
 * request, og uten `SWA_URL` fantes det ingenting å utlede verten fra — den
 * gamle versjonen ville bygget `https://` med tom vert og sendt e-post med
 * døde lenker til EKTE mottakere. Stille, og uopprettelig: lenka er brukt
 * opp, mottakeren fikk den, og ingenting plukker den opp igjen.
 *
 * Derfor er dette en sperre, ikke en standardverdi. Mangler både `SWA_URL`
 * og en brukbar request, skal jobben feile FØR den sender noe.
 */
function baseUrl(request) {
    if (process.env.SWA_URL) return String(process.env.SWA_URL).replace(/\/$/, '');
    if (!request?.headers?.get) {
        throw new Error('SWA_URL er ikke satt, og det finnes ingen request å utlede verten fra '
            + '(timer-kjøring). Uten en adresse ville lenkene i e-posten vært døde. '
            + 'Sett SWA_URL som app-setting.');
    }
    const proto = request.headers.get('x-forwarded-proto') || 'https';
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
    if (!host) {
        throw new Error('SWA_URL er ikke satt, og requesten bærer ingen vert. '
            + 'Uten en adresse ville lenkene i e-posten vært døde.');
    }
    return `${proto}://${host}`;
}

/**
 * Bygg mottakerlista som sendes til en PA-flyt — både ved førstegangs utsending
 * og ved purring.
 *
 * En kjøring kan spenne over flere skjematyper, og mottakeren har bare en lenke
 * å gå etter. Navnet må derfor følge med, ellers kan ikke flyten skrive hva
 * meldingen gjelder. Slås opp én gang per skjematype — en batch på 500
 * mottakere er typisk 1-2 typer.
 *
 * Tokenet utstedes på nytt med samme jti: samme identitet, ny utløpstid. Lenka
 * i en purring er derfor alltid fersk, selv om batchen er gammel.
 */
async function byggUtsendingsposter(kandidater, basisUrl, log, navn, { tekstOverstyring = '' } = {}) {
    const typeCache = new Map();
    for (const id of new Set(kandidater.map(k => String(k.SkjematypeId)))) {
        let info = { navn: '', beskrivelse: '', format: 'Tekst' };
        try {
            const type = await skjemaStorage.hentSkjematype(id);
            if (type) {
                // Skjemaforklaring er normalt { Innhold, Format }, men eldre
                // definisjoner har den som ren streng.
                const forklaring = type.JSON?.Skjemaforklaring || null;
                const erTekst = typeof forklaring === 'string';
                info = {
                    navn: type.navn || '',
                    beskrivelse: String(erTekst ? forklaring : (forklaring?.Innhold || '')).slice(0, BESKRIVELSE_MAKS),
                    format: (erTekst ? 'Tekst' : forklaring?.Format) || 'Tekst'
                };
            } else {
                log(`${navn}: fant ikke skjematype ${id} — sender uten navn`);
            }
        } catch (e) {
            // Et navn er ikke verdt å avlyse hele kjøringen for.
            log(`${navn}: oppslag av skjematype ${id} feilet (${e.message}) — sender uten navn`);
        }
        typeCache.set(id, info);
    }

    const nå = Date.now();
    return kandidater.map(k => {
        const type = typeCache.get(String(k.SkjematypeId)) || { navn: '', beskrivelse: '', format: 'Tekst' };
        const token = utsendingToken.utsted({
            batchId: k.BatchId, mottaker: k.Mottaker, skjematypeId: k.SkjematypeId, jti: k.Jti
        });
        const referanse = k.Sendt || k.Utsendingsdato || k.Opprettet;
        return {
            mottaker: k.Mottaker,
            url: `${basisUrl}/index.html?utsending=${encodeURIComponent(token)}`,
            batchId: k.BatchId,
            skjematypeId: k.SkjematypeId,
            skjemanavn: type.navn,
            skjemabeskrivelse: type.beskrivelse,
            skjemabeskrivelseFormat: type.format,
            purretekst: tekstOverstyring || k.Purretekst || '',
            avslutningsdato: k.Avslutningsdato || '',
            kanal: k.KanalHint || 'epost',
            dagerSiden: Math.floor((nå - new Date(referanse).getTime()) / (24 * 3600 * 1000))
        };
    });
}

/**
 * Kall flyten som sender ut lenker — første gang eller som purring.
 *
 * Adressen er VARSLING_FLOW_URL — samme flyt som all annen varsling.
 *
 * Det var tre adresser her: UTSENDING_FLOW_URL, PURRE_FLOW_URL og
 * VARSLING_FLOW_URL. De to første var ikke satt i noe miljø — den ene manglet
 * helt, den andre pekte på en flyt som var slettet — og utsending var dermed
 * ute av funksjon overalt. At det ikke ble oppdaget skyldes at endepunktene
 * svarer 200 før flyten kalles når det ikke finnes noe å sende.
 *
 * Tre app settings med samme verdi er verre enn én. Utsending og purring er
 * det samme som varslingsflyten allerede gjør: send en e-post med en tekst og
 * en lenke til en liste mottakere.
 *
 * NB: nyttelasten er ikke den samme som `sendVarslerViaFlyt` sender ennå — se
 * `docs/FASE-UTSENDING-SAMMENSLAING.md` trinn 2. Flyten ser derfor to former
 * på samme trigger, skilt på `handling`, og MÅ forgrene på det feltet.
 * Utsendingspayloaden har ingen `epost_og_teams`, så en flyt som ikke
 * forgrener sender en tom e-post — til eksterne mottakere.
 *
 * Kallet har en tidsgrense godt under SWA-gatewayens ~45 sekunder. Uten den
 * ville en treg flyt kvele hele cron-kjøringen, og feilen kommet som en naken
 * 502 uten spor i loggen.
 */
const FLYT_TIMEOUT_MS = 35000;

async function kallUtsendingsflyt(handling, mottakere, log, navn) {
    const url = String(process.env.VARSLING_FLOW_URL || '').trim();
    if (!url) return { ok: false, mangler: true, komFram: false, feil: 'VARSLING_FLOW_URL er ikke satt' };

    const start = Date.now();
    let vertsnavn = 'ugyldig-url';
    try { vertsnavn = new URL(url).hostname; } catch (_) { /* logges som ugyldig */ }

    const avbryt = new AbortController();
    const timer = setTimeout(() => avbryt.abort(), FLYT_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: await flytHeadere(),
            body: JSON.stringify({ handling, miljø: miljo(), mottakere }),
            signal: avbryt.signal
        });
        const ms = Date.now() - start;
        if (!res.ok) {
            const tekst = await res.text().catch(() => '');
            return {
                ok: false,
                komFram: flytUtfall.svarKomFram(res.status),
                feil: `PA-flyt (${vertsnavn}) svarte HTTP ${res.status} etter ${ms} ms: ${tekst.slice(0, 300)}`
            };
        }
        log(`${navn}: PA-flyt (${vertsnavn}) tok imot ${mottakere.length} mottakere på ${ms} ms (handling=${handling})`);
        return { ok: true, komFram: true, ms };
    } catch (e) {
        const ms = Date.now() - start;
        return {
            ok: false,
            komFram: flytUtfall.feilKomFram(e),
            feil: e.name === 'AbortError'
                ? `PA-flyt (${vertsnavn}) svarte ikke innen ${FLYT_TIMEOUT_MS / 1000} sekunder`
                : `PA-flyt-kall mot ${vertsnavn} feilet etter ${ms} ms: ${e.message}`
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Statusraden av utfallet. «deaktivert» er sin egen status: kjøringen gikk
 * som den skulle, men ingenting ble sendt — og det skal ikke se ut som verken
 * «ok» eller «feil» i Jobber-fanen.
 */
function statusFor(utfall) {
    if (utfall === 'ok' || utfall === 'ingenting') return 'ok';
    if (utfall === 'deaktivert') return 'deaktivert';
    return 'feil';
}

/**
 * Stopper `VARSLING_DEAKTIVERT` jobben? Da sendes ingenting, og INGENTING
 * markeres — radene står som før og går ved første kjøring etter at bryteren
 * er slått av.
 *
 * Til 28.10.2026 sjekket ingen av de to jobbene bryteren. De kaller flyten
 * direkte, ikke via `kallVarslingFlyt`, og gikk derfor forbi den — mens
 * bryteren ellers betyr «ikke rør noe utenfor systemet». Utsending og
 * purring er de eneste jobbene som sender til EKSTERNE mottakere, så det var
 * akkurat de som burde vært stoppet.
 *
 * Regelen for hva som teller som «av» er `varslingAv()` i flyt-kaller.js,
 * ikke en egen lesing av env-varen her.
 */
function deaktivertSvar(kandidater, navn, log) {
    const melding = `VARSLING_DEAKTIVERT=true — ${kandidater.length} venter, ingenting sendt eller markert`;
    log(`${navn}: ${melding}`);
    return melding;
}

/** Felles bokføring for begge utsendingsjobbene. */
function bokfoerer(pk, rk) {
    return async (felter) => {
        try {
            const { tabellKlient } = require('./storage');
            const t = tabellKlient('CacheMetadata');
            await t.upsertEntity({ partitionKey: pk, rowKey: rk, ...felter }, 'Merge');
        } catch (_) { /* statusraden er ikke kritisk */ }
    };
}

/**
 * Send lenker for forfalte utsendinger. Kaster aldri.
 *
 * `Sendt` settes bare når flyten faktisk tok imot kallet. Feiler den, prøves
 * de samme radene på nytt neste døgn — en mottaker som aldri fikk lenka er
 * verre enn en dobbel.
 */
async function kjorSendForfalte({ kilde, batchFilter = '', request = null, log = () => {} } = {}) {
    const startTid = new Date().toISOString();
    const settStatus = bokfoerer(SEND_PK, SEND_RK);
    await settStatus({ Status: 'kjører', Startet: startTid, Kilde: kilde, SistFeil: '' });
    log(`utsending/send-forfalte: trigget av ${kilde}`);

    const ferdig = async (utfall, felter, svar) => {
        await settStatus({
            Status: statusFor(utfall),
            Ferdig: new Date().toISOString(),
            SistOppdatert: new Date().toISOString(),
            Utfall: utfall, ...felter
        });
        return { utfall, ...svar };
    };

    try {
        let kandidater = await utsendingStorage.listForfalteUtsendinger();
        if (batchFilter) kandidater = kandidater.filter(k => k.BatchId === batchFilter);
        if (kandidater.length === 0) {
            return ferdig('ingenting', { AntallSendt: 0, AntallKandidater: 0, SistFeil: '' },
                { antallSendt: 0, antallKandidater: 0, melding: 'Ingen forfalte utsendinger' });
        }

        // Bryteren står FØR alt annet: radene skal stå urørt, slik at de går
        // neste gang. Markerer vi som sendt uten å sende, får mottakeren
        // aldri lenka, og ingenting plukker den opp igjen.
        if (varslingAv()) {
            const melding = deaktivertSvar(kandidater, 'utsending/send-forfalte', log);
            return ferdig('deaktivert',
                { AntallSendt: 0, AntallKandidater: kandidater.length, SistFeil: '' },
                { antallSendt: 0, antallKandidater: kandidater.length, melding });
        }

        // KASTER hvis adressen ikke finnes — se baseUrl(). Da er ingenting
        // sendt, og catch-en under bokfører årsaken.
        const basis = baseUrl(request);
        const mottakere = await byggUtsendingsposter(kandidater, basis, log, 'utsending/send-forfalte');

        const res = await kallUtsendingsflyt('sendUtsendinger', mottakere, log, 'utsending/send-forfalte');

        if (res.mangler) {
            const melding = `${res.feil} — ${kandidater.length} forfalte utsendinger venter`;
            log(`utsending/send-forfalte: ${melding}`);
            return ferdig('mangler-flyt',
                { AntallSendt: 0, AntallKandidater: kandidater.length, SistFeil: melding.slice(0, 500) },
                { antallSendt: 0, antallKandidater: kandidater.length, melding });
        }

        if (!res.ok) {
            log(`utsending/send-forfalte: ${res.feil} — ingen markert som sendt, prøves igjen neste kjøring`);
            hendelser.logg({
                Type: 'utsending.send-forfalte', Aktor: kilde,
                ObjektType: 'utsending', ObjektId: batchFilter || '(alle)',
                Melding: `Utsending av ${kandidater.length} lenker feilet: ${res.feil}`,
                Detaljer: { antallKandidater: kandidater.length, feil: res.feil }
            });
            return ferdig('flyt-feilet',
                { AntallSendt: 0, AntallKandidater: kandidater.length, SistFeil: String(res.feil).slice(0, 500) },
                { antallSendt: 0, antallKandidater: kandidater.length, feil: res.feil });
        }

        let antallSendt = 0;
        for (const k of kandidater) {
            try {
                await utsendingStorage.markerSendt(k.BatchId, k.Mottaker);
                antallSendt++;
            } catch (e) {
                log(`utsending/send-forfalte: markerSendt feilet for ${k.BatchId}/${k.Mottaker}: ${e.message}`);
            }
        }

        hendelser.logg({
            Type: 'utsending.send-forfalte', Aktor: kilde,
            ObjektType: 'utsending', ObjektId: batchFilter || '(alle)',
            Melding: `Sendte ${antallSendt} planlagte utsending${antallSendt === 1 ? '' : 'er'}`,
            Detaljer: { antallSendt, antallKandidater: kandidater.length, batchFilter }
        });

        return ferdig('ok',
            { AntallSendt: antallSendt, AntallKandidater: kandidater.length, SistFeil: '' },
            { antallSendt, antallKandidater: kandidater.length });
    } catch (e) {
        log(`utsending/send-forfalte FEIL: ${e.message}`);
        await settStatus({
            Status: 'feil', Ferdig: new Date().toISOString(),
            Utfall: 'feil', SistFeil: String(e.message || e).slice(0, 500)
        });
        return { utfall: 'feil', melding: String(e.message || e) };
    }
}

/**
 * Purr de ubesvarte. Kaster aldri.
 *
 * Markerer som purret når kallet KOM FRAM, også om flyten så feilet: den kan
 * ha rukket å sende til noen før den ga opp — kanskje halve lista, og vi vet
 * ikke hvem. Én tapt purring er bedre enn en dobbel til alle.
 *
 * Kom kallet ALDRI fram, markeres ingenting.
 */
async function kjorPurring({ kilde, batchFilter = '', tekstOverstyring = '', request = null, log = () => {} } = {}) {
    const startTid = new Date().toISOString();
    const settStatus = bokfoerer(PURRE_PK, PURRE_RK);
    await settStatus({ Status: 'kjører', Startet: startTid, Kilde: kilde, SistFeil: '' });
    log(`utsending/purre: trigget av ${kilde}`);

    const ferdig = async (utfall, felter, svar) => {
        await settStatus({
            Status: statusFor(utfall),
            Ferdig: new Date().toISOString(),
            SistOppdatert: new Date().toISOString(),
            Utfall: utfall, ...felter
        });
        return { utfall, ...svar };
    };

    try {
        const maksDager = Number(process.env.PURRE_MAKS_DAGER || 14);
        const minDagerMellom = Number(process.env.PURRE_MIN_DAGER_MELLOM || 3);

        let kandidater = await utsendingStorage.listUbesvarte({
            maksDagerSidenOpprettet: maksDager,
            minDagerSidenPurring: minDagerMellom
        });
        if (batchFilter) kandidater = kandidater.filter(k => k.BatchId === batchFilter);

        if (kandidater.length === 0) {
            return ferdig('ingenting', { AntallPurret: 0, SistFeil: '' },
                { antallPurret: 0, antallHoppetOver: 0, melding: 'Ingen kandidater å purre' });
        }

        // Samme bryter, samme plass. En purring som markeres uten å gå ut, er
        // brukt opp — mottakeren purres ikke igjen før minDagerMellom.
        if (varslingAv()) {
            const melding = deaktivertSvar(kandidater, 'utsending/purre', log);
            return ferdig('deaktivert',
                { AntallPurret: 0, AntallKandidater: kandidater.length, SistFeil: '' },
                { antallPurret: 0, antallKandidater: kandidater.length, melding });
        }

        const basis = baseUrl(request);
        const mottakere = await byggUtsendingsposter(kandidater, basis, log, 'utsending/purre', {
            tekstOverstyring
        });

        const res = await kallUtsendingsflyt('purreUtsendinger', mottakere, log, 'utsending/purre');
        const feil = res.ok ? null : res.feil;
        if (feil) log(`utsending/purre: ${feil}`);

        // Kom kallet aldri fram, er ingenting sendt. Da skal ingenting
        // markeres heller.
        if (!res.ok && !res.komFram) {
            log(`utsending/purre: ${feil} — ingen markert som purret, prøves igjen neste kjøring`);
            hendelser.logg({
                Type: 'utsending.purre', Aktor: kilde,
                ObjektType: 'utsending', ObjektId: batchFilter || '(alle)',
                Melding: `Purring av ${kandidater.length} utsendinger nådde ikke fram: ${feil}`,
                Detaljer: { antallKandidater: kandidater.length, feil, komFram: false }
            });
            return ferdig('kom-ikke-fram',
                { AntallPurret: 0, AntallKandidater: kandidater.length, SistFeil: String(feil).slice(0, 500) },
                { antallPurret: 0, antallKandidater: kandidater.length, feil });
        }

        let antallPurret = 0;
        for (const k of kandidater) {
            try {
                await utsendingStorage.markerPurret(k.BatchId, k.Mottaker);
                antallPurret++;
            } catch (e) {
                log(`utsending/purre: markerPurret feilet for ${k.BatchId}/${k.Mottaker}: ${e.message}`);
            }
        }

        hendelser.logg({
            Type: 'utsending.purre', Aktor: kilde,
            ObjektType: 'utsending', ObjektId: batchFilter || '(alle)',
            Melding: `Purret ${antallPurret} ubesvarte utsending${antallPurret === 1 ? '' : 'er'}`
                + (feil ? ' (PA-flyt feilet: ' + feil + ')' : ''),
            Detaljer: { antallPurret, batchFilter, feil, maksDager, minDagerMellom }
        });

        return ferdig(feil ? 'delvis' : 'ok',
            { AntallPurret: antallPurret, SistFeil: feil ? String(feil).slice(0, 500) : '' },
            { antallPurret, antallHoppetOver: 0, feil });
    } catch (e) {
        log(`utsending/purre FEIL: ${e.message}`);
        await settStatus({
            Status: 'feil', Ferdig: new Date().toISOString(),
            Utfall: 'feil', SistFeil: String(e.message || e).slice(0, 500)
        });
        return { utfall: 'feil', melding: String(e.message || e) };
    }
}

module.exports = {
    baseUrl, byggUtsendingsposter, kallUtsendingsflyt,
    kjorSendForfalte, kjorPurring,
    BESKRIVELSE_MAKS, SEND_PK, SEND_RK, PURRE_PK, PURRE_RK
};
