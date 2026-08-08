/**
 * SharePoint-liste-oppdatering ved innsending.
 *
 * Skjematype konfigurerer:
 *   SPListeadresse    — full SP-site-URL
 *   SPListenavn       — liste-visningsnavn
 *   SPMetadata: []    — array av { Plassholder, SPKolonne } for metadata-mapping
 *   SPLagreVedlegg    — bool: legg opplastede filer som attachments
 * Per felt: SPListefelt — SP-kolonnenavn (kun felter med denne får sendt svar)
 *
 * Kaller SP_LISTE_FLOW_URL (Power Automate) med ferdig-bygget payload.
 * PA-flyten oppretter/oppdaterer listeraden i SharePoint.
 *
 * Payload:
 *   {
 *     listeadresse, listenavn,
 *     data: [{ felt, format, verdi }],
 *     vedlegg: [{ name, data: base64 }]   // valgfritt
 *   }
 *
 * Non-blocking: kall er wrapped in try/catch av kaller. Feil logges men
 * avbryter ikke innsending.
 */

const vedleggStorage = require('./vedlegg-storage');

const FORMAT_MAP = {
    'Tekst': 'tekst',
    'Tall': 'tall',
    'Valuta': 'tall',
    'Dato': 'dato',
    'Tidspunkt': 'tekst',
    'E-post': 'tekst',
    'Fodselsnummer': 'tekst',
    'Kontonummer': 'tekst',
    'Postnummer': 'tekst',
    'Skala': 'tall',
    'Flervalg-dropdown': 'tekst',
    'Flervalg-knapper': 'tekst'
};

/**
 * Resolve metadata-plassholder mot skjema + skjematype. Kun submit-tid-verdier
 * gir mening her (samme regel som legacy) — steg-spesifikke verdier
 * ($beslutning, $stegnavn, ...) blir null og filtreres bort av kaller.
 */
function resolvSPMetadataPlassholder(plassholder, skjema, skjematype) {
    switch (plassholder) {
        case '$skjema_id':       return String(skjema?.Skjema_id || '');
        case '$skjemanavn':      return String(skjematype?.Skjema_navn || skjema?.Skjema_navn || '');
        case '$innsender':       return String(skjema?.Innsender_Epost || skjema?.Innsender_epost || '');
        case '$innsender_navn':  return String(skjema?.Innsender_Navn || '');
        case '$tidspunkt':
        case '$tidspunkt_innsendt':
            return new Date().toISOString();
        default:
            return null;
    }
}

/**
 * Bygg data-array for SP-payload fra skjema + skjematype.
 * Legger alltid inn Innsender_Navn og Innsender_Epost som separate rader
 * hvis satt (samme oppførsel som legacy — hardkodede kolonnenavn).
 */
function byggSPListeData(skjema, skjematype) {
    const data = [];

    // Auto-injiser innsender-info
    const innsenderNavn = skjema?.Innsender_Navn;
    const innsenderEpost = skjema?.Innsender_Epost || skjema?.Innsender_epost;
    if (innsenderNavn) data.push({ felt: 'Innsender_Navn', format: 'tekst', verdi: String(innsenderNavn) });
    if (innsenderEpost) data.push({ felt: 'Innsender_Epost', format: 'tekst', verdi: String(innsenderEpost) });

    // Iterer felter i skjematypen (ikke skjemaet — vi trenger SPListefelt-config)
    const seksjonerDef = skjematype?.Seksjoner || [];
    const seksjonerSvar = skjema?.Seksjoner || [];

    for (const sekDef of seksjonerDef) {
        const sekNr = sekDef.Seksjon_nummer;
        const sekSvar = seksjonerSvar.find(s =>
            String(s.Seksjon_nummer) === String(sekNr) || String(s.Nummer) === String(sekNr)
        );
        for (const feltDef of (sekDef.Felter || [])) {
            const spKolonne = String(feltDef.SPListefelt || '').trim();
            if (!spKolonne) continue;
            const feltNrPadded = String(feltDef.Nummer).padStart(2, '0');
            const feltSvar = (sekSvar?.Felter || []).find(f =>
                String(f.Nummer).padStart(2, '0') === feltNrPadded
            );
            const svarArr = feltSvar?.Svar || [];
            if (svarArr.length === 0 || (svarArr.length === 1 && svarArr[0] === '')) continue;

            const format = FORMAT_MAP[feltDef.Type] || 'tekst';
            const verdi = svarArr.length === 1 ? svarArr[0] : svarArr.join('; ');
            data.push({ felt: spKolonne, format, verdi: String(verdi) });
        }
    }

    // Metadata-mappinger — bare de som resolves til noe
    const spMeta = Array.isArray(skjematype?.SPMetadata) ? skjematype.SPMetadata : [];
    for (const m of spMeta) {
        const plassholder = String(m?.Plassholder || '').trim();
        const kolonne = String(m?.SPKolonne || '').trim();
        if (!plassholder || !kolonne) continue;
        const verdi = resolvSPMetadataPlassholder(plassholder, skjema, skjematype);
        if (verdi == null || verdi === '') continue;
        data.push({ felt: kolonne, format: 'tekst', verdi: String(verdi) });
    }

    return data;
}

