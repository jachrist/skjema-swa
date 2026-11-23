/**
 * Månedlig varsel til eierne av skjematyper som skriver til Microsoft 365,
 * men ikke er brukt på lenge.
 *
 * Lagt til 23.11.2026. Servicebrukeren er medlem av hvert team en skjematype
 * skriver til (SharePoint-liste, Planner, Teams-kanal), invitert av
 * teameieren. Medlemskapet blir liggende når skjematypen slutter å brukes.
 * Jobben spør eierne av skjematypen — de som kjenner den — om den kan
 * arkiveres, og om teameieren kan melde ut servicebrukeren. Oversikten bak
 * den er Administrasjon → Skjematyper → M365-koblinger (lib/m365-koblinger.js).
 *
 * ## Hva «ubrukt» betyr
 *
 * Både siste innsending OG siste endring av skjematypen er eldre enn
 * `GRENSE_DAGER`. Den siste er tabellradens tidsstempel: en skjematype som
 * nettopp er laget, eller som noen jobber med, skal ikke få varsel. Uten den
 * ville en ny skjematype uten innsendinger fått varsel første natt.
 *
 * ## Avslått per skjematype
 *
 * Testskjemaer som ligger igjen i et miljø, skal ikke gi varsel hver måned.
 * Admin kan slå varselet av per skjematype i oversikten. Lista lagres i
 * SystemInnstillinger under én nøkkel (`INNSTILLING`), og skjematype-
 * definisjonene røres ikke — en avkrysning i admin skal ikke endre «sist
 * endret» på en skjematype.
 *
 * ## Hvor ofte
 *
 * Én gang i måneden, og hver måned så lenge skjematypen er ubrukt og
 * varselet står på. Det er meningen: spørsmålet står til noen har tatt
 * stilling — arkivert skjematypen, brukt den, eller slått varselet av.
 */
const { malFor } = require('./m365-koblinger');
const { byggOversikt } = require('./skjematype-oversikt');
const { escapeHtml } = require('./markdown');

const GRENSE_DAGER = 180;
const INNSTILLING = 'UbruktVarsel.Av';
const PK = 'Meta';
const RK = 'Jobb-UbruktVarsel';
const DAG_MS = 24 * 3600 * 1000;

/** Lista over skjematyper med varselet slått av. Tom ved feil eller ukjent form. */
async function lesAvslatte(innstillinger = require('./innstillinger-storage')) {
    try {
        const rad = await innstillinger.hent(INNSTILLING);
        const liste = JSON.parse(rad?.Verdi || '[]');
        return new Set(Array.isArray(liste) ? liste.map(String) : []);
    } catch (_) {
        return new Set();
    }
}

/**
 * Slå varselet på eller av for skjematypene i `ider`. Returnerer lista over
 * avslåtte etterpå, sortert.
 */
async function settVarsling(ider, varsle, aktor, innstillinger = require('./innstillinger-storage')) {
    const av = await lesAvslatte(innstillinger);
    for (const id of (ider || []).map(String).filter(Boolean)) {
        if (varsle) av.delete(id); else av.add(id);
    }
    const liste = [...av].sort((a, b) => a.localeCompare(b, 'no', { numeric: true }));
    await innstillinger.sett(INNSTILLING, JSON.stringify(liste), aktor);
    return liste;
}

/** Den nyeste av to ISO-tider, eller '' når ingen er satt. */
function nyest(a, b) {
    return String(a || '') > String(b || '') ? String(a || '') : String(b || '');
}

/**
 * Hvem som skal få varsel. Ren funksjon.
 *
 * @param skjematyper `hentAlleSkjematyper()`: `{ id, JSON, endret }[]`
 * @param oversikt    radene fra `byggOversikt` — siste bruk
 * @param avslatte    `Set` med skjematype-id-er
 */
function kandidater(skjematyper, oversikt, avslatte = new Set(), naa = Date.now()) {
    const bruk = new Map((oversikt || []).map(r => [String(r.Skjematype_id), r]));
    const grense = new Date(naa - GRENSE_DAGER * DAG_MS).toISOString();
    const ut = [];
    for (const st of (skjematyper || [])) {
        const def = st?.JSON || {};
        const id = String(st?.id ?? def.Skjematype_id ?? '');
        if (!id || avslatte.has(id)) continue;
        const koblinger = malFor(def);
        if (koblinger.length === 0) continue;
        const sisteBruk = bruk.get(id)?.SisteDato || '';
        const sist = nyest(sisteBruk, st?.endret);
        if (sist && sist >= grense) continue;
        ut.push({ id, navn: def.Skjema_navn || st?.navn || '', fase: def.Fase || 'Produksjon', eiere: def.Eiere || {}, sisteBruk, sistEndret: st?.endret || '', koblinger });
    }
    return ut;
}

