/**
 * Kjør rapport.
 *
 *   POST /api/rapport/kjor
 *   Body: { Rapporttype_id, brukerVerdier?: { <filterId>: <verdi> } }
 *
 * Krever admin/Skjemaskaper (rapport-funksjonaliteten er i Utvikling-fase) i
 * tillegg til publikum- eller eier-tilgang på rapporttypen. Motoren opererer på
 * dekrypterte, fullt formaterte skjemaer.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const rapportStorage = require('../lib/rapport-storage');
const skjemaStorage = require('../lib/skjema-storage');
const forekomstStorage = require('../lib/skjema-forekomst-storage');
const { filtrerTyperPåTilgang, erSkjemaskaper } = require('../lib/tilgang');
const kryptering = require('../lib/kryptering');
const nokkelStorage = require('../lib/nokkel-storage');
const rapportMotor = require('../lib/rapport-motor');
const hendelser = require('../lib/hendelser-storage');

async function harTilgang(rapporttype, upn) {
    if (erAdmin(upn)) return { ok: true, erEier: true };
    const [eier, publikum] = await Promise.all([
        filtrerTyperPåTilgang([rapporttype], upn, 'Eiere'),
        filtrerTyperPåTilgang([rapporttype], upn, 'Publikum')
    ]);
    if (eier.length > 0) return { ok: true, erEier: true };
    if (publikum.length > 0) return { ok: true, erEier: false };
    return { ok: false };
}

app.http('kjorRapport', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'rapport/kjor',
    handler: async (request, context) => {
        const upn = hentInnloggetUpn(request);
        if (!upn) return { status: 401, jsonBody: { status: 'feil', melding: 'Ikke innlogget' } };
        if (!await erSkjemaskaper(upn)) {
            return { status: 403, jsonBody: { status: 'avvist', melding: 'Rapporter er foreløpig forbeholdt admin og rollen "Skjemaskaper"' } };
        }

        try {
            const body = await request.json();
            const rapporttypeId = String(body.Rapporttype_id || '');
            if (!rapporttypeId) return { status: 400, jsonBody: { status: 'feil', melding: 'Rapporttype_id mangler' } };

            const rt = await rapportStorage.hentRapporttype(rapporttypeId);
            if (!rt) return { status: 404, jsonBody: { status: 'feil', melding: 'Rapporttype ikke funnet' } };

            const tilgang = await harTilgang(rt, upn);
            if (!tilgang.ok) return { status: 403, jsonBody: { status: 'avvist', melding: 'Ingen tilgang' } };

            const spec = rt.JSON;
            const kildeId = String(spec.Kildeskjematype_id || '');
            if (!kildeId) return { status: 400, jsonBody: { status: 'feil', melding: 'Rapporttypen mangler Kildeskjematype_id' } };

            const kildeSt = await skjemaStorage.hentSkjematype(kildeId);
            if (!kildeSt) return { status: 400, jsonBody: { status: 'feil', melding: `Kildeskjematype ${kildeId} finnes ikke lenger` } };

            // Hent alle skjemaer i fullt format (ekspanderer kompakt lagring)
            const skjemaer = await forekomstStorage.hentAlleSkjemaerForType(kildeId);

            // Dekrypter krypterte skjemaer hvis nøkkel finnes. Kryptering er
            // på skjematype-nivå, så én nøkkel dekker alle skjemaer i settet.
            const trengerDekrypt = skjemaer.some(s => s?.Kryptert);
            let nokkel = null;
            if (trengerDekrypt) {
                nokkel = await nokkelStorage.hentNokkel(kildeId);
            }
            const dekryptert = skjemaer.map(s => {
                if (!s?.Kryptert || !nokkel) return s;
                try { return kryptering.dekrypterSkjema(s, nokkel); }
                catch (_) { return s; }
            });

            const resultat = rapportMotor.kjør(spec, dekryptert, body.brukerVerdier || {});

            // Berik med rapport-metadata så frontend kan vise header/tittel
            resultat.rapport = {
                Rapporttype_id: rapporttypeId,
                Rapport_navn: spec.Rapport_navn || rt.navn,
                Beskrivelse: spec.Beskrivelse || '',
                Kildeskjematype_id: kildeId,
                Kildeskjematype_navn: kildeSt.navn || ''
            };

            hendelser.logg({
                Type: 'rapport.kjor',
                Aktor: upn,
                ObjektType: 'rapporttype', ObjektId: rapporttypeId,
                Melding: `Kjørte rapport "${spec.Rapport_navn || ''}"`,
                Detaljer: { antall: resultat.meta.antallEtterFilter, kilde: kildeId }
            });

            return { jsonBody: resultat };
        } catch (e) {
            context.log('rapport/kjor FEIL:', e.message, e.stack);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
