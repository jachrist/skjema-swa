/**
 * E-post via Microsoft Graph, i stedet for e-postgrenen i varslingsflyten.
 *
 * Fase 1 i docs/VURDERING-FLYTER.md, første del (19.11.2026): bare e-posten
 * i varslingene — kvittering, behandlervarsel, beslutning, ferdig, samtale og
 * nøkkelkalenderens påminnelser. Teams, Planner og Teams-kanal går fortsatt
 * til flyten. Utsending, purring og engangskode kommer senere.
 *
 * ## Av som standard
 *
 * `EPOST_VEI=graph` slår den på. Alt annet, også usatt, er `flyt` — dagens
 * oppførsel. Samme konvensjon som `FLYT_AUTH`: én verdi betyr noe, en
 * tastefeil gir standarden. Pilot og prod har ikke innstillingen, og merker
 * ingenting av at koden finnes.
 *
 * ## Identiteten
 *
 * Tokenet hentes med Function App-ens managed identity, gjennom
 * `lib/plattform-token.js` — samme vei som flyt-tokenet. Det krever at
 * Microsoft 365 ligger i samme tenant som identiteten, og at identiteten har
 * fått `Mail.Send` (se docs/VURDERING-FLYTER.md). Sertifikatveien for en annen
 * tenant kommer når prod trenger den.
 *
 * ## Én e-post per mottaker, unntatt kopi
 *
 * Som flyten: hver mottaker får sin egen e-post. Har kallet `kopi`, sendes
 * ÉN e-post med kopimottakerne i Cc — formen docs/FLYTER.md beskriver under
 * «kopi[] — VENTER PÅ FLYTEN». Den blir ferdig her, uten en ALM-runde.
 * Kopiadressene står også i `mottakere` (overgangsformen i flyt-kaller.js),
 * og hoppes over der.
 */
const { tokenFraPlattformen } = require('./plattform-token');

/** Graph sin ressurs. Uten skråstrek — det er formen Graph selv oppgir. */
const GRAPH_RESSURS = 'https://graph.microsoft.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Nye forsøk ved struping eller midlertidig feil. */
const MAKS_FORSOK = 3;
const MAKS_VENT_MS = 30000;
const FORNY_FOR_MS = 5 * 60 * 1000;

let bufret = null;  // { verdi, utloper }

/**
 * Hvilken vei e-posten går i dette miljøet. Alle feltene er alltid satt —
 * systemsiden og diagnosen viser dem.
 *
 * @returns {{ vei: 'flyt'|'graph', avsender: string, gyldig: boolean, grunn: string }}
 */
function epostVei(env = process.env) {
    const satt = String(env.EPOST_VEI || '').trim().toLowerCase();
    const avsender = String(env.EPOST_AVSENDER || '').trim();
    if (satt !== 'graph') {
        return {
            vei: 'flyt', avsender, gyldig: true,
            grunn: !satt ? 'EPOST_VEI er ikke satt — e-post går via varslingsflyten (standard)'
                : satt === 'flyt' ? 'EPOST_VEI=flyt — e-post går via varslingsflyten'
                    : `EPOST_VEI er satt til «${satt}», som ikke er graph eller flyt — e-post går via varslingsflyten`
        };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(avsender)) {
        // Ikke tilbake til flyten i det stille: da ser det ut som Graph-veien
        // virker, mens den aldri er prøvd.
        return {
            vei: 'graph', avsender, gyldig: false,
            grunn: 'EPOST_VEI=graph, men EPOST_AVSENDER mangler eller er ikke en e-postadresse — ingen e-post sendes'
        };
    }
    return { vei: 'graph', avsender, gyldig: true, grunn: `EPOST_VEI=graph — e-post sendes fra ${avsender} via Graph` };
}

/**
 * Hvem som får hvilken e-post. Ren funksjon — regelen står her og testes her.
 *
 * Uten kopi: én e-post per mottaker, som flyten. Med kopi: den første
 * hovedmottakeren får én e-post med kopimottakerne i Cc, resten av
 * hovedmottakerne får hver sin. Har kallet ingen hovedmottaker (kvittering
 * uten innsenderadresse), går e-posten til den første i kopi, med resten i Cc.
 *
 * @returns {{ til: object[], kopi: object[] }[]}
 */
function planlegg(mottakere, kopi = []) {
    const nokkel = (m) => String(m?.epost || '').trim().toLowerCase();
    const unike = (liste) => {
        const sett = new Set();
        return (liste || []).filter(m => {
            const k = nokkel(m);
            if (!k || sett.has(k)) return false;
            sett.add(k);
            return true;
        });
    };
    const cc = unike(kopi);
    const ccSett = new Set(cc.map(nokkel));
    const hoved = unike(mottakere).filter(m => !ccSett.has(nokkel(m)));

    if (cc.length === 0) return hoved.map(m => ({ til: [m], kopi: [] }));
    if (hoved.length === 0) return [{ til: [cc[0]], kopi: cc.slice(1) }];
    return [{ til: [hoved[0]], kopi: cc }, ...hoved.slice(1).map(m => ({ til: [m], kopi: [] }))];
}

