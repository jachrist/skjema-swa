/**
 * Skjema-forekomst-endepunkter.
 *
 *   POST /api/skjemaer                        — opprett/lagre skjema
 *   GET  /api/skjemaer/:skjematypeId/:skjemaId — hent én forekomst
 *
 * POST forventer body med:
 *   { Skjematype_id, Seksjoner: [...], Skjema_status?, Skjema_id? (kun ved oppdatering) }
 *
 * Innsender settes automatisk fra pålogget bruker (x-ms-client-principal).
 * Skjema_id genereres serverside for nye skjemaer.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const vedleggStorage = require('../lib/vedlegg-storage');
const { genererSkjemaId } = require('../lib/skjema-id');
const { filtrerTyperPåTilgang, lagTilgangsCache } = require('../lib/tilgang');
const { erKompaktFormat, komprimerSkjema } = require('../lib/skjema-kompakt');
const { beregnAktiveSteg, brukerErBehandler, brukerErBehandlerAsync, alleStegFerdig, stegErFerdig, skipStegSomIkkeSkalKjore } = require('../lib/behandling');
const dynamiskRolle = require('../lib/dynamisk-rolle');
const varsling = require('../lib/varsling');
const { kallEksternFlyt } = require('../lib/ekstern-flyt');
const { oppdaterSPListe } = require('../lib/sp-liste');
const kryptering = require('../lib/kryptering');
const nokkelStorage = require('../lib/nokkel-storage');
const otpToken = require('../lib/otp-token');
const hendelser = require('../lib/hendelser-storage');
const utsendingToken = require('../lib/utsending-token');
const utsendingStorage = require('../lib/utsending-storage');
const prefill = require('../lib/utsending-prefill');

/**
 * Autentisering for ekstern-innsender-flyten.
 * Sjekker om request har gyldig x-otp-token og at skjematypen tillater ekstern.
 * Returnerer { ok, mottaker, kanal } eller { ok: false, melding }.
 */
async function autentiserEkstern(request, skjematypeId) {
    const token = request.headers.get('x-otp-token');
    if (!token) return { ok: false };
    const v = otpToken.valider(token);
    if (!v.gyldig) return { ok: false, melding: v.melding };
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st?.JSON?.EksternTilgang) return { ok: false, melding: 'Skjematype tillater ikke ekstern innsender' };
    return { ok: true, mottaker: v.mottaker, kanal: v.kanal };
}

function eksternInnsenderUpn(mottaker, kanal) {
    // Bruker mottaker som "identitet" i innsender-feltet.
    // E-post går i Innsender_Epost; mobilnr merkes med prefiks for å unngå
    // forvirring med reelle e-poster i register/PDF.
    return kanal === 'sms' ? `mobil:${mottaker}` : String(mottaker).toLowerCase();
}

/**
 * Dekrypter skjema hvis det er kryptert (Kryptert=true/string). Best-effort:
 * hvis nøkkel mangler eller dekryptering feiler, returneres skjemaet uendret
 * (frontend viser da rå kryptert data, men det er tryggere enn å blokkere).
 */
async function dekrypterHvisKryptert(skjema, skjematypeId, context) {
    if (!skjema?.Kryptert) return skjema;
    try {
        const nokkel = await nokkelStorage.hentNokkel(skjematypeId);
        if (!nokkel) {
            context?.log(`dekrypterHvisKryptert: mangler nøkkel for skjematype ${skjematypeId}`);
            return skjema;
        }
        return kryptering.dekrypterSkjema(skjema, nokkel);
    } catch (e) {
        context?.log(`dekrypterHvisKryptert: feilet — ${e.message}`);
        return skjema;
    }
}

async function harPublikumTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Publikum');
    return treff.length > 0;
}

