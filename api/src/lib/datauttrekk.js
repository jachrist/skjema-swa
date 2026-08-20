/**
 * Datauttrekk — bygg Excel/CSV/JSON av innsendte skjemaer.
 *
 * Tar en skjematype-definisjon + en liste med skjema-forekomster og produserer
 * en flat rad-struktur der hver rad = ett skjema, hver kolonne = ett spørsmål
 * (spm-tekst som header).
 *
 * Filtrering skjer in-memory: for hver filter må minst én av Verdier[]
 * matche svaret på Seksjon-Felt.
 *
 * Kryptering ikke implementert i pilot (fase 7). `Nokkel`-argumentet er
 * akseptert for framtidig kompatibilitet men brukes ikke.
 */

const XLSX = require('xlsx');

const META_KOLONNER = ['SkjemaNr', 'Innsender_Navn', 'Innsender_Epost', 'OpprettetDato', 'FerdigbehandletDato'];

/**
 * Bygg svarMap fra ett skjema (både fullt og kompakt format støttet).
 * Returnerer { spm-tekst: svar-string, ... } — inkluderer meta-kolonner.
 */
function trekkUtSvar(skjema, definisjon) {
    const rad = {
        SkjemaNr: skjema?.Skjema_id || '',
        Innsender_Navn: skjema?.Innsender_Navn || skjema?.Innsender || '',
        Innsender_Epost: skjema?.Innsender_Epost || skjema?.Innsender_epost || '',
        OpprettetDato: skjema?.Opprettet_dato || skjema?.Opprettet || skjema?.Innsendt_dato || '',
        FerdigbehandletDato: alleBehandletDato(skjema) || ''
    };

    const spmTekster = {}; // "sek-felt" (padded) → tekst
    for (const s of (definisjon?.Seksjoner || [])) {
        const sekNr = String(s.Seksjon_nummer);
        for (const f of (s.Felter || [])) {
            if (f.Type === 'Informasjon') continue;
            const nokkel = `${sekNr}-${String(f.Nummer).padStart(2, '0')}`;
            const tekst = String(f.Tekst?.Verdi || nokkel);
            spmTekster[nokkel] = tekst;
            rad[tekst] = ''; // initialiser så alle kolonner er med selv om skjema mangler svar
        }
    }

    // Fullt format: skjema.Seksjoner[].Felter[].Svar
    if (Array.isArray(skjema?.Seksjoner) && skjema.Seksjoner.length > 0) {
        for (const s of skjema.Seksjoner) {
            const sekNr = String(s.Seksjon_nummer || s.Nummer || '');
            for (const f of (s.Felter || [])) {
                const feltNrPadded = String(f.Nummer).padStart(2, '0');
                const nokkel = `${sekNr}-${feltNrPadded}`;
                const tekst = spmTekster[nokkel];
                if (!tekst) continue;
                rad[tekst] = svarTilStreng(f.Svar, f.SvarTekst);
            }
        }
    }
    // Kompakt format: skjema.Svar[] = [{sek, spm, sva}]
    else if (Array.isArray(skjema?.Svar)) {
        for (const s of skjema.Svar) {
            const sekNr = String(s.sek);
            const feltNrPadded = String(s.spm).padStart(2, '0');
            const nokkel = `${sekNr}-${feltNrPadded}`;
            const tekst = spmTekster[nokkel];
            if (!tekst) continue;
            rad[tekst] = svarTilStreng(s.sva, s.svt);
        }
    }

    return rad;
}

/**
 * @param sva  svarverdiene
 * @param svt  lagret visningstekst, om feltet har valgliste — klassenavn i
 *             stedet for FS-nøkkel, personnavn i stedet for UPN. Uttrekket skal
 *             leses av mennesker, så teksten vinner når den finnes.
 */
function svarTilStreng(sva, svt) {
    if (sva == null) return '';
    // Kryptert svar (ikke-array streng med iv:tag:ciphertext-format) — vis som markør
    if (typeof sva === 'string' && sva.split(':').length === 3) return '[Kryptert]';
    if (Array.isArray(sva)) {
        const tekst = Array.isArray(svt) ? svt : null;
        return sva
            .map((v, i) => (tekst && tekst[i]) ? String(tekst[i]) : v)
            .filter(v => v != null && v !== '')
            .join('; ');
    }
    return String(sva);
}

function alleBehandletDato(skjema) {
    const b = skjema?.Behandling;
    if (!Array.isArray(b) || b.length === 0) return '';
    // Alle steg må være ferdig (Beslutning !== 0) — returner nyeste BehandletDato
    let sisteDato = '';
    for (const s of b) {
        if (!Number(s?.Beslutning || 0)) return ''; // ikke ferdig
        const d = s?.BehandletDato || '';
        if (d > sisteDato) sisteDato = d;
    }
    return sisteDato;
}

/**
 * Sjekk om et skjema matcher alle filtre.
 * Filter: { Seksjon, Felt, Verdier[] } — AND mellom filtre, OR innen Verdier.
 */
