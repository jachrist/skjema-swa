/**
 * Nullpunktsjekk for gevinstoppfølging.
 *
 * Når en eier setter en skjematype i produksjon, ønsker vi at nullpunktet
 * (baseline) for prosessen skjemaet støtter er registrert. Det gjøres ved å
 * sende inn et eget baseline-skjema, hvor felt 1-01 inneholder ID-en til
 * skjematypen nullpunktet gjelder for. Hvilken skjematype som er baseline
 * settes i admin-panelet under Gevinstoppfølging (`Gevinstestimat.SkjemaId`).
 *
 * Dette er en ADVARSEL, ikke en sperre. TODO-punkt 49 er tydelig på det:
 * manglende utfylling skal føre til en påminnelse og en varig merking i
 * skjemaoversikten for eiere og admin — ingen regel om at skjemaet må være
 * utfylt før overføring til produksjon. Eieren skal kunne gå videre; poenget
 * er at ingen skal gjøre det uten å vite at nullpunktet mangler.
 *
 * Er innstillingen ikke satt, sjekker vi ingenting. Å gjette på hvilken
 * skjematype som er baseline ville gitt falske advarsler for alle.
 */
const innstillinger = require('./innstillinger-storage');
const forekomst = require('./skjema-forekomst-storage');
const { finnSvarForFeltRef } = require('./placeholder');

// Feltet i baseline-skjemaet som peker på skjematypen nullpunktet gjelder for.
const REF_SEKSJON = 1;
const REF_FELT = 1;

// Skjema_status: 1 = mellomlagret, 2 og oppover = sendt inn. Et påbegynt
// baseline-skjema teller ikke — da er nullpunktet ikke registrert.
const STATUS_INNSENDT = 2;

async function baselineSkjematypeId() {
    try {
        const rad = await innstillinger.hent('Gevinstestimat.SkjemaId');
        const id = String(rad?.Verdi || '').trim();
        return id || null;
    } catch (_) {
        return null;
    }
}

/**
 * Skjematype-ID-ene som har et registrert nullpunkt.
 *
 * Én spørring dekker hele oversikten, i stedet for én per skjematype. Kalles
 * av skjemaoversikten for å merke de som mangler.
 *
 * @returns {Promise<{konfigurert: boolean, baselineTypeId: string|null, dekkede: string[]}>}
 */
async function hentDekkede() {
    const baselineTypeId = await baselineSkjematypeId();
    if (!baselineTypeId) return { konfigurert: false, baselineTypeId: null, dekkede: [] };

    let skjemaer = [];
    try {
        skjemaer = await forekomst.hentAlleSkjemaerForType(baselineTypeId, { fulltFormat: true });
    } catch (_) {
        // Finnes ikke baseline-typen ennå, er ingenting dekket — men det er
        // ikke en feil som skal velte oversikten.
        return { konfigurert: true, baselineTypeId, dekkede: [] };
    }

    const dekkede = new Set();
    for (const s of skjemaer) {
        if (Number(s?.Skjema_status || 0) < STATUS_INNSENDT) continue;
        const svar = finnSvarForFeltRef(s.Seksjoner || [], REF_SEKSJON, REF_FELT);
        const id = normaliser(svar);
        if (id) dekkede.add(id);
    }
    return { konfigurert: true, baselineTypeId, dekkede: [...dekkede] };
}

/**
 * Svaret kan være tall, streng, eller en liste fra et flervalgsfelt. Vi
 * sammenligner som trimmet streng — «113 », 113 og «113» er samme skjematype.
 */
function normaliser(verdi) {
    if (verdi === null || verdi === undefined) return '';
    if (Array.isArray(verdi)) return normaliser(verdi[0]);
    if (typeof verdi === 'object') return normaliser(verdi.Verdi ?? verdi.Tekst ?? '');
    return String(verdi).trim();
}

/**
 * Er nullpunktet registrert for én bestemt skjematype?
 *
 * @returns {Promise<{sjekket, registrert, baselineTypeId, melding}>}
 *   sjekket=false betyr at vi ikke har grunnlag for å si noe — da skal
 *   kalleren tie, ikke advare.
 */
async function nullpunktRegistrert(skjematypeId) {
    const id = normaliser(skjematypeId);
    const { konfigurert, baselineTypeId, dekkede } = await hentDekkede();

    if (!konfigurert) {
        return {
            sjekket: false, registrert: false, baselineTypeId: null,
            melding: 'Ingen baseline-skjematype er satt under Gevinstoppfølging — nullpunkt sjekkes ikke.'
        };
    }
    // Baseline-skjemaet trenger ikke sitt eget nullpunkt.
    if (id && id === normaliser(baselineTypeId)) {
        return { sjekket: false, registrert: true, baselineTypeId, melding: '' };
    }

    const registrert = dekkede.includes(id);
    return {
        sjekket: true,
        registrert,
        baselineTypeId,
        melding: registrert
            ? ''
            : `Nullpunktdefinisjon (baseline) er ikke registrert for denne skjematypen. `
              + `Send inn baseline-skjemaet (skjematype ${baselineTypeId}) med ${id} i første felt.`
    };
}

module.exports = { hentDekkede, nullpunktRegistrert, normaliser, REF_SEKSJON, REF_FELT };