/** Bearer-token for Graph, bufret til fem minutter før utløp. Kaster med årsaken. */
async function graphToken() {
    const na = Date.now();
    if (bufret && bufret.utloper - FORNY_FOR_MS > na) return bufret.verdi;
    const klientId = String(process.env.AZURE_CLIENT_ID || '').trim();
    let svar;
    try {
        svar = await tokenFraPlattformen(GRAPH_RESSURS, klientId);
    } catch (e) {
        throw new Error(`Graph-tokenet kunne ikke hentes: ${e.message}`);
    }
    const ms = Date.parse(svar?.utloper);
    bufret = { verdi: `Bearer ${svar.token}`, utloper: Number.isFinite(ms) ? ms : na };
    return bufret.verdi;
}

/** Bare for test. */
function glemToken() { bufret = null; }

const adresse = (m) => ({ emailAddress: { address: String(m.epost).trim(), ...(m.navn ? { name: String(m.navn) } : {}) } });

/** Hvor lenge Graph ber oss vente, i ms. `Retry-After` er sekunder. */
function ventetid(res, forsok) {
    const s = Number(res?.headers?.get?.('retry-after'));
    const ms = Number.isFinite(s) && s > 0 ? s * 1000 : 1000 * 2 ** forsok;
    return Math.min(ms, MAKS_VENT_MS);
}

/**
 * Send én e-post. Kaster ikke — svarer med samme form som flytkallene:
 * `{ status: 'ok' | 'feil', melding?, forsok }`.
 *
 * Prøver igjen ved 429, 503 og 504, høyst tre ganger, og venter så lenge
 * `Retry-After` sier. Andre feil er endelige: en 403 blir ikke bedre av å
 * spørre igjen.
 */
async function sendEnEpost({ til, kopi = [], emne, html }, { avsender, fetchFn = fetch, vent = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
    let token;
    try {
        token = await graphToken();
    } catch (e) {
        return { status: 'feil', melding: e.message, forsok: 0 };
    }
    const kropp = JSON.stringify({
        message: {
            subject: String(emne || ''),
            body: { contentType: 'HTML', content: String(html || '') },
            toRecipients: til.map(adresse),
            ...(kopi.length ? { ccRecipients: kopi.map(adresse) } : {})
        },
        saveToSentItems: true
    });
    const url = `${GRAPH}/users/${encodeURIComponent(avsender)}/sendMail`;
    for (let forsok = 1; ; forsok++) {
        let res;
        try {
            res = await fetchFn(url, {
                method: 'POST',
                headers: { Authorization: token, 'Content-Type': 'application/json' },
                body: kropp
            });
        } catch (e) {
            return { status: 'feil', melding: `Graph-kallet feilet: ${e.message}`, forsok };
        }
        if (res.status === 202 || res.ok) return { status: 'ok', forsok };
        if ([429, 503, 504].includes(res.status) && forsok < MAKS_FORSOK) {
            await vent(ventetid(res, forsok));
            continue;
        }
        const tekst = await res.text().catch(() => '');
        let feil = tekst;
        try { const j = JSON.parse(tekst); feil = `${j?.error?.code || ''} ${j?.error?.message || ''}`.trim() || tekst; } catch (_) { /* rå tekst */ }
        return { status: 'feil', melding: `Graph svarte ${res.status}: ${String(feil).slice(0, 300)}`, forsok };
    }
}

/**
 * Send varslingens e-post: én eller flere, etter `planlegg`.
 *
 * Svarer `ok` når alle gikk, ellers `feil` med hvor mange som feilet og den
 * første årsaken. `sendt` og `feilet` er alltid satt.
 */
async function sendEpost({ mottakere, kopi = [], emne, html }, { log = () => {}, ...valg } = {}) {
    const vei = epostVei();
    if (vei.vei !== 'graph' || !vei.gyldig) {
        return { status: 'feil', melding: vei.grunn, sendt: 0, feilet: 0 };
    }
    const plan = planlegg(mottakere, kopi);
    if (plan.length === 0) return { status: 'hoppet-over', melding: 'Ingen mottakere', sendt: 0, feilet: 0 };

    let sendt = 0;
    const feil = [];
    for (const e of plan) {
        const r = await sendEnEpost({ til: e.til, kopi: e.kopi, emne, html }, { avsender: vei.avsender, ...valg });
        if (r.status === 'ok') sendt++;
        else feil.push(r.melding);
    }
    log(`epost via Graph: ${sendt} sendt, ${feil.length} feilet (${plan.length} e-post, `
        + `${plan.reduce((n, e) => n + e.til.length + e.kopi.length, 0)} mottakere)`);
    if (feil.length === 0) return { status: 'ok', sendt, feilet: 0 };
    return { status: 'feil', melding: `${feil.length} av ${plan.length} e-poster feilet: ${feil[0]}`, sendt, feilet: feil.length };
}

module.exports = { epostVei, planlegg, sendEpost, sendEnEpost, graphToken, GRAPH_RESSURS, MAKS_FORSOK, _glemToken: glemToken };
