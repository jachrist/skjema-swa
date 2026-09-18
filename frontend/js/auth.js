/**
 * SWA auth-hjelper.
 * .auth/me → { clientPrincipal: { userDetails, userRoles, identityProvider, ... } | null }
 */
export async function hentInnloggetBruker() {
    try {
        const r = await fetch('/.auth/me');
        if (!r.ok) return null;
        const data = await r.json();
        return data.clientPrincipal || null;
    } catch (_) {
        return null;
    }
}

export function logInn(redirectTo = '/') {
    window.location.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(redirectTo)}`;
}

export function logUt(redirectTo = '/') {
    window.location.href = `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(redirectTo)}`;
}

/**
 * Skjul lenken til skjemaoversikten for dem som ikke skal se den.
 *
 * Lenken går til «Velg skjema» og skal bare vises for admin, skjemaskapere og
 * eiere. Avgjørelsen tas på serveren (`serSkjemaoversikt` fra `/api/whoami`),
 * ikke her: eierskap er per skjematype, og en klient kan uansett ikke være
 * kilden til hvem som er hva.
 *
 * Lenkene merkes med `data-oversiktslenke` i markupen. Det er med vilje, og
 * ikke et selektor-søk etter `href="/velgskjematype.html"`: den samme URL-en
 * brukes også som «Avbryt» midt i utfyllingen, og den knappen skal virke for
 * alle. En regel som ikke kan skille dem fra hverandre, ville tatt begge.
 *
 * Skjuler først, spør etterpå. Lenken ligger i markupen fordi den gjelder de
 * fleste som er innlogget, men et glimt av noe man ikke skal ha, er verre enn
 * at den kommer et halvt sekund senere.
 *
 * Feiler kallet, forblir den skjult. En lenke for lite er en omvei; en lenke
 * for mye er en side brukeren ikke skulle sett.
 */
export async function styrOversiktslenker(api) {
    const lenker = [...document.querySelectorAll('[data-oversiktslenke]')];
    if (lenker.length === 0) return false;
    for (const l of lenker) l.hidden = true;
    try {
        const meg = await api.get('/api/whoami', { hopperOver401: true });
        if (!meg?.serSkjemaoversikt) return false;
        for (const l of lenker) l.hidden = false;
        return true;
    } catch (_) {
        return false;
    }
}
