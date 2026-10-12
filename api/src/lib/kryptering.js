/**
 * Kryptering (AES-256-GCM) + anonymisering av skjemasvar.
 *
 * Portert fra legacy azure-function-skjema/src/kryptering.js.
 *
 * Ciphertext-format: "<iv-hex>:<tag-hex>:<ciphertext-base64>"
 * Krypteringsomfang på skjematype (Skjematype.Krypteres):
 *   'Nei'   — ingen kryptering
 *   'Svar'  — per-felt-svar krypteres, metadata i klartekst
 *   'Alt'   — hele skjemaet krypteres som én blob
 *
 * Anonymisering: Innsender_Epost erstattes med "anonym-<12-hex>" hvor hex er
 * SHA-256(salt + normalisert epost). Innsender_Navn settes til "Anonymisert".
 */

const crypto = require('crypto');

function krypterStreng(tekst, nokkelBuffer) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', nokkelBuffer, iv);
    const encrypted = Buffer.concat([cipher.update(tekst, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('base64')}`;
}

function dekrypterStreng(kryptertStreng, nokkelBuffer) {
    const [ivHex, tagHex, ciphertextBase64] = kryptertStreng.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextBase64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', nokkelBuffer, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function krypterKompaktSvar(skjema, nokkelBuffer) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    if (!Array.isArray(kopi.Svar)) return kopi;
    for (const svar of kopi.Svar) {
        if (svar.sva && Array.isArray(svar.sva) && svar.sva.length > 0) {
            svar.sva = krypterStreng(JSON.stringify(svar.sva), nokkelBuffer);
        }
        // Visningsteksten er like sensitiv som verdien — den inneholder navn.
        if (svar.svt && Array.isArray(svar.svt) && svar.svt.length > 0) {
            svar.svt = krypterStreng(JSON.stringify(svar.svt), nokkelBuffer);
        }
    }
    kopi.Kryptert = true;
    return kopi;
}

function krypterFulltSvar(skjema, nokkelBuffer) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    for (const seksjon of (kopi.Seksjoner || [])) {
        for (const felt of (seksjon.Felter || [])) {
            if (felt.Svar && Array.isArray(felt.Svar) && felt.Svar.length > 0) {
                felt.Svar = krypterStreng(JSON.stringify(felt.Svar), nokkelBuffer);
            }
            if (felt.SvarTekst && Array.isArray(felt.SvarTekst) && felt.SvarTekst.length > 0) {
                felt.SvarTekst = krypterStreng(JSON.stringify(felt.SvarTekst), nokkelBuffer);
            }
        }
    }
    kopi.Kryptert = true;
    return kopi;
}

function krypterHeleSkjemaet(skjema, nokkelBuffer) {
    const kryptert = krypterStreng(JSON.stringify(skjema), nokkelBuffer);
    return {
        Skjema_id: skjema.Skjema_id,
        Skjematype_id: skjema.Skjematype_id,
        Kryptert: kryptert
    };
}

function dekrypterFulltSvar(skjema, nokkelBuffer) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    for (const seksjon of (kopi.Seksjoner || [])) {
        for (const felt of (seksjon.Felter || [])) {
            if (typeof felt.Svar === 'string' && felt.Svar.includes(':')) {
                try {
                    felt.Svar = JSON.parse(dekrypterStreng(felt.Svar, nokkelBuffer));
                } catch (_) { /* la stå kryptert hvis dekryptering feiler */ }
            }
            if (typeof felt.SvarTekst === 'string' && felt.SvarTekst.includes(':')) {
                try {
                    felt.SvarTekst = JSON.parse(dekrypterStreng(felt.SvarTekst, nokkelBuffer));
                } catch (_) { /* la stå kryptert */ }
            }
        }
    }
    delete kopi.Kryptert;
    return kopi;
}

function dekrypterKompaktSvar(skjema, nokkelBuffer) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    if (!Array.isArray(kopi.Svar)) return kopi;
    for (const svar of kopi.Svar) {
        if (typeof svar.sva === 'string' && svar.sva.includes(':')) {
            try {
                svar.sva = JSON.parse(dekrypterStreng(svar.sva, nokkelBuffer));
            } catch (_) { /* la stå kryptert */ }
        }
        if (typeof svar.svt === 'string' && svar.svt.includes(':')) {
            try {
                svar.svt = JSON.parse(dekrypterStreng(svar.svt, nokkelBuffer));
            } catch (_) { /* la stå kryptert */ }
        }
    }
    delete kopi.Kryptert;
    return kopi;
}

function dekrypterHeleSkjemaet(skjema, nokkelBuffer) {
    if (!skjema?.Kryptert) return skjema;
    return JSON.parse(dekrypterStreng(skjema.Kryptert, nokkelBuffer));
}

/**
 * Krypter skjema basert på omfang.
 * @param {Object} skjema
 * @param {Buffer|string} nokkel  — Buffer eller base64-streng
 * @param {'Svar'|'Alt'} omfang
 */
function krypterSkjema(skjema, nokkel, omfang) {
    const buf = Buffer.isBuffer(nokkel) ? nokkel : Buffer.from(String(nokkel), 'base64');
    if (omfang === 'Alt') return krypterHeleSkjemaet(skjema, buf);
    if (Array.isArray(skjema.Svar)) return krypterKompaktSvar(skjema, buf);
    return krypterFulltSvar(skjema, buf);
}

/**
 * Dekrypter skjema — detekterer format automatisk (Alt-blob vs per-felt-Svar).
 */
function dekrypterSkjema(skjema, nokkel) {
    const buf = Buffer.isBuffer(nokkel) ? nokkel : Buffer.from(String(nokkel), 'base64');
    if (skjema?.Kryptert && typeof skjema.Kryptert === 'string') {
        return dekrypterHeleSkjemaet(skjema, buf);
    }
    if (Array.isArray(skjema?.Svar)) return dekrypterKompaktSvar(skjema, buf);
    return dekrypterFulltSvar(skjema, buf);
}

/**
 * Pseudonymet en gitt e-postadresse får ved anonymisering.
 *
 * SHA-256(salt + normalisert adresse), første 12 hex-tegn. Deterministisk per
 * salt: samme person gir samme pseudonym, på tvers av skjemaer og over tid.
 *
 * Det er ikke bare en egenskap — det er det som gjør at en anonymisert
 * avstemning fortsatt kan begrenses til ett svar per person (`svargrense.js`).
 * Regelen ligger derfor her, ett sted, og ikke som en kopi hos den som teller.
 * To implementasjoner av samme hash ville gitt to ulike svar på «har denne
 * personen stemt», og den ene ville sluppet en ekstra stemme gjennom.
 *
 * Returnerer tom streng for tom adresse.
 */
function pseudonymFor(epost, salt) {
    const normalisert = String(epost || '').trim().toLowerCase();
    if (!normalisert) return '';
    const data = salt ? String(salt) + normalisert : normalisert;
    const hash = crypto.createHash('sha256').update(data, 'utf8').digest('hex').substring(0, 12);
    return `anonym-${hash}`;
}

/**
 * Anonymiser innsender-info. Salt gis via env HASH_SALT.
 */
function anonymiserInnsender(skjema, salt) {
    const kopi = JSON.parse(JSON.stringify(skjema));
    const epost = kopi.Innsender_Epost || kopi.Innsender_epost || '';
    if (!epost) return kopi;
    const pseudonym = pseudonymFor(epost, salt);
    kopi.Innsender_Epost = pseudonym;
    kopi.Innsender_epost = pseudonym;
    if (kopi.Innsender_Navn) kopi.Innsender_Navn = 'Anonymisert';
    if (kopi.Innsender) kopi.Innsender = 'Anonymisert';
    kopi.Anonymisert = true;
    return kopi;
}

/**
 * Generer en 256-bit nøkkel som base64-streng.
 */
function genererNokkel() {
    return crypto.randomBytes(32).toString('base64');
}

/**
 * Ser verdien ut som chiffertekst fra `krypterStreng`?
 *
 * Formen er `iv:tag:chiffer` — 24 heksetegn, 32 heksetegn, så base64.
 *
 * Finnes for å avsløre en stille feil som IKKE er innført her:
 * `dekrypterFulltSvar` fanger feil PER FELT og lar chifferteksten stå
 * («la stå kryptert hvis dekryptering feiler»), men sletter likevel
 * `Kryptert`-flagget på skjemaet. Med feil eller rotert nøkkel kommer
 * skjemaet derfor ut som om det var dekryptert, med «fa04…:d2c9…:q8Hq…» i
 * hver celle — i rapporter, datauttrekk, Power BI og PDF. Ingenting kaster,
 * og ingenting logges.
 *
 * Den dypere feilen hører i dekrypterFulltSvar/dekrypterKompaktSvar og er
 * ikke rettet her. Dette gjør den i det minste hørbar.
 */
const CHIFFER_FORM = /^[0-9a-f]{24}:[0-9a-f]{32}:/;

function serKryptertUt(skjema) {
    const sjekk = (v) => typeof v === 'string' && CHIFFER_FORM.test(v);
    for (const seksjon of (skjema?.Seksjoner || [])) {
        for (const felt of (seksjon?.Felter || [])) {
            if (sjekk(felt?.Svar) || sjekk(felt?.SvarTekst)) return true;
        }
    }
    for (const svar of (Array.isArray(skjema?.Svar) ? skjema.Svar : [])) {
        if (sjekk(svar?.sva) || sjekk(svar?.svt)) return true;
    }
    return false;
}

/**
 * Dekrypter ET HELT SETT skjemaer for én skjematype.
 *
 * Kryptering er på skjematype-nivå, så én nøkkel dekker alle forekomstene.
 * Nøkkelen hentes bare hvis noen av dem faktisk er krypterte.
 *
 * Denne fantes i tre eksemplarer — `power-bi.js`, `datauttrekk.js` og
 * `rapport-kjor.js` — med samme løkke og nesten samme logglinje. Tre kopier av
 * samme regel er den tilbakevendende feilklassen i dette repoet: de svarer
 * ulikt så snart den ene rettes. Her betydde det at én av dem allerede manglet
 * advarselen om at nøkkelen var borte, og et uttrekk kunne komme ut med
 * «[Kryptert]» i hver celle uten at loggen sa hvorfor.
 *
 * Et skjema som ikke lar seg dekryptere returneres URØRT, ikke utelatt. En
 * rad som forsvinner er verre enn en rad man ser er kryptert: den første kan
 * ikke skilles fra «skjemaet finnes ikke».
 *
 * @param {Array} skjemaer
 * @param {string} skjematypeId
 * @param {{hentNokkel: Function}} nokkelStorage — injiseres, slik at
 *        kryptering.js ikke drar inn lagringslaget (og testene slipper det).
 * @param {Function} log
 * @param {{nokkel?: string}} opts — `nokkel` brukes i stedet for oppslag.
 *        Datauttrekket lar brukeren oppgi nøkkelen i forespørselen, og en
 *        hjelper som alltid slo opp selv ville tatt den veien bort i stillhet.
 */
async function dekrypterAlle(skjemaer, skjematypeId, nokkelStorage, log = () => {}, opts = {}) {
    const liste = Array.isArray(skjemaer) ? skjemaer : [];
    if (!liste.some(s => s?.Kryptert)) return liste;

    const oppgitt = opts.nokkel ? String(opts.nokkel).trim() : '';
    const nokkel = oppgitt || await nokkelStorage.hentNokkel(skjematypeId);
    if (!nokkel) {
        log(`dekrypterAlle: krypterte skjemaer, men nøkkel mangler for skjematype ${skjematypeId}`
            + ' — verdier vises som [Kryptert]');
        return liste;
    }
    let feilet = 0;
    const ut = liste.map(s => {
        if (!s?.Kryptert) return s;
        try { return dekrypterSkjema(s, nokkel); }
        catch (_) { feilet++; return s; }
    });
    // Et stille catch gjør «det gikk galt» umulig å skille fra «skjemaet var
    // ikke kryptert». Tallet skal stå i loggen.
    if (feilet > 0) log(`dekrypterAlle: ${feilet} av ${liste.length} skjemaer kastet under dekryptering`);

    // Og det som IKKE kaster: feil nøkkel gir ingen feil, bare chiffertekst
    // der verdien skulle stått. Uten denne linja er «gal nøkkel» og «dette er
    // teksten brukeren skrev» umulig å skille fra hverandre i utdataene.
    const sertKryptert = ut.filter(serKryptertUt).length;
    if (sertKryptert > 0) {
        log(`dekrypterAlle: ${sertKryptert} av ${liste.length} skjemaer har fortsatt `
            + `chiffertekst i svarene etter dekryptering for skjematype ${skjematypeId} `
            + '— nøkkelen passer ikke (rotert?)');
    }
    return ut;
}

module.exports = {
    dekrypterAlle,
    serKryptertUt,
    krypterStreng,
    dekrypterStreng,
    krypterSkjema,
    dekrypterSkjema,
    anonymiserInnsender,
    pseudonymFor,
    genererNokkel
};
