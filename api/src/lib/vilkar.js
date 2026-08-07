/**
 * vilkar.js — Felles evaluering av vilkår i DNF-form (Node-versjon).
 *
 * Brukes til:
 *   - Vises på seksjoner og felter (dynamisk skjul/vis)
 *   - ObligatoriskHvis (betinget markering + validering)
 *   - Vilkår på behandlingssteg (kommer i fase 4)
 *
 * DNF (Disjunctive Normal Form):
 *   {
 *     "EllerAv": [
 *       { "OgAv": [{Felt, Operator, Verdi}, ...] },   ← gruppe A
 *       { "OgAv": [{Felt, Operator, Verdi}, ...] },   ← gruppe B
 *       ...
 *     ]
 *   }
 *   Tolkning: (A1 AND A2 ...) OR (B1 AND B2 ...) OR ...
 *
 * Legacy format { Seksjon, Felt, Verdi } konverteres automatisk til DNF.
 *
 * Feltreferanse:
 *   "<uuid>"        — svar via Id (foretrukket nytt format)
 *   "S-FF"          — svar via posisjon (legacy)
 *   "behandling-N"  — Beslutning på behandlingssteg N (fase 4)
 *
 * Operatorer:
 *   "=" "!="                    likhet/ulikhet (string-sammenlikning)
 *   "<" "<=" ">" ">="           numerisk sammenlikning
 *   "tom" "ikke_tom"            null/tom-sjekk
 *   "inneholder"                substring (case-insensitiv)
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function erDNFFormat(vilkar) {
    return !!(vilkar && Array.isArray(vilkar.EllerAv));
}

function erLegacyFormat(vilkar) {
    return !!(vilkar && typeof vilkar === 'object'
        && !Array.isArray(vilkar.EllerAv)
        && ('Seksjon' in vilkar || 'Felt' in vilkar));
}

function migrerTilDNF(vilkar) {
    if (!vilkar) return null;
    if (erDNFFormat(vilkar)) return vilkar;
    if (erLegacyFormat(vilkar)) {
        const felt = `${vilkar.Seksjon || ''}-${String(vilkar.Felt || '').padStart(2, '0')}`;
        return { EllerAv: [{ OgAv: [{ Felt: felt, Operator: '=', Verdi: vilkar.Verdi }] }] };
    }
    return null;
}

function svarFraFelt(felt) {
    if (Array.isArray(felt.Svar)) {
        if (felt.Svar.length === 0) return null;
        if (felt.Svar.length === 1) return felt.Svar[0];
        return felt.Svar;
    }
    return felt.Svar ?? null;
}

function hentSvar(seksjoner, feltRef, behandling) {
    if (!feltRef) return null;
    const ref = String(feltRef).trim();

    // Behandlingssteg
    const behMatch = /^behandling-(\d+)$/.exec(ref);
    if (behMatch) {
        if (!Array.isArray(behandling)) return null;
        const stegNr = parseInt(behMatch[1], 10);
        const steg = behandling.find(s => Number(s.Steg) === stegNr);
        if (!steg) return null;
        const beslutning = steg.Beslutning;
        if (beslutning === null || beslutning === undefined || beslutning === 0) return null;
        const valg = Array.isArray(steg.Beslutningsvalg)
            ? steg.Beslutningsvalg.find(v => Number(v.Nummer) === Number(beslutning))
            : null;
        if (Number(beslutning) === 5) return [5, 'Hoppet over'];
        if (valg && valg.Tekst) return [Number(beslutning), String(valg.Tekst)];
        return [Number(beslutning)];
    }

    if (!Array.isArray(seksjoner)) return null;

    // UUID-referanse
    if (UUID_RE.test(ref)) {
        for (const sek of seksjoner) {
            for (const felt of (sek.Felter || [])) {
                if (felt.Id && felt.Id === ref) return svarFraFelt(felt);
            }
        }
        return null;
    }

    // S-FF (posisjonell)
    const m = /^(\d+)-(.+)$/.exec(ref);
    if (!m) return null;
    const sekNum = String(m[1]);
    const feltNum = String(m[2]).padStart(2, '0');

    for (const sek of seksjoner) {
        if (String(sek.Seksjon_nummer ?? sek.Nummer ?? '') !== sekNum) continue;
        for (const felt of (sek.Felter || [])) {
            if (String(felt.Nummer ?? '').padStart(2, '0') === feltNum) return svarFraFelt(felt);
        }
    }
    return null;
}

function parsTall(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).trim().replace(',', '.');
    if (s === '') return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
}

function evaluerBetingelse(betingelse, seksjoner, behandling) {
    if (!betingelse) return false;
    const svar = hentSvar(seksjoner, betingelse.Felt, behandling);
    const op = String(betingelse.Operator || '=').toLowerCase();
    const ventet = betingelse.Verdi;

    const erTomSvar = svar === null || svar === undefined || svar === ''
        || (Array.isArray(svar) && svar.length === 0);

    if (op === 'tom') return erTomSvar;
    if (op === 'ikke_tom') return !erTomSvar;

    if (op === '=' || op === '!=') {
        const treff = Array.isArray(svar)
            ? svar.some(s => String(s) === String(ventet))
            : String(svar ?? '') === String(ventet ?? '');
        return op === '=' ? treff : !treff;
    }

    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        const v = Array.isArray(svar) ? svar[0] : svar;
        const a = parsTall(v);
        const b = parsTall(ventet);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        switch (op) {
            case '<':  return a < b;
            case '<=': return a <= b;
            case '>':  return a > b;
            case '>=': return a >= b;
        }
    }

    if (op === 'inneholder') {
        const sub = String(ventet ?? '').toLowerCase();
        if (sub === '') return false;
        if (Array.isArray(svar)) return svar.some(s => String(s ?? '').toLowerCase().includes(sub));
        return String(svar ?? '').toLowerCase().includes(sub);
    }
    return false;
}

/**
 * Evaluer hele DNF-strukturen. Returnerer true hvis vilkår mangler, er tomt
 * eller minst én OgAv-gruppe er sann.
 */
function evaluerVilkar(vilkar, seksjoner, behandling) {
    if (!vilkar) return true;
    const dnf = migrerTilDNF(vilkar);
    if (!dnf || !Array.isArray(dnf.EllerAv) || dnf.EllerAv.length === 0) return true;

    for (const gruppe of dnf.EllerAv) {
        const og = Array.isArray(gruppe?.OgAv) ? gruppe.OgAv : [];
        if (og.length === 0) continue;
        let alleSanne = true;
        for (const b of og) {
            if (!evaluerBetingelse(b, seksjoner, behandling)) { alleSanne = false; break; }
        }
        if (alleSanne) return true;
    }
    return false;
}

function samleRefererteFelter(vilkar) {
    const dnf = migrerTilDNF(vilkar);
    if (!dnf || !Array.isArray(dnf.EllerAv)) return [];
    const sett = new Set();
    for (const gruppe of dnf.EllerAv) {
        for (const b of (gruppe?.OgAv || [])) {
            if (b && b.Felt) sett.add(String(b.Felt));
        }
    }
    return [...sett];
}

module.exports = {
    erDNFFormat, erLegacyFormat, migrerTilDNF,
    evaluerVilkar, evaluerBetingelse, hentSvar,
    samleRefererteFelter
};
