/**
 * Adressen lenker skal ha når de kopieres og deles.
 *
 * Kopier-knappene bygde lenker av `location.origin` — adressen i nettleseren
 * til den som kopierte. Jobbet en administrator på `*.azurestaticapps.net`,
 * fikk den eksterne skjemalenka, rapportlenka og logo-adressen i e-postmalene
 * det vertsnavnet, også etter at domenet var flyttet (meldt 04.11.2026).
 *
 * Lenkene API-et sender ut, bruker `SWA_URL`. Nå gjør kopier-lenkene det
 * også: `/api/ping` oppgir den som `offentligAdresse`, og denne modulen
 * henter den én gang per side. Mangler den — SWA_URL ikke satt, eller ping
 * nås ikke — brukes nettleserens adresse, som før.
 *
 * Bruk: start `lastOffentligAdresse()` tidlig, og les `offentligAdresse()`
 * der lenka bygges. Lenker som tegnes før svaret er kommet, tegnes på nytt
 * når løftet er innfridd.
 */
let adresse = null;
let løfte = null;

/** Den offentlige adressen, uten skråstrek til slutt. Synkron. */
export function offentligAdresse() {
    return adresse || window.location.origin;
}

/** Hent adressen fra serveren (én gang). Kaster aldri. */
export function lastOffentligAdresse() {
    if (!løfte) {
        løfte = fetch('/api/ping')
            .then(r => (r.ok ? r.json() : null))
            .then(svar => {
                const a = String(svar?.offentligAdresse || '').trim().replace(/\/+$/, '');
                if (/^https:\/\/[^/\s]+$/.test(a)) adresse = a;
                return offentligAdresse();
            })
            .catch(() => offentligAdresse());
    }
    return løfte;
}