async function bygVedleggPayload(skjema, log) {
    const filer = await vedleggStorage.listVedlegg(skjema.Skjematype_id, skjema.Skjema_id);
    const out = [];
    for (const f of filer) {
        try {
            const stream = await vedleggStorage.hentVedleggStream(
                skjema.Skjematype_id, skjema.Skjema_id, f.filnavn
            );
            if (stream?.buffer) {
                out.push({ name: f.filnavn, data: stream.buffer.toString('base64') });
            }
        } catch (e) {
            log(`sp-liste: kunne ikke lese vedlegg "${f.filnavn}": ${e.message}`);
        }
    }
    return out;
}

/**
 * Kall SP_LISTE_FLOW_URL med bygget payload. Trigges ved innsending.
 * Non-blocking — feiler stille (log) uten å avbryte innsending.
 */
async function oppdaterSPListe(skjema, skjematype, log = () => {}) {
    const url = process.env.SP_LISTE_FLOW_URL;
    if (!url) {
        log('sp-liste: SP_LISTE_FLOW_URL ikke satt — hopper over');
        return { status: 'hoppet-over' };
    }
    const listeadresse = String(skjematype?.SPListeadresse || '').trim();
    const listenavn = String(skjematype?.SPListenavn || '').trim();
    if (!listeadresse || !listenavn) {
        return { status: 'hoppet-over', melding: 'SPListeadresse/SPListenavn ikke satt på skjematype' };
    }

    if (String(process.env.VARSLING_DEAKTIVERT || '').toLowerCase() === 'true') {
        log(`sp-liste DRY-RUN: listeadresse=${listeadresse} listenavn=${listenavn}`);
        return { status: 'deaktivert' };
    }

    try {
        const data = byggSPListeData(skjema, skjematype);
        const payload = { listeadresse, listenavn, data };

        if (skjematype?.SPLagreVedlegg) {
            try {
                const vedlegg = await bygVedleggPayload(skjema, log);
                if (vedlegg.length > 0) payload.vedlegg = vedlegg;
            } catch (e) {
                log(`sp-liste: vedlegg-bygging feilet (ignorerer): ${e.message}`);
            }
        }

        const respons = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!respons.ok) {
            const tekst = await respons.text().catch(() => '');
            log(`sp-liste FEIL: HTTP ${respons.status} — ${tekst.slice(0, 300)}`);
            return { status: 'feil', melding: `HTTP ${respons.status}` };
        }
        const respData = await respons.json().catch(() => ({}));
        log(`sp-liste OK: ${listenavn} (${data.length} felter, ${payload.vedlegg?.length || 0} vedlegg)`);
        return { status: 'ok', respons: respData };
    } catch (e) {
        log(`sp-liste EXCEPTION: ${e.message}`);
        return { status: 'feil', melding: e.message };
    }
}

module.exports = { oppdaterSPListe, byggSPListeData, resolvSPMetadataPlassholder };
