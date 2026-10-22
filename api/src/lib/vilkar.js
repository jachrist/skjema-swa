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
 *   "<" "<=" ">" ">="           numerisk ELLER dato-sammenlikning
 *   "tom" "ikke_tom"            null/tom-sjekk
 *   "inneholder"                substring (case-insensitiv)
 *
 * Verdi — høyresiden:
 *   en literal                  { Felt: "1-02", Operator: ">", Verdi: 10 }
 *   et ANNET FELT               Verdi: { Felt: "<ref>" }
 *   et felt forskjøvet i dager  Verdi: { Felt: "<ref>", PlussDager: 14 }
 *   dagens dato                 Verdi: { Felt: "@idag" }
 *
 *   «Sluttdato minst 14 dager etter startdato» blir da
 *   { Felt: "<slutt>", Operator: ">=", Verdi: { Felt: "<start>", PlussDager: 14 } }
 *
 *   `@idag` gjelder BARE på høyresiden. Venstresiden er alltid et felt i
 *   skjemaet — «dato etter i dag» skrives `felt > @idag`, ikke omvendt, og
 *   da trengs ingen tolkning av venstresiden.
 *
 *   `PlussDager` gir bare mening på en dato. Er den satt og verdien ikke er
 *   en ISO-dato, blir høyresiden `null` og betingelsen usann — ikke et
 *   kast midt i tegningen av et skjema.
 *
 * Datoer sammenlignes som DATOER, ikke som tall. `parsTall('2026-03-01')`
 * er NaN, så fram til 22.10.2026 ga `>` mellom to datoer alltid usant.
 * ISO-formatet sorterer leksikografisk, så sammenligningen gjøres på
 * teksten — ingen tidssoner involvert.
 *
 * `ctx.idag` kan settes for å binde «i dag» i en test. Uten den leses
 * klokka, i LOKAL tid: «i dag» for den som fyller ut skjemaet.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDAG_REF = '@idag';
const ISO_DATO_RE = /^\d{4}-\d{2}-\d{2}$/;

function erIsoDato(v) {
    return typeof v === 'string' && ISO_DATO_RE.test(v.trim());
}

function idagISO(ctx) {
    if (ctx && ctx.idag) return String(ctx.idag);
    const n = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

function datoPlussDager(iso, dager) {
    const [aar, mnd, dag] = String(iso).trim().split('-').map(Number);
    const ut = new Date(Date.UTC(aar, mnd - 1, dag) + dager * 86400000);
    const p = (x) => String(x).padStart(2, '0');
    return `${ut.getUTCFullYear()}-${p(ut.getUTCMonth() + 1)}-${p(ut.getUTCDate())}`;
}

function hoyreVerdi(verdi, seksjoner, behandling, ctx) {
    if (!verdi || typeof verdi !== 'object' || Array.isArray(verdi)) return verdi;
    if (!('Felt' in verdi)) return null;

    const ref = String(verdi.Felt ?? '').trim();
    let v = ref === IDAG_REF ? idagISO(ctx) : hentSvar(seksjoner, ref, behandling);
    // Et flervalg gir en array; vi sammenligner mot det første svaret.
    // `svarFraFelt` gir `null` for et TOMT svar, aldri `[]` — det er målt i
    // `api/test/vilkar-tvilling.test.js`, og derfor står det ingen vakt mot
    // en tom array her. En vakt ingen test kan skille fra ingenting, er
    // ingenting.
    if (Array.isArray(v)) v = v[0];
    if (v === undefined) v = null;

    const dager = Number(verdi.PlussDager || 0);
    if (!dager) return v;
    if (!erIsoDato(v)) return null;
    return datoPlussDager(v, dager);
}

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

function evaluerBetingelse(betingelse, seksjoner, behandling, ctx) {
    if (!betingelse) return false;
    const svar = hentSvar(seksjoner, betingelse.Felt, behandling);
    const op = String(betingelse.Operator || '=').toLowerCase();
    const ventet = hoyreVerdi(betingelse.Verdi, seksjoner, behandling, ctx);

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

        // To ISO-datoer sammenlignes som datoer. Formen sorterer
        // leksikografisk, så teksten holder — og da slipper vi tidssoner.
        if (erIsoDato(v) && erIsoDato(ventet)) {
            const x = String(v).trim(), y = String(ventet).trim();
            switch (op) {
                case '<':  return x < y;
                case '<=': return x <= y;
                case '>':  return x > y;
                case '>=': return x >= y;
            }
        }

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
function evaluerVilkar(vilkar, seksjoner, behandling, ctx) {
    if (!vilkar) return true;
    const dnf = migrerTilDNF(vilkar);
    if (!dnf || !Array.isArray(dnf.EllerAv) || dnf.EllerAv.length === 0) return true;

    for (const gruppe of dnf.EllerAv) {
        const og = Array.isArray(gruppe?.OgAv) ? gruppe.OgAv : [];
        if (og.length === 0) continue;
        let alleSanne = true;
        for (const b of og) {
            if (!evaluerBetingelse(b, seksjoner, behandling, ctx)) { alleSanne = false; break; }
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
            if (!b) continue;
            if (b.Felt) sett.add(String(b.Felt));
            // Høyresiden kan også peke på et felt. `@idag` er ikke et felt.
            const v = b.Verdi;
            if (v && typeof v === 'object' && !Array.isArray(v) && v.Felt
                && String(v.Felt) !== IDAG_REF) {
                sett.add(String(v.Felt));
            }
        }
    }
    return [...sett];
}

/**
 * Er hvert felt vilkåret viser til, utfylt?
 *
 * En valideringsregel som «sluttdato minst 14 dager etter startdato» kan
 * ikke avgjøres før BEGGE datoene står der. Uten denne ville brukeren fått
 * «ugyldig» på et felt hen ikke har rørt, i samme øyeblikk skjemaet åpnes.
 *
 * `@idag` teller ikke — den er alltid tilgjengelig, og `samleRefererteFelter`
 * holder den utenfor.
 */
function alleFelterUtfylt(vilkar, seksjoner, behandling) {
    for (const ref of samleRefererteFelter(vilkar)) {
        const v = hentSvar(seksjoner, ref, behandling);
        const tomt = v === null || v === undefined || v === ''
            || (Array.isArray(v) && v.length === 0);
        if (tomt) return false;
    }
    return true;
}

/**
 * Første valideringsregel som IKKE holder, eller null.
 *
 * `Validering` er en liste av { Vilkar, Melding }, og vilkåret leses som
 * «GYLDIG HVIS» — samme retning som `Vises` og `ObligatoriskHvis`, så den
 * som setter opp skjemaet slipper å snu tankegangen mellom feltene.
 *
 * En regel hoppes over til alle feltene den viser til er utfylt.
 */
function forsteBrudd(validering, seksjoner, behandling, ctx) {
    if (!Array.isArray(validering)) return null;
    for (const regel of validering) {
        if (!regel || !regel.Vilkar) continue;
        if (!alleFelterUtfylt(regel.Vilkar, seksjoner, behandling)) continue;
        if (!evaluerVilkar(regel.Vilkar, seksjoner, behandling, ctx)) return regel;
    }
    return null;
}

module.exports = {
    erDNFFormat, erLegacyFormat, migrerTilDNF,
    evaluerVilkar, evaluerBetingelse, hentSvar,
    samleRefererteFelter,
    alleFelterUtfylt,
    forsteBrudd
};
