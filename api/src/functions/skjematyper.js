/**
 * Skjematype-endepunkter.
 *
 *   GET  /api/skjematyper           — mine skjematyper (filtrert på tilgang)
 *   GET  /api/skjematyper/:id       — hent én skjematype (må ha tilgang)
 *   POST /api/skjematyper           — opprett/oppdater (admin only)
 *
 * Auth via SWA — bruker plukkes fra x-ms-client-principal-header.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const skjemaStorage = require('../lib/skjema-storage');
const { filtrerTyperPåTilgang, lagTilgangsCache } = require('../lib/tilgang');
const { hentOgSettFasteData } = require('../lib/faste-data');
const { hentDropdownVerdier } = require('../lib/oppslag');
const { erTilgjengeligNaa } = require('../lib/periode');
const rollerStorage = require('../lib/roller-storage');
const hendelser = require('../lib/hendelser-storage');
const gevinstSjekk = require('../lib/gevinst-sjekk');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const svarReparasjon = require('../lib/svar-reparasjon');

async function nesteSkjematypeId() {
    const alle = await skjemaStorage.hentAlleSkjematyper();
    let max = 0;
    for (const st of alle) {
        const n = parseInt(st.id, 10);
        if (!isNaN(n) && n > max) max = n;
    }
    return String(max + 1);
}

async function harEierPåType(skjematypeId, upn) {
    if (erAdmin(upn)) return true;
    const st = await skjemaStorage.hentSkjematype(skjematypeId);
    if (!st) return false;
    const treff = await filtrerTyperPåTilgang([st], upn, 'Eiere');
    return treff.length > 0;
}

/**
 * Mapping fra intern representasjon til frontend-vennlig format.
 * ErEier og KanFylle indikerer hvilke handlingsknapper som skal vises.
 * Ekstra felter kommer etter hvert (mellomlagrede, behandle-antall, m.m.).
 */
function tilKortformat(st, erEier, kanFylle) {
    const data = st.JSON || {};
    const iPeriode = erTilgjengeligNaa(data.Tilgjengelighetsperioder);
    return {
        Skjematype_id: st.id,
        Skjema_navn: st.navn || data.Skjema_navn || '',
        Skjema_forklaring: data.Skjemaforklaring
            ? { Verdi: data.Skjemaforklaring.Innhold || '', Format: data.Skjemaforklaring.Format || 'Tekst' }
            : null,
        Logo_url: data.Logo_url || '',
        Fase: data.Fase || 'Produksjon',
        ErEier: erEier,
        // Utfylling blokkeres utenfor tilgjengelighetsperioden — eier ser kortet uansett
        KanFylle: kanFylle && iPeriode,
        ErIPeriode: iPeriode,
        Tilgjengelighetsperioder: data.Tilgjengelighetsperioder || [],
        AlleTilgang: data.Publikum?.AlleTilgang === true
    };
}

