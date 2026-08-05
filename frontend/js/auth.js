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