async function harEierTilgang(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

/**
 * POST /api/skjemaer/:type/:id/komprimer — komprimer skjema til kompakt lagringsformat.
 * Reduserer JSON-størrelsen ved arkivering. Ekspanderes transparent ved henting.
 * Kun eier/admin. Kan gjøres når som helst (idempotent).
 */
app.http('komprimerSkjema', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}/komprimer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            // Kun eier eller admin — innsender skal ikke kunne komprimere andres arkiv
            if (!erAdmin(upn)) {
                const erEier = await harEierTilgang(skjematypeId, upn);
                if (!erEier) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier-tilgang' } };
            }

            if (erKompaktFormat(skjema)) {
                return { jsonBody: { status: 'ok', allerede_kompakt: true } };
            }

            const kompakt = komprimerSkjema(skjema);
            const førSt = JSON.stringify(skjema).length;
            const etterSt = JSON.stringify(kompakt).length;
            await forekomstStorage.lagreSkjema(kompakt, false);

            context.log(`komprimer: ${upn} komprimerte ${skjemaId} (${førSt} → ${etterSt} bytes)`);
            return { jsonBody: { status: 'ok', størrelse_før: førSt, størrelse_etter: etterSt } };
        } catch (e) {
            context.log('komprimerSkjema FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * POST /api/skjemaer/:type/:id/beslutning
 * Body: { steg: <n>, beslutning: <n> }
 * Kun bruker som er behandler på steget kan gjøre beslutning.
 * Steget må være aktivt (ikke behandlet, ikke blokkert av avhengighet).
 */
app.http('lagreBeslutning', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}/beslutning',
    handler: async (request, context) => {
        // Auth: enten SWA-innlogget bruker (som må være behandler), ELLER
        // ekstern flyt-callback via x-flow-key-header som matcher FLOW_CALLBACK_KEY.
        // Flyt-callback tillater å sette Beslutning på ekstern-flyt-steg uten
        // brukerkontekst (det er PA-flyten som sier "steget er fullført").
        const flowKey = request.headers.get('x-flow-key');
        const configuredFlowKey = process.env.FLOW_CALLBACK_KEY;
        const erFlowCallback = flowKey && configuredFlowKey && flowKey === configuredFlowKey;

        const upn = hentInnloggetUpn(request);
        if (!erFlowCallback && !upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const body = await request.json();
            const stegNr = Number(body.steg);
            const beslutning = Number(body.beslutning);
            if (!stegNr || !beslutning) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Manglet steg eller beslutning' } };
            }

            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            const stegObj = (skjema.Behandling || []).find(s => Number(s.Steg) === stegNr);
            if (!stegObj) return { status: 404, jsonBody: { status: 'feil', melding: 'Behandlingssteg ikke funnet' } };

            // Flow-callback får kun fullføre steg som faktisk har Flyt_url — så nøkkelen
            // ikke kan misbrukes til å avgjøre menneske-behandlede steg.
            if (erFlowCallback) {
                if (!(stegObj.Flyt_url || '').trim()) {
                    return { status: 403, jsonBody: { status: 'avvist', melding: 'Flow-callback tillatt kun for steg med Flyt_url' } };
                }
            } else if (!(await brukerErBehandlerAsync(stegObj, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Du er ikke behandler på dette steget' } };
            }
            // Tilstandssjekk: ikke allerede behandlet, ikke blokkert
            if (stegErFerdig(stegObj)) {
                return { status: 409, jsonBody: { status: 'feil', melding: 'Steget er allerede behandlet' } };
            }
            // I alle-modus: hindre at samme aktør avgir mer enn én gang uten at det er
            // en oppdatering av egen. Duplikat-håndteringen skjer i selve avgivelses-koden.
            const aktive = beregnAktiveSteg(skjema);
            if (!aktive.some(s => Number(s.Steg) === stegNr)) {
                return { status: 409, jsonBody: { status: 'feil', melding: 'Steget er ikke aktivt ennå' } };
            }

            // Valider beslutning mot Beslutningsvalg (eller 5 = hoppet over)
            const valgtValg = (stegObj.Beslutningsvalg || []).find(v => Number(v.Nummer) === beslutning);
            if (beslutning !== 5 && !valgtValg) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ugyldig beslutning for dette steget' } };
            }

            const erOmpuss = valgtValg?.Handling === 'ompuss';

            if (erOmpuss) {
                // Ompuss: skjemaet sendes tilbake til innsender for revidering.
                // Steget nullstilles så det kan re-behandles etter re-innsending.
                // Loggfør beslutningen som dialog-innlegg (så historikken bevares).
                const notat = valgtValg?.Tekst || 'Ompuss';
                if (!Array.isArray(skjema.Dialog)) skjema.Dialog = [];
                skjema.Dialog.push({
                    Type: 'ekstern',
                    Avsender: upn,
                    Tekst: `Sendt til revidering fra steg ${stegNr} (${stegObj.Stegnavn || ''}). Beslutning: ${notat}. Vennligst oppdater og send inn på nytt.`,
                    Dato: new Date().toISOString()
                });
                // Nullstill steget (så det er "aktivt" igjen etter re-innsending)
                delete stegObj.Beslutning;
                stegObj.Beslutning = 0;
                delete stegObj.BehandletAv;
                delete stegObj.BehandletDato;
                // Skjemaet: status=3 (Til revidering)
                skjema.Skjema_status = 3;
                context.log(`beslutning: ${upn || 'ekstern-flyt'} sendte ${skjemaId} til revidering fra steg ${stegNr}`);
            } else {
                // "Alle må avgjøre"-modus: samle beslutninger, sett stegets sluttbeslutning
                // først når alle konkrete Personer har levert. Ellers: normal behandling
                // (første behandler avgjør).
                const kreverAlle = stegObj.Beslutning_alle === true;
                const personer = (stegObj.Personer || []).map(p => String(p).toLowerCase());
                const aktor = upn ? String(upn).toLowerCase() : 'ekstern-flyt';

                if (kreverAlle && personer.length > 0) {
                    if (!Array.isArray(stegObj.Beslutninger)) stegObj.Beslutninger = [];
                    // Hindre duplikat fra samme aktør (idempotens ved retry)
                    const eksisterende = stegObj.Beslutninger.find(b => String(b.Aktor || '').toLowerCase() === aktor);
                    if (eksisterende) {
                        eksisterende.Beslutning = beslutning;
                        eksisterende.Dato = new Date().toISOString();
                        eksisterende.Kommentar = body?.kommentar || '';
                    } else {
                        stegObj.Beslutninger.push({
                            Aktor: upn || 'ekstern-flyt',
                            Beslutning: beslutning,
                            Dato: new Date().toISOString(),
                            Kommentar: body?.kommentar || ''
                        });
                    }
                    // Sjekk om alle konkrete personer har levert
                    const leverte = new Set(stegObj.Beslutninger.map(b => String(b.Aktor || '').toLowerCase()));
                    const alleLeverte = personer.every(p => leverte.has(p));

                    if (alleLeverte) {
                        // Sluttbeslutning = siste avgivelse (i praksis samme siden alle må godkjenne)
                        stegObj.Beslutning = beslutning;
                        stegObj.BehandletAv = 'alle-behandlere';
                        stegObj.BehandletDato = new Date().toISOString();
                        const antallSkippet = skipStegSomIkkeSkalKjore(skjema);
                        if (antallSkippet > 0) context.log(`beslutning: skippet ${antallSkippet} steg med uoppfylt vilkår`);
                        if (alleStegFerdig(skjema)) skjema.Skjema_status = 5;
                    } else {
                        const gjenstar = personer.filter(p => !leverte.has(p));
                        context.log(`beslutning: ${aktor} avga sin beslutning på steg ${stegNr}. Venter på: ${gjenstar.join(', ')}`);
                    }
                } else {
                    // Standard: første behandler avgjør
                    stegObj.Beslutning = beslutning;
                    stegObj.BehandletAv = upn || 'ekstern-flyt';
                    stegObj.BehandletDato = new Date().toISOString();
                    const antallSkippet = skipStegSomIkkeSkalKjore(skjema);
                    if (antallSkippet > 0) context.log(`beslutning: skippet ${antallSkippet} steg med uoppfylt vilkår`);
                    if (alleStegFerdig(skjema)) skjema.Skjema_status = 5;
                }
            }

            // Ved siste ferdig-status: anonymiser + krypter før lagring
            // (rekkefølge må være anonymiser → krypter, ellers krypteres den
            // ekte innsender-eposten i Alt-mode)
            if (skjema.Skjema_status === 5) {
                try {
                    const st = await skjemaStorage.hentSkjematype(skjematypeId);
                    const def = st?.JSON || {};
                    if (def.Anonymiseres) {
                        skjema = kryptering.anonymiserInnsender(skjema, process.env.HASH_SALT || '');
                        context.log(`beslutning: anonymiserte innsender for skjema ${skjemaId}`);
                    }
                    const omfang = def.Krypteres;
                    if (omfang === 'Svar' || omfang === 'Alt') {
                        const nokkel = await nokkelStorage.hentNokkel(skjematypeId);
                        if (nokkel) {
                            skjema = kryptering.krypterSkjema(skjema, nokkel, omfang);
                            // Bevar meta i klartekst for Svar-mode så register/liste fortsatt fungerer
                            context.log(`beslutning: krypterte skjema ${skjemaId} (${omfang})`);
                        } else {
                            context.log(`beslutning: Krypteres=${omfang} men mangler nøkkel for skjematype ${skjematypeId} — hoppes over`);
                        }
                    }
                } catch (e) {
                    // Ikke-blokkerende: lagre alt uansett i klartekst hvis kryptering feiler
                    context.log(`beslutning: kryptering/anonymisering feilet — ${e.message}`);
                }
            }

            await forekomstStorage.lagreSkjema(skjema, false);
            context.log(`beslutning: ${upn || 'ekstern-flyt'} satte steg ${stegNr}=${beslutning} på skjema ${skjemaId}`);
            hendelser.logg({
                Type: erFlowCallback ? 'skjema.beslutning.ekstern-flyt' : 'skjema.beslutning',
                Aktor: upn || 'ekstern-flyt',
                ObjektType: 'skjema', ObjektId: skjemaId,
                Melding: `Steg ${stegNr}: beslutning ${beslutning}${valgtValg?.Tekst ? ' (' + valgtValg.Tekst + ')' : ''}${erFlowCallback ? ' (via ekstern-flyt)' : ''}`,
                Detaljer: { skjematypeId, steg: stegNr, beslutning, tekst: valgtValg?.Tekst || '', nyStatus: skjema.Skjema_status, kilde: erFlowCallback ? 'ekstern-flyt' : 'bruker' }
            });

            // Varsling (fire-and-forget) — kalles etter lagring
            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            const skjematype = st?.JSON || {};
            const nyeAktive = beregnAktiveSteg(skjema);
            const alleFerdig = alleStegFerdig(skjema);
            const beslutningTekst = valgtValg?.Tekst || '';
            const varslOpts = { log: (m) => context.log(m), request };
            const log = (m) => context.log(m);
            const varslinger = [
                varsling.sendBeslutningVarsling(skjema, skjematype, stegObj, beslutning, beslutningTekst, body?.kommentar || '', varslOpts)
            ];
            if (!alleFerdig) {
                const flytSteg = nyeAktive.filter(s => (s.Flyt_url || '').trim());
                const vanligeSteg = nyeAktive.filter(s => !(s.Flyt_url || '').trim());
                varslinger.push(varsling.sendVarslingAktiveSteg(skjema, skjematype, vanligeSteg, varslOpts));
                for (const s of flytSteg) varslinger.push(kallEksternFlyt(s.Flyt_url, skjema, s, log));
            }
            Promise.all(varslinger).catch(e => context.log(`varsling/ekstern-flyt FEIL (beslutning): ${e.message}`));

            return {
                jsonBody: {
                    status: 'ok',
                    alleFerdig,
                    nyeAktive: nyeAktive.map(s => ({ Steg: s.Steg, Stegnavn: s.Stegnavn }))
                }
            };
        } catch (e) {
            context.log('beslutning FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * GET /api/mine-behandlinger — skjemaer der bruker er behandler på minst ett aktivt steg.
 * Returnerer { [skjematypeId]: [{ Skjema_id, Innsender_Epost, Sist_endret, Aktive_steg: [...] }] }
 *
 * Foreløpig full scan av Skjemaer med Skjemastatus=2. Optimeres senere.
 */
/**
 * Hjelper for dialog: sjekker om bruker har tilgang til skjemaet.
 * Returnerer { rolle: 'innsender' | 'behandler' | 'eier' | 'admin' | null }
 */
async function tilgangsRolle(skjema, skjematypeId, upn) {
    if (erAdmin(upn)) return 'admin';
    const upnLower = upn.toLowerCase();
    if ((skjema.Innsender_Epost || '').toLowerCase() === upnLower) return 'innsender';

    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return null;
    const eier = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    if (eier.length > 0) return 'eier';

    // Behandler-sjekk: er upn i noe steg.Personer eller i steg.Roller
    if (Array.isArray(skjema.Behandling)) {
        for (const steg of skjema.Behandling) {
            if (await brukerErBehandlerAsync(steg, upn)) return 'behandler';
        }
    }
    return null;
}

/**
 * POST /api/skjemaer/:type/:id/dialog — legg til dialog-innlegg
 * Body: { type: 'intern' | 'ekstern', tekst: '...' }
 *
 * Intern innlegg: krever behandler/eier/admin (ikke innsender)
 * Ekstern innlegg: alle med tilgang
 */
app.http('leggTilDialog', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}/dialog',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const body = await request.json();
            const type = String(body.type || '').toLowerCase();
            const tekst = String(body.tekst || '').trim();

            if (type !== 'intern' && type !== 'ekstern') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Type må være "intern" eller "ekstern"' } };
            }
            if (!tekst) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Tekst mangler' } };
            }

            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            const rolle = await tilgangsRolle(skjema, skjematypeId, upn);
            if (!rolle) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            if (type === 'intern' && rolle === 'innsender') {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Innsender kan ikke skrive interne innlegg' } };
            }

            if (!Array.isArray(skjema.Dialog)) skjema.Dialog = [];
            skjema.Dialog.push({
                Type: type,
                Avsender: upn,
                Tekst: tekst,
                Dato: new Date().toISOString()
            });

            await forekomstStorage.lagreSkjema(skjema, false);
            return { jsonBody: { status: 'ok', antallInnlegg: skjema.Dialog.length } };
        } catch (e) {
            context.log('dialog POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * POST /api/skjemaer/:type/:id/videresend
 * Body: { steg: N, tilUpn: 'x@y.no', notat?: '...' }
 * Legger til ny behandler på steget. Beholder opprinnelig (pilot-forenkling).
 * Registreres som intern dialog-innlegg.
 */
app.http('videresend', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}/videresend',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const body = await request.json();
            const stegNr = Number(body.steg);
            const tilUpn = String(body.tilUpn || '').trim().toLowerCase();
            const notat = String(body.notat || '').trim();
            if (!stegNr || !tilUpn) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Manglet steg eller tilUpn' } };
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tilUpn)) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'tilUpn er ikke en gyldig e-post' } };
            }

            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            const stegObj = (skjema.Behandling || []).find(s => Number(s.Steg) === stegNr);
            if (!stegObj) return { status: 404, jsonBody: { status: 'feil', melding: 'Behandlingssteg ikke funnet' } };
            if (!(await brukerErBehandlerAsync(stegObj, upn))) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Du er ikke behandler på dette steget' } };
            }
            if (stegErFerdig(stegObj)) {
                return { status: 409, jsonBody: { status: 'feil', melding: 'Steget er allerede behandlet' } };
            }

            // Legg til ny person hvis ikke allerede der
            if (!Array.isArray(stegObj.Personer)) stegObj.Personer = [];
            const alleredeThere = stegObj.Personer.some(p => String(p).toLowerCase() === tilUpn);
            if (!alleredeThere) stegObj.Personer.push(tilUpn);

            // Loggfør som intern dialog
            if (!Array.isArray(skjema.Dialog)) skjema.Dialog = [];
            skjema.Dialog.push({
                Type: 'intern',
                Avsender: upn,
                Tekst: `Videresendt steg ${stegNr} til ${tilUpn}${notat ? '. Notat: ' + notat : ''}`,
                Dato: new Date().toISOString()
            });

            await forekomstStorage.lagreSkjema(skjema, false);
            context.log(`videresend: ${upn} → ${tilUpn} på steg ${stegNr} (${skjemaId})`);

            // Varsle den nye behandleren (fire-and-forget)
            // Bygg midlertidig steg-objekt med kun den nye mottakeren så mail ikke går til alle igjen
            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            const skjematype = st?.JSON || {};
            const nyMottakerSteg = { ...stegObj, Personer: [tilUpn], Roller: [], Varsling: ['epost'] };
            const varslOpts = { log: (m) => context.log(m), request };
            varsling.sendBehandlerVarsling(skjema, skjematype, nyMottakerSteg, varslOpts)
                .catch(e => context.log(`varsling FEIL (videresend): ${e.message}`));

            return { jsonBody: { status: 'ok', personerNa: stegObj.Personer } };
        } catch (e) {
            context.log('videresend FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('mineBehandlinger', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'mine-behandlinger',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { odata } = require('@azure/data-tables');
            const { tabellKlient } = require('../lib/storage');
            const tabell = tabellKlient('Skjemaer');
            const iter = tabell.listEntities({
                queryOptions: { filter: odata`Skjemastatus eq ${2}` }
            });

            // Alle skjemaene deler de samme rollene og skjematypene. Uten memo
            // ble hver rolle og hver definisjon hentet på nytt per skjema.
            const cache = lagTilgangsCache();
            const defCache = new Map();
            const gruppert = {};
            for await (const entity of iter) {
                if (!entity.JSON) continue;
                let data;
                try { data = JSON.parse(entity.JSON); } catch { continue; }
                const skjema = await forekomstStorage.sikrFulltFormat(data, defCache);
                if (!Array.isArray(skjema?.Behandling)) continue;

                const aktive = beregnAktiveSteg(skjema);
                const mine = [];
                for (const s of aktive) {
                    if (await brukerErBehandlerAsync(s, upn, cache)) mine.push(s);
                }
                if (mine.length === 0) continue;

                const key = String(skjema.Skjematype_id || entity.partitionKey);
                if (!gruppert[key]) gruppert[key] = [];
                gruppert[key].push({
                    Skjema_id: skjema.Skjema_id,
                    Skjematype_id: skjema.Skjematype_id,
                    Innsender_Epost: skjema.Innsender_Epost,
                    Sist_endret: skjema.Sist_endret || entity.Oppdatert || '',
                    Aktive_steg: mine.map(s => ({ Steg: s.Steg, Stegnavn: s.Stegnavn || `Steg ${s.Steg}` }))
                });
            }
            return { jsonBody: gruppert };
        } catch (e) {
            context.log('mine-behandlinger FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('mineMellomlagrede', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'mine-mellomlagrede',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        try {
            const mine = await forekomstStorage.hentMineMellomlagrede(upn);
            // Grupper per skjematype: { [skjematypeId]: [skjemaer] }
            const gruppert = {};
            for (const s of mine) {
                const key = String(s.Skjematype_id);
                if (!gruppert[key]) gruppert[key] = [];
                gruppert[key].push(s);
            }
            return { jsonBody: gruppert };
        } catch (e) {
            context.log('mine-mellomlagrede FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nyttSkjemaId', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'ny-skjema-id/{skjematypeId}',
    handler: async (request, context) => {
        try {
            const skjematypeId = request.params.skjematypeId;
            const upn = hentInnloggetUpn(request);
            const utsendingHeader = request.headers.get('x-utsending-token');
            if (utsendingHeader) {
                const v = utsendingToken.valider(utsendingHeader);
                if (!v.gyldig || v.skjematypeId !== skjematypeId) {
                    return { status: 401, jsonBody: { status: 'feil', melding: v.melding || 'Ugyldig utsendings-token' } };
                }
            } else if (!upn) {
                // Ekstern-flyt: krev gyldig OTP-token + EksternTilgang=true
                const eksternAuth = await autentiserEkstern(request, skjematypeId);
                if (!eksternAuth.ok) {
                    return { status: 401, jsonBody: { status: 'feil', melding: eksternAuth.melding || 'Ikke innlogget' } };
                }
            } else {
                const tillatt = await harPublikumTilgang(skjematypeId, upn);
                if (!tillatt) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            }
            const skjemaId = await genererSkjemaId(skjematypeId);
            return { jsonBody: { Skjema_id: skjemaId } };
        } catch (e) {
            context.log('nyttSkjemaId FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('lagreSkjema', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjemaer',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const skjematypeId = String(body.Skjematype_id || '');
            if (!skjematypeId) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Skjematype_id mangler' } };
            }

            // Auth: SWA-innlogget bruker, ekstern OTP, ELLER utsendings-token
            const upn = hentInnloggetUpn(request);
            let eksternAuth = null;
            let utsendingAuth = null; // { batchId, mottaker, prefilled }
            const utsendingHeader = request.headers.get('x-utsending-token');
            if (utsendingHeader) {
                const v = utsendingToken.valider(utsendingHeader);
                if (!v.gyldig || v.skjematypeId !== skjematypeId) {
                    return { status: 401, jsonBody: { status: 'feil', melding: v.melding || 'Ugyldig utsendings-token' } };
                }
                const post = await utsendingStorage.hent(v.batchId, v.mottaker);
                if (!post || post.Jti !== v.jti) {
                    return { status: 401, jsonBody: { status: 'feil', melding: 'Utsending ikke funnet eller token erstattet' } };
                }
                if (post.SvarSkjemaId) {
                    return { status: 409, jsonBody: { status: 'feil', melding: 'Denne lenken er allerede besvart' } };
                }
                utsendingAuth = { batchId: v.batchId, mottaker: v.mottaker, prefilled: post.Prefilled || null };
            } else if (!upn) {
                eksternAuth = await autentiserEkstern(request, skjematypeId);
                if (!eksternAuth.ok) {
                    return { status: 401, jsonBody: { status: 'feil', melding: eksternAuth.melding || 'Ikke innlogget' } };
                }
            } else {
                // Innlogget: standard publikum/eier-sjekk
                const tillatt = await harPublikumTilgang(skjematypeId, upn);
                if (!tillatt) {
                    return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang til denne skjematypen' } };
                }
            }
            const innsenderId = utsendingAuth ? utsendingAuth.mottaker
                : (eksternAuth ? eksternInnsenderUpn(eksternAuth.mottaker, eksternAuth.kanal) : upn);

            // Hent eksisterende for å avgjøre erNytt og bevare metadata (Behandling, Dialog)
            let skjemaId = body.Skjema_id ? String(body.Skjema_id) : null;
            let eksisterende = null;
            if (skjemaId) {
                eksisterende = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            }
            const erNytt = !eksisterende;
            if (!skjemaId) {
                skjemaId = await genererSkjemaId(skjematypeId);
            }

            // Ved nytt skjema: arv Behandling-struktur fra skjematypen
            let behandlingArvet = null;
            if (erNytt) {
                const st = await skjemaStorage.hentSkjematype(skjematypeId);
                if (Array.isArray(st?.JSON?.Behandling)) {
                    behandlingArvet = JSON.parse(JSON.stringify(st.JSON.Behandling)).map(steg => ({
                        ...steg,
                        Beslutning: 0
                    }));
                }
            }

            // Ved oppdatering: krev at innsender-ID matcher (ekstern kan bare
            // endre EGET mellomlagret skjema)
            if (eksisterende && eksternAuth) {
                const eksistInns = (eksisterende.Innsender_Epost || eksisterende.Innsender_epost || '').toLowerCase();
                if (eksistInns !== innsenderId.toLowerCase()) {
                    return { status: 403, jsonBody: { status: 'avvist', melding: 'Ikke ditt skjema' } };
                }
            }

            // Bygg skjemadata. Ved oppdatering: start med eksisterende (bevar Behandling,
            // Dialog, vedlegg-refs) og la body overstyre med nye svar/status.
            let skjemaData = {
                ...(eksisterende || {}),
                ...body,
                Skjema_id: skjemaId,
                Skjematype_id: skjematypeId,
                // Bevar original innsender ved oppdatering
                Innsender_Epost: eksisterende?.Innsender_Epost || innsenderId,
                Skjema_status: body.Skjema_status || eksisterende?.Skjema_status || 2
            };
            if (eksternAuth) {
                skjemaData.EksternInnsender = true;
                skjemaData.Innsender_Kanal = eksternAuth.kanal;
            }
            if (utsendingAuth) {
                skjemaData.Utsending_BatchId = utsendingAuth.batchId;
                // Overstyr prefilled felter — bruker skal ikke kunne endre dem.
                // Prefilled er format { "sek-felt-padded": [verdi(er)] }.
                if (utsendingAuth.prefilled && Array.isArray(skjemaData.Seksjoner)) {
                    for (const [nokkel, sva] of Object.entries(utsendingAuth.prefilled)) {
                        // Oppslags-referanser (f.eks. { emnebeskrivelse: "..." }) fyller
                        // informasjonsfelt og har ingen svarverdi å låse. Se
                        // lib/utsending-prefill.js.
                        if (prefill.erOppslag(sva)) continue;
                        const m = /^(\d+)-(\d+)$/.exec(nokkel);
                        if (!m) continue;
                        const sekNr = Number(m[1]), feltNr = m[2].padStart(2, '0');
                        for (const s of skjemaData.Seksjoner) {
                            if (Number(s.Seksjon_nummer || s.Nummer) !== sekNr) continue;
                            for (const f of (s.Felter || [])) {
                                if (String(f.Nummer).padStart(2, '0') !== feltNr) continue;
                                f.Svar = Array.isArray(sva) ? sva : [sva];
                            }
                        }
                    }
                }
            }
            if (behandlingArvet && !Array.isArray(skjemaData.Behandling)) {
                skjemaData.Behandling = behandlingArvet;
            }

            // Ved innsending: frys dynamiske rolleomfang («Klassesjef({2-01})» →
            // «Klassesjef(MILM23-1)») mens svarene ennå er i klartekst. Må skje
            // før krypteringen under, og før varslingen som leser steg.Roller.
            const erInnsending = skjemaData.Skjema_status === 2
                && (erNytt || (eksisterende?.Skjema_status || 0) !== 2);
            if (erInnsending && Array.isArray(skjemaData.Behandling)) {
                try {
                    const { ekspanderte, uloste } = await dynamiskRolle.ekspanderBehandling(skjemaData);
                    for (const e of ekspanderte) {
                        context.log(`dynamisk-rolle: steg ${e.steg} "${e.mal}" → "${e.rolle}"` +
                            (e.vurderte?.length > 1 ? ` (vurderte: ${e.vurderte.join(', ')})` : ''));
                    }
                    for (const u of uloste) {
                        context.log(`dynamisk-rolle: steg ${u.steg} "${u.mal}" — feltet er ubesvart, malen beholdes`);
                    }
                    if (ekspanderte.length > 0 || uloste.length > 0) {
                        hendelser.logg({
                            Type: 'behandling.rolle.ekspandert', Aktor: innsenderId,
                            ObjektType: 'skjema', ObjektId: skjemaId,
                            Melding: `Løste opp ${ekspanderte.length} dynamisk${ekspanderte.length === 1 ? ' rolle' : 'e roller'}` +
                                (uloste.length ? `, ${uloste.length} uløst` : ''),
                            Detaljer: { ekspanderte, uloste }
                        });
                    }
                } catch (e) {
                    // Ekspansjon skal ikke velte en innsending — steget beholder
                    // malen og fanges opp av hendelsesloggen over.
                    context.log(`dynamisk-rolle: ekspansjon feilet — ${e.message}`);
                }
            }

            // Ved innsending: kjør skip-logikk så steg som ikke oppfyller vilkår
            // markeres som "Hoppet over" med én gang, og skjemaet kan lukkes hvis alt skippes.
            // NB: alleStegFerdig() returnerer true for 0 steg — så skjematyper uten
            // Behandling får Skjema_status=5 ved innsending (går rett til avsluttet).
            if (skjemaData.Skjema_status === 2) {
                if (Array.isArray(skjemaData.Behandling)) {
                    skipStegSomIkkeSkalKjore(skjemaData);
                }
                if (alleStegFerdig(skjemaData)) {
                    skjemaData.Skjema_status = 5;
                }
            }

            // Rollelista for klassesjefer vedlikeholdes manuelt — fang opp steg
            // som ellers ville blitt stående uten behandler. Etter skip-logikken,
            // så steg som uansett ikke skal kjøre ikke gir falsk alarm.
            if (erInnsending && Array.isArray(skjemaData.Behandling)) {
                try {
                    const mangler = await dynamiskRolle.sikreBehandler(skjemaData, (m) => context.log(m));
                    for (const m of mangler) {
                        context.log(`dynamisk-rolle: steg ${m.steg} har ingen innehavere (${m.roller.join(', ')})` +
                            (m.dekket ? ` — reserverolle "${m.reserverolle}" lagt til` : ' — INGEN reserverolle satt'));
                        hendelser.logg({
                            Type: 'behandling.uten-behandler', Aktor: innsenderId,
                            ObjektType: 'skjema', ObjektId: skjemaId,
                            Melding: `Steg ${m.steg} manglet behandler` +
                                (m.dekket ? ` — reserverolle "${m.reserverolle}" brukt` : ' — ingen reserverolle satt'),
                            Detaljer: m
                        });
                    }
                } catch (e) {
                    context.log(`dynamisk-rolle: behandler-sjekk feilet — ${e.message}`);
                }
            }

            // Ved status=5 (avsluttet): anonymiser + krypter før lagring.
            // Trigges både for skjematyper uten behandling (direkte-arkivering)
            // og for de som ble ferdig etter siste beslutning.
            if (skjemaData.Skjema_status === 5) {
                try {
                    const st = await skjemaStorage.hentSkjematype(skjematypeId);
                    const def = st?.JSON || {};
                    if (def.Anonymiseres) {
                        skjemaData = kryptering.anonymiserInnsender(skjemaData, process.env.HASH_SALT || '');
                        context.log(`lagreSkjema: anonymiserte innsender for skjema ${skjemaId}`);
                    }
                    const omfang = def.Krypteres;
                    if (omfang === 'Svar' || omfang === 'Alt') {
                        const nokkel = await nokkelStorage.hentNokkel(skjematypeId);
                        if (nokkel) {
                            skjemaData = kryptering.krypterSkjema(skjemaData, nokkel, omfang);
                            context.log(`lagreSkjema: krypterte skjema ${skjemaId} (${omfang})`);
                        } else {
                            context.log(`lagreSkjema: Krypteres=${omfang} men mangler nøkkel for skjematype ${skjematypeId} — hoppes over`);
                        }
                    }
                } catch (e) {
                    context.log(`lagreSkjema: kryptering/anonymisering feilet — ${e.message}`);
                }
            }

            await forekomstStorage.lagreSkjema(skjemaData, erNytt);
            context.log(`skjemaer: ${innsenderId}${eksternAuth ? ' (ekstern)' : ''} ${erNytt ? 'opprettet' : 'oppdaterte'} ${skjemaId} (type ${skjematypeId})`);
            hendelser.logg({
                Type: erNytt ? 'skjema.opprett' : (skjemaData.Skjema_status === 1 ? 'skjema.mellomlagre' : 'skjema.innsend'),
                Aktor: innsenderId,
                ObjektType: 'skjema', ObjektId: skjemaId,
                Melding: `${erNytt ? 'Opprettet' : 'Oppdaterte'} skjema (status ${skjemaData.Skjema_status})`,
                Detaljer: { skjematypeId, status: skjemaData.Skjema_status, ekstern: !!eksternAuth, utsending: utsendingAuth?.batchId || null }
            });

            // Marker utsending som besvart når skjemaet er sendt inn (status ≥ 2)
            if (utsendingAuth && skjemaData.Skjema_status >= 2) {
                try {
                    await utsendingStorage.markerBesvart(utsendingAuth.batchId, utsendingAuth.mottaker, skjemaId);
                } catch (e) {
                    context.log(`utsending: kunne ikke markere besvart — ${e.message}`);
                }
            }

            // Varsling ved innsending (status 2 = Innsendt, ellers mellomlagring)
            // Fire-and-forget så feil i SMTP ikke feiler hovedhandlingen.
            // NB: samme uttrykk som erInnsending over, men evaluert etter skip-
            // logikken. Et skjema der alle steg ble hoppet over står nå med
            // status 5 og varsles ikke — bevisst forskjell, ikke duplisering.
            const bleInnsendt = skjemaData.Skjema_status === 2 && (erNytt || (eksisterende?.Skjema_status || 0) !== 2);
            if (bleInnsendt) {
                const st = await skjemaStorage.hentSkjematype(skjematypeId);
                const skjematype = st?.JSON || {};
                const aktive = beregnAktiveSteg(skjemaData);
                const varslOpts = { log: (m) => context.log(m), request };

                // Splitt aktive: eksterne flyt-steg vs vanlige (som får varsling)
                const flytSteg = aktive.filter(s => (s.Flyt_url || '').trim());
                const vanligeSteg = aktive.filter(s => !(s.Flyt_url || '').trim());

                const log = (m) => context.log(m);
                Promise.all([
                    varsling.sendInnsenderKvittering(skjemaData, skjematype, varslOpts),
                    varsling.sendVarslingAktiveSteg(skjemaData, skjematype, vanligeSteg, varslOpts),
                    ...flytSteg.map(s => kallEksternFlyt(s.Flyt_url, skjemaData, s, log)),
                    oppdaterSPListe(skjemaData, skjematype, log)
                ]).catch(e => context.log(`varsling/ekstern-flyt/sp FEIL (innsending): ${e.message}`));
            }

            return {
                jsonBody: {
                    status: 'ok',
                    Skjema_id: skjemaId,
                    Skjematype_id: skjematypeId
                }
            };
        } catch (e) {
            context.log('skjemaer POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('listSkjemaer', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjema-liste/{skjematypeId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const skjematypeId = request.params.skjematypeId;

            // Kun eiere (eller admin) kan liste alle skjemaer for en type
            const erEier = await harEierTilgang(skjematypeId, upn);
            if (!erEier) return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever eier-tilgang' } };

            // Finn hvilke felter som er filtrerbare i skjematypen — kun disse
            // trenger svar-verdi i lista (register-filtre + kolonne-fremvisning).
            const st = await skjemaStorage.hentSkjematype(skjematypeId);
            const filterFelt = []; // [{sekNr, feltNrPadded}]
            for (const s of (st?.JSON?.Seksjoner || [])) {
                for (const f of (s.Felter || [])) {
                    if ((f.Filtrerbar || f.Filtrerbar_i_register) && f.Type !== 'Informasjon') {
                        filterFelt.push({
                            sekNr: String(s.Seksjon_nummer),
                            feltNrPadded: String(f.Nummer).padStart(2, '0')
                        });
                    }
                }
            }

            // Rask sti: ingen filtrerbare felt → hopp over JSON-parse + ekspandering
            // + dekryptering. Returnerer bare metadata-kolonner fra tabellen.
            if (filterFelt.length === 0) {
                const raskListe = await forekomstStorage.hentMetadataForType(skjematypeId);
                raskListe.sort((a, b) => (b.Sist_endret || '').localeCompare(a.Sist_endret || ''));
                return { jsonBody: raskListe };
            }

            // Full sti: filterFelt finnes → last JSON og ekspander + evt. dekrypter
            const alle = await forekomstStorage.hentAlleSkjemaerForType(skjematypeId);

            function hentFilterSvar(sk) {
                const ut = {};
                for (const { sekNr, feltNrPadded } of filterFelt) {
                    const nokkel = `${sekNr}-${feltNrPadded}`;
                    // Fullt format
                    if (Array.isArray(sk?.Seksjoner)) {
                        for (const s of sk.Seksjoner) {
                            if (String(s.Seksjon_nummer || s.Nummer || '') !== sekNr) continue;
                            for (const f of (s.Felter || [])) {
                                if (String(f.Nummer).padStart(2, '0') !== feltNrPadded) continue;
                                ut[nokkel] = Array.isArray(f.Svar) ? f.Svar : [];
                            }
                        }
                    }
                    // Kompakt format
                    if (ut[nokkel] === undefined && Array.isArray(sk?.Svar)) {
                        for (const s of sk.Svar) {
                            if (String(s.sek) !== sekNr) continue;
                            if (String(s.spm).padStart(2, '0') !== feltNrPadded) continue;
                            ut[nokkel] = Array.isArray(s.sva) ? s.sva : [];
                        }
                    }
                    if (ut[nokkel] === undefined) ut[nokkel] = [];
                }
                return ut;
            }

            // Dekrypter kun hvis lista trenger FilterSvar (unngår kostnad når ingen filter-felt)
            // og bare for skjemaer som faktisk er krypterte.
            const trengerDekrypt = filterFelt.length > 0 && alle.some(s => s?.Kryptert);
            const nokkelForType = trengerDekrypt ? await nokkelStorage.hentNokkel(skjematypeId) : null;
            function dekrypterIList(s) {
                if (!s?.Kryptert || !nokkelForType) return s;
                try { return kryptering.dekrypterSkjema(s, nokkelForType); }
                catch (_) { return s; }
            }

            // Kompakt liste — feltene registeret trenger for kolonner + filter-svar
            const liste = alle.map(sRå => {
                const s = filterFelt.length > 0 ? dekrypterIList(sRå) : sRå;
                return {
                    Skjema_id: s.Skjema_id,
                    Skjematype_id: s.Skjematype_id,
                    Skjema_navn: s.Skjema_navn || '',
                    Innsender_Epost: s.Innsender_Epost || s.Innsender_epost || '',
                    Skjema_status: s.Skjema_status || 0,
                    Opprettet: s.Opprettet || s.OpprettetDato || '',
                    Sist_endret: s.Sist_endret || s.Oppdatert || '',
                    FilterSvar: filterFelt.length > 0 ? hentFilterSvar(s) : undefined
                };
            });

            // Nyeste først
            liste.sort((a, b) => (b.Sist_endret || '').localeCompare(a.Sist_endret || ''));

            return { jsonBody: liste };
        } catch (e) {
            context.log('skjemaer/liste FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('slettSkjema', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const { skjematypeId, skjemaId } = request.params;
            const skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            // Kun eier, admin eller innsender selv kan slette
            const upnLower = upn.toLowerCase();
            const erInnsender = (skjema.Innsender_Epost || '').toLowerCase() === upnLower;
            if (!erInnsender && !erAdmin(upn)) {
                const erEier = await harEierTilgang(skjematypeId, upn);
                if (!erEier) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            }

            const slettet = await forekomstStorage.slettSkjema(skjemaId, skjematypeId);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            // Slett også alle vedlegg for skjemaet (best-effort)
            try {
                const antall = await vedleggStorage.slettAlleVedleggForSkjema(skjematypeId, skjemaId);
                if (antall > 0) context.log(`skjemaer DELETE: ryddet ${antall} vedlegg for ${skjemaId}`);
            } catch (e) {
                context.log(`skjemaer DELETE: kunne ikke rydde vedlegg for ${skjemaId}: ${e.message}`);
            }

            context.log(`skjemaer DELETE: ${upn} slettet ${skjemaId} (type ${skjematypeId})`);
            hendelser.logg({
                Type: 'skjema.slett', Aktor: upn,
                ObjektType: 'skjema', ObjektId: skjemaId,
                Melding: `Slettet skjema`, Detaljer: { skjematypeId }
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('skjemaer DELETE FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('hentSkjema', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjemaer/{skjematypeId}/{skjemaId}',
    handler: async (request, context) => {
        try {
            const { skjematypeId, skjemaId } = request.params;
            let skjema = await forekomstStorage.hentSkjema(skjemaId, skjematypeId);
            if (!skjema) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjema ikke funnet' } };

            const upn = hentInnloggetUpn(request);

            // Ekstern-tilgang via OTP-token
            if (!upn) {
                const eksternAuth = await autentiserEkstern(request, skjematypeId);
                if (!eksternAuth.ok) {
                    return { status: 401, jsonBody: { status: 'feil', melding: eksternAuth.melding || 'Ikke innlogget' } };
                }
                const innsenderId = eksternInnsenderUpn(eksternAuth.mottaker, eksternAuth.kanal);
                const eksistInns = (skjema.Innsender_Epost || skjema.Innsender_epost || '').toLowerCase();
                if (eksistInns !== innsenderId.toLowerCase()) {
                    return { status: 403, jsonBody: { status: 'avvist', melding: 'Ikke ditt skjema' } };
                }
                // Ekstern får skjemaet dekryptert (uten behandler-info-berikelse)
                skjema = await dekrypterHvisKryptert(skjema, skjematypeId, context);
                return { jsonBody: skjema };
            }

            // Tilgang: admin, eier, innsender selv, ELLER behandler (Personer/Roller)
            //   på et aktivt steg.
            const upnLower = upn.toLowerCase();
            const erInnsender = (skjema.Innsender_Epost || '').toLowerCase() === upnLower;
            const aktive = beregnAktiveSteg(skjema);

            // Bygg liste over hvilke aktive steg brukeren er behandler for (via
            // Personer eller Roller). Brukes både til tilgangsvurdering og som
            // beriket felt i responsen (_mineStegNumre) så frontend slipper
            // rolle-oppslag på sin side.
            const mineStegNumre = [];
            for (const s of aktive) {
                if (await brukerErBehandlerAsync(s, upn)) mineStegNumre.push(Number(s.Steg));
            }

            let erEier = false;
            if (!erInnsender && !erAdmin(upn) && mineStegNumre.length === 0) {
                erEier = await harEierTilgang(skjematypeId, upn);
                if (!erEier) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
            }

            // Dekrypter for autorisert bruker (admin/eier/innsender/behandler)
            skjema = await dekrypterHvisKryptert(skjema, skjematypeId, context);

            // Filtrer interne dialog-innlegg for innsender (uten annen rolle)
            if (Array.isArray(skjema.Dialog) && skjema.Dialog.length > 0) {
                const rolle = await tilgangsRolle(skjema, skjematypeId, upn);
                if (rolle === 'innsender') {
                    skjema.Dialog = skjema.Dialog.filter(d => d.Type !== 'intern');
                }
            }

            skjema._mineStegNumre = mineStegNumre;
            return { jsonBody: skjema };
        } catch (e) {
            context.log('skjemaer GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