app.http('mineSkjematyper', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjematyper',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const alle = await skjemaStorage.hentAlleSkjematyper();

            // For admin: se alt som både eier og publikum. Ellers: filtrer på Eier/Publikum.
            let eierIder, publikumsIder, aktuelle;
            if (erAdmin(upn)) {
                aktuelle = alle;
                eierIder = new Set(alle.map(t => String(t.id)));
                publikumsIder = new Set(alle.map(t => String(t.id)));
            } else {
                // Samme cache i begge passeringene — rollene går igjen på tvers
                // av skjematypene, og hver av dem koster en Table-spørring.
                const cache = lagTilgangsCache();
                const [eiere, publikum] = await Promise.all([
                    filtrerTyperPåTilgang(alle, upn, 'Eiere', cache),
                    filtrerTyperPåTilgang(alle, upn, 'Publikum', cache)
                ]);
                eierIder = new Set(eiere.map(t => String(t.id)));
                publikumsIder = new Set(publikum.map(t => String(t.id)));
                const map = new Map();
                [...eiere, ...publikum].forEach(t => map.set(String(t.id), t));
                aktuelle = [...map.values()];
            }

            // Fase-filter:
            //   Utvikling  — admin + eiere (skjult for vanlige publikum-brukere)
            //   Produksjon — alle med tilgang
            // Historisk 'Test'-fase behandles som Utvikling.
            const filtrertPåFase = aktuelle.filter(t => {
                const fase = t.JSON?.Fase || 'Produksjon';
                if (fase === 'Produksjon') return true;
                if (erAdmin(upn)) return true;
                if (eierIder.has(String(t.id))) return true;
                return false;
            });

            const resultat = filtrertPåFase
                .map(t => tilKortformat(t, eierIder.has(String(t.id)), publikumsIder.has(String(t.id))))
                .sort((a, b) => (a.Skjema_navn || '').localeCompare(b.Skjema_navn || '', 'nb'));

            return { jsonBody: resultat };
        } catch (e) {
            context.log('skjematyper GET FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * Anonymt endepunkt for ekstern-innsender-flyten. Returnerer skjematypen
 * KUN hvis EksternTilgang=true. Innhold beriket med FasteData som vanlig.
 * Ingen SWA-cookie kreves.
 */
app.http('hentSkjematypeEkstern', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjematyper/{id}/publikum',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const st = await skjemaStorage.hentSkjematype(id);
            if (!st) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };
            if (!st.JSON?.EksternTilgang) {
                return { status: 403, jsonBody: { status: 'avvist', melding: 'Ikke tilgjengelig for eksterne' } };
            }
            const berikaSkjema = await hentOgSettFasteData(
                st.JSON,
                (dk, fb, fo, fv) => hentDropdownVerdier(dk, fb, fo, fv, (m) => context.log('oppslag: ' + m)),
                null,
                (m) => context.log('faste-data: ' + m)
            );
            return { jsonBody: berikaSkjema };
        } catch (e) {
            context.log('skjematyper/publikum FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * Hvor mange skjemaer finnes allerede av denne typen?
 *
 * Editoren spør om dette for å kunne advare før et felt slettes eller flyttes.
 * Feltnummer tildeles etter posisjon, så en slik endring forskyver svarene i
 * skjemaer som alt er lagret — de havner under nabospørsmålet, og det ser
 * riktig ut. Nye skjemaer bærer feltets Id og tåler flyttingen; eldre gjør det
 * ikke, og det er dem advarselen gjelder.
 *
 * Leser bare metadatakolonner, ikke JSON — kallet skal være billig nok til å
 * gjøres hver gang editoren åpner en eksisterende skjematype.
 */
app.http('antallSkjemaerForType', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjematyper/{id}/antall-skjemaer',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const id = request.params.id;
            const rader = await forekomstStorage.hentMetadataForType(id);
            // Mellomlagrede (status 1) teller med: også de har svar som kan
            // forskyves, og eieren merker det først når skjemaet åpnes igjen.
            const innsendte = rader.filter(r => Number(r.Skjema_status) !== 1).length;
            return { jsonBody: { antall: rader.length, innsendte } };
        } catch (e) {
            context.log('skjematyper/antall-skjemaer FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * Hva ville en lagring gjort med de eksisterende svarene?
 *
 * Editoren spør om dette rett før den lagrer, så brukeren kan få se antallet
 * og bestemme. Etter lagring er spørsmålet umulig å stille: da er den gamle
 * definisjonen overskrevet, og det finnes ikke lenger noe å sammenligne med.
 *
 * Endrer ingenting — body er den foreslåtte definisjonen, ikke en lagring.
 */
app.http('analyserFlytting', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjematyper/{id}/analyser-flytting',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const id = request.params.id;
            const tillatt = await harEierPåType(id, upn);
            if (!tillatt) return { status: 403, jsonBody: { status: 'avvist', melding: 'Kun eier eller admin' } };

            const forrige = await skjemaStorage.hentSkjematype(id);
            if (!forrige?.JSON) return { jsonBody: { flyttinger: 0, berørte: 0, fjernet: 0 } };

            const foreslått = await request.json();
            const kart = svarReparasjon.byggFlyttekart(forrige.JSON, foreslått);
            if (kart.flyttinger.length === 0) {
                return { jsonBody: { flyttinger: 0, berørte: 0, fjernet: kart.fjernet.length } };
            }

            const res = await svarReparasjon.reparerAlle({
                skjematypeId: id, flyttinger: kart.flyttinger, torrkjor: true
            }, { log: (m) => context.log(m) });

            return {
                jsonBody: {
                    flyttinger: kart.flyttinger.length,
                    fjernet: kart.fjernet.length,
                    berørte: res.berørte,
                    vurdert: res.vurdert
                }
            };
        } catch (e) {
            context.log('skjematyper/analyser-flytting FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('hentSkjematype', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'skjematyper/{id}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const id = request.params.id;
            const st = await skjemaStorage.hentSkjematype(id);
            if (!st) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };

            // Tilgang: admin, eier eller publikum
            if (!erAdmin(upn)) {
                const cache = lagTilgangsCache();
                const [eier, publikum] = await Promise.all([
                    filtrerTyperPåTilgang([st], upn, 'Eiere', cache),
                    filtrerTyperPåTilgang([st], upn, 'Publikum', cache)
                ]);
                if (eier.length === 0 && publikum.length === 0) {
                    return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };
                }
            }

            // Rå-modus (editor): returner definisjon uten FasteData-berikelse
            // så editor kan redigere selve datakilde/filter-oppsettet.
            if (request.query.get('rå') === '1' || request.query.get('raw') === '1') {
                return { jsonBody: st.JSON };
            }

            // Fyll Valg-arrays for felter med FasteData (masterdata-oppslag) — for utfylling
            const berikaSkjema = await hentOgSettFasteData(
                st.JSON,
                (dk, fb, fo, fv) => hentDropdownVerdier(dk, fb, fo, fv, (m) => context.log('oppslag: ' + m)),
                upn,
                (m) => context.log('faste-data: ' + m)
            );

            return { jsonBody: berikaSkjema };
        } catch (e) {
            context.log('skjematyper GET :id FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('lagreSkjematype', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'skjematyper',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const body = await request.json();

            // Ny skjematype: admin eller medlem av rollen "Skjemaskaper" kan opprette.
            // Oppretter legges automatisk som eier. Eksisterende: krev admin eller eier.
            let erNy = false;
            if (!body.Skjematype_id) {
                const admin = erAdmin(upn);
                const skjemaskaper = admin || await rollerStorage.erMedlem('Skjemaskaper', upn);
                if (!skjemaskaper) {
                    return { status: 403, jsonBody: { status: 'avvist', melding: 'Krever admin eller rollen "Skjemaskaper" for å opprette ny skjematype' } };
                }
                body.Skjematype_id = await nesteSkjematypeId();
                erNy = true;
                // Sikre at oppretter blir eier (defensivt — frontend gjør dette allerede)
                if (!body.Eiere || typeof body.Eiere !== 'object') body.Eiere = { Personer: [], Roller: [], Team: [] };
                if (!Array.isArray(body.Eiere.Personer)) body.Eiere.Personer = [];
                const upnLower = upn.toLowerCase();
                const finnes = body.Eiere.Personer.some(p => String(p).toLowerCase() === upnLower);
                if (!finnes) body.Eiere.Personer.push(upn);
            } else {
                const tillatt = await harEierPåType(body.Skjematype_id, upn);
                if (!tillatt) return { status: 403, jsonBody: { status: 'avvist', melding: 'Kun eier eller admin kan endre denne skjematypen' } };
            }

            // Flyttekartet må regnes ut FØR lagring — etterpå er den gamle
            // definisjonen borte, og da finnes det ikke lenger noe å
            // sammenligne med. Selve reparasjonen skjer etter lagring, og bare
            // hvis klienten har bedt om den.
            let flyttinger = [];
            if (!erNy) {
                const forrige = await skjemaStorage.hentSkjematype(body.Skjematype_id);
                if (forrige?.JSON) {
                    flyttinger = svarReparasjon.byggFlyttekart(forrige.JSON, body).flyttinger;
                }
            }

            await skjemaStorage.lagreSkjematype(body);
            context.log(`skjematyper: ${upn} ${erNy ? 'opprettet' : 'oppdaterte'} skjematype ${body.Skjematype_id}`);
            hendelser.logg({
                Type: erNy ? 'skjematype.opprett' : 'skjematype.oppdater',
                Aktor: upn,
                ObjektType: 'skjematype', ObjektId: String(body.Skjematype_id),
                Melding: `${erNy ? 'Opprettet' : 'Oppdaterte'} skjematype "${body.Skjema_navn || ''}"`,
                Detaljer: { fase: body.Fase || '', krypteres: body.Krypteres || 'Nei', anonymiseres: !!body.Anonymiseres }
            });
            // Nullpunktsjekk ved produksjonssetting. Advarsel, ikke sperre:
            // eieren skal kunne gå videre, men ikke uten å vite at baseline
            // mangler. Feiler sjekken, lagres skjematypen likevel — en
            // påminnelse er ikke verdt å miste et lagret skjema for.
            let nullpunkt = null;
            if (String(body.Fase || '') === 'Produksjon') {
                try {
                    nullpunkt = await gevinstSjekk.nullpunktRegistrert(body.Skjematype_id);
                } catch (e) {
                    context.log('skjematyper: nullpunktsjekk feilet — ' + e.message);
                }
            }

            // Har feltnumre flyttet seg, teller vi hvor mange lagrede skjemaer
            // som er rammet — og reparerer dem hvis klienten ba om det.
            // Tørrkjøring er standard: en reparasjon som treffer feil er
            // vanskeligere å oppdage enn en som ikke ble kjørt.
            let reparasjon = null;
            if (flyttinger.length > 0) {
                try {
                    reparasjon = await svarReparasjon.reparerAlle({
                        skjematypeId: body.Skjematype_id,
                        flyttinger,
                        torrkjor: body.reparerSvar !== true
                    }, { log: (m) => context.log(m) });

                    if (!reparasjon.torrkjor) {
                        context.log(`skjematyper: ${upn} reparerte ${reparasjon.reparert} skjema(er) etter omnummerering av ${body.Skjematype_id}`);
                        hendelser.logg({
                            Type: 'skjematype.reparer-svar', Aktor: upn,
                            ObjektType: 'skjematype', ObjektId: String(body.Skjematype_id),
                            Melding: `Flyttet svar i ${reparasjon.reparert} skjema etter omnummerering`,
                            Detaljer: { berørte: reparasjon.berørte, feilet: reparasjon.feilet, flyttinger: flyttinger.length }
                        });
                    }
                } catch (e) {
                    context.log('skjematyper: svar-reparasjon feilet — ' + e.message);
                }
            }

            return {
                jsonBody: {
                    status: 'ok', Skjematype_id: body.Skjematype_id, erNy,
                    ...(reparasjon ? { reparasjon } : {}),
                    ...(nullpunkt && nullpunkt.sjekket && !nullpunkt.registrert
                        ? { advarsel: nullpunkt.melding }
                        : {})
                }
            };
        } catch (e) {
            context.log('skjematyper POST FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('slettSkjematype', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'skjematyper/{id}',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };

        try {
            const id = request.params.id;
            const tillatt = await harEierPåType(id, upn);
            if (!tillatt) return { status: 403, jsonBody: { status: 'avvist', melding: 'Kun eier eller admin kan slette denne skjematypen' } };

            const slettet = await skjemaStorage.slettSkjematype(id);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Skjematype ikke funnet' } };

            context.log(`skjematyper DELETE: ${upn} slettet skjematype ${id}`);
            hendelser.logg({
                Type: 'skjematype.slett', Aktor: upn,
                ObjektType: 'skjematype', ObjektId: String(id),
                Melding: `Slettet skjematype ${id}`
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('skjematyper DELETE FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