function matcherFiltre(skjema, filtre) {
    if (!Array.isArray(filtre) || filtre.length === 0) return true;
    const svarMap = byggSvarMap(skjema);
    return filtre.every(f => {
        const nokkel = `${String(f.Seksjon)}-${String(f.Felt).padStart(2, '0')}`;
        const svar = svarMap[nokkel] || [];
        if (!Array.isArray(f.Verdier) || f.Verdier.length === 0) return true;
        return f.Verdier.some(v => svar.includes(String(v)));
    });
}

function byggSvarMap(skjema) {
    const map = {};
    if (Array.isArray(skjema?.Seksjoner)) {
        for (const s of skjema.Seksjoner) {
            const sekNr = String(s.Seksjon_nummer || s.Nummer || '');
            for (const f of (s.Felter || [])) {
                const feltNrPadded = String(f.Nummer).padStart(2, '0');
                const arr = Array.isArray(f.Svar) ? f.Svar.map(String) : [];
                map[`${sekNr}-${feltNrPadded}`] = arr;
            }
        }
    } else if (Array.isArray(skjema?.Svar)) {
        for (const s of skjema.Svar) {
            const nokkel = `${String(s.sek)}-${String(s.spm).padStart(2, '0')}`;
            map[nokkel] = Array.isArray(s.sva) ? s.sva.map(String) : [String(s.sva || '')];
        }
    }
    return map;
}

// ==================== Generatorer ====================

function genererExcel(rader, skjemaNavn) {
    const wb = XLSX.utils.book_new();
    const ws = rader.length > 0
        ? XLSX.utils.json_to_sheet(rader)
        : XLSX.utils.aoa_to_sheet([['(ingen skjemaer matchet filteret)']]);

    // Auto-kolonnebredde
    if (rader.length > 0) {
        const kolonner = Object.keys(rader[0]);
        ws['!cols'] = kolonner.map(k => {
            const lengste = rader.reduce((m, r) => Math.max(m, String(r[k] || '').length), k.length);
            return { wch: Math.min(lengste + 2, 60) };
        });
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return {
        filnavn: byggFilnavn(skjemaNavn, 'xlsx'),
        innhold: buffer.toString('base64'),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };
}

function genererCsvLangform(rader, skjemaNavn) {
    // Legacy-stil: én rad per svar (SkjemaNr;Spørsmål;Svar), semikolon, med BOM
    const linjer = ['SkjemaNr;Spørsmål;Svar'];
    for (const r of rader) {
        const skjemaNr = r.SkjemaNr;
        for (const kolonne of Object.keys(r)) {
            if (META_KOLONNER.includes(kolonne)) continue;
            const svar = String(r[kolonne] || '').replace(/[\r\n;"]/g, ' ').trim();
            linjer.push(`${skjemaNr};${csvEscape(kolonne)};${csvEscape(svar)}`);
        }
    }
    const bom = '﻿';
    const buffer = Buffer.from(bom + linjer.join('\r\n'), 'utf8');
    return {
        filnavn: byggFilnavn(skjemaNavn, 'csv'),
        innhold: buffer.toString('base64'),
        contentType: 'text/csv; charset=utf-8'
    };
}

function csvEscape(s) {
    return String(s || '').replace(/"/g, '""').replace(/[\r\n]/g, ' ');
}

function genererJson(rader, skjemaNavn) {
    const buffer = Buffer.from(JSON.stringify(rader, null, 2), 'utf8');
    return {
        filnavn: byggFilnavn(skjemaNavn, 'json'),
        innhold: buffer.toString('base64'),
        contentType: 'application/json; charset=utf-8'
    };
}

function byggFilnavn(skjemaNavn, ext) {
    const trygg = String(skjemaNavn || 'datauttrekk').replace(/[\/\\?*:|"<>]/g, '_');
    const nu = new Date();
    // Lokal tid (Europe/Oslo) — enklest: bruk toLocaleString og pars
    const s = nu.toISOString().replace('T', ' ').substring(0, 16).replace(':', '');
    return `${trygg}-${s}.${ext}`;
}

/**
 * Hoved-inngang. `skjemaer` er allerede filtrert til aktuell skjematype.
 */
function bygg(skjemaer, definisjon, filtre, type) {
    const skjemaNavn = definisjon?.Skjema_navn || 'datauttrekk';
    const filtrert = (skjemaer || []).filter(s => matcherFiltre(s, filtre));
    const rader = filtrert.map(s => trekkUtSvar(s, definisjon));

    switch (type) {
        case 'excel':
        case 'xlsx':
            return genererExcel(rader, skjemaNavn);
        case 'csv':
            return genererCsvLangform(rader, skjemaNavn);
        case 'json':
        case 'json_feltnavn':
            return genererJson(rader, skjemaNavn);
        default:
            throw new Error(`Ukjent uttrekk-type: ${type}`);
    }
}

module.exports = {
    bygg,
    trekkUtSvar,
    matcherFiltre,
    // eksponert for test:
    genererExcel,
    genererCsvLangform,
    genererJson
};