function dato(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** E-posten til eierne. Alt fra definisjonen escapes. */
function epost(k, basis = '') {
    const typer = { sharepoint: 'SharePoint-liste', planner: 'Planner', teamskanal: 'Teams-kanal' };
    const linjer = k.koblinger.map(m =>
        `<li>${escapeHtml(typer[m.type] || m.type)}: <b>${escapeHtml(m.mal)}</b> (${escapeHtml(m.detalj)}, ${escapeHtml(m.hvor)})</li>`).join('');
    const sist = k.sisteBruk ? `sist brukt ${escapeHtml(dato(k.sisteBruk))}` : 'aldri brukt';
    const lenke = basis ? `<p><a href="${escapeHtml(basis)}/editor.html?skjematype_id=${encodeURIComponent(k.id)}">Åpne skjematypen</a></p>` : '';
    return {
        emne: `Er skjematypen «${k.navn}» fortsatt i bruk?`,
        html: '<p>Hei,</p>'
            + `<p>Du står som eier av skjematypen «<b>${escapeHtml(k.navn)}</b>», som er ${sist}. Den skriver til:</p>`
            + `<ul>${linjer}</ul>`
            + '<p>For at den skal kunne gjøre det, er systemets servicebruker medlem av teamene over.</p>'
            + '<p>Skal skjematypen ikke brukes lenger, kan den arkiveres. Bruker ingen andre skjematyper de samme teamene, '
            + 'kan teameieren melde ut servicebrukeren.</p>'
            + '<p>Er skjematypen fortsatt i bruk, trenger du ikke gjøre noe. Spørsmålet kommer igjen neste måned så lenge den er ubrukt — '
            + 'en administrator kan slå varselet av under Administrasjon → Skjematyper → M365-koblinger.</p>'
            + lenke
    };
}

function standardDeps() {
    return {
        skjematyper: require('./skjema-storage'),
        saker: require('./skjema-forekomst-storage'),
        varsling: require('./varsling'),
        flytKaller: require('./flyt-kaller'),
        innstillinger: require('./innstillinger-storage')
    };
}

/**
 * Kjør jobben og bokfør utfallet. Kaster aldri.
 *
 * `utfall`: `ok` (alle varsler gikk, også når ingen var ubrukt), `delvis`
 * (noen feilet), `feil` (jobben kom ikke i gang).
 */
async function kjorUbruktVarsel({ kilde, log = () => {}, naa = Date.now(), deps = {} } = {}) {
    const d = { ...standardDeps(), ...deps };
    const { tabellKlient } = require('./storage');
    const hendelser = require('./hendelser-storage');
    const settStatus = async (felter) => {
        try { await tabellKlient('CacheMetadata').upsertEntity({ partitionKey: PK, rowKey: RK, ...felter }, 'Merge'); }
        catch (_) { /* statusraden er ikke kritisk */ }
    };
    await settStatus({ Status: 'kjører', Startet: new Date().toISOString(), Kilde: kilde, SistFeil: '' });
    log(`ubrukt-varsel: trigget av ${kilde}`);

    let liste;
    try {
        const [skjematyper, antall, avslatte] = await Promise.all([
            d.skjematyper.hentAlleSkjematyper(),
            d.saker.hentAntallPerType(),
            lesAvslatte(d.innstillinger)
        ]);
        liste = kandidater(skjematyper, byggOversikt(skjematyper, antall), avslatte, naa);
    } catch (e) {
        const melding = String(e.message || e);
        await settStatus({ Status: 'feil', Ferdig: new Date().toISOString(), SistFeil: melding.slice(0, 500) });
        hendelser.logg({ Type: 'skjematype.ubrukt-varsel', Aktor: kilde, ObjektType: 'jobb', ObjektId: RK, Melding: `Jobben kom ikke i gang: ${melding}`.slice(0, 500) });
        return { utfall: 'feil', melding };
    }

    const basis = String(process.env.SWA_URL || '').replace(/\/+$/, '');
    const varslet = [], feil = [];
    for (const k of liste) {
        try {
            const mottakere = await d.varsling.løsMottakere({ Personer: k.eiere.Personer || [], Roller: k.eiere.Roller || [] }, null, log);
            if (mottakere.length === 0) {
                feil.push({ id: k.id, melding: 'ingen eier med e-postadresse (team som eier gir ingen adresse)' });
                continue;
            }
            const { emne, html } = epost(k, basis);
            const r = await d.flytKaller.sendEpostViaFlyt({ mottakere, emne, html, skjematypeId: k.id, skjemaNavn: k.navn }, log);
            if (r?.status === 'ok' || r?.status === 'deaktivert') varslet.push({ id: k.id, mottakere: mottakere.length, status: r.status });
            else feil.push({ id: k.id, melding: `${r?.status || 'feil'}: ${r?.melding || ''}`.trim() });
        } catch (e) {
            feil.push({ id: k.id, melding: String(e.message || e) });
        }
    }

    const utfall = feil.length ? 'delvis' : 'ok';
    const tekst = `${varslet.length} skjematype${varslet.length === 1 ? '' : 'r'} varslet` + (feil.length ? `, ${feil.length} feilet` : '') + ` (${liste.length} ubrukte)`;
    log(`ubrukt-varsel: ${tekst}`);
    await settStatus({
        Status: utfall, Ferdig: new Date().toISOString(), SistOppdatert: new Date().toISOString(),
        AntallUbrukte: liste.length, AntallVarslet: varslet.length, AntallFeilet: feil.length,
        SistFeil: feil.map(f => `${f.id}: ${f.melding}`).join(' | ').slice(0, 500)
    });
    hendelser.logg({
        Type: 'skjematype.ubrukt-varsel', Aktor: kilde, ObjektType: 'jobb', ObjektId: RK,
        Melding: tekst, Detaljer: { varslet, feil, grenseDager: GRENSE_DAGER }
    });
    return { utfall, varslet, feil, ubrukte: liste.map(k => k.id) };
}

module.exports = { kjorUbruktVarsel, kandidater, epost, lesAvslatte, settVarsling, GRENSE_DAGER, INNSTILLING, PK, RK };
