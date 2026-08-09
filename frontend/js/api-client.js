/**
 * Sentral fetch-wrapper. Håndterer 401 (redirect til login) og feilmeldinger.
 * SWA setter automatisk auth-cookies — vi trenger ikke bygge tokens selv.
 */
async function les(response) {
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await response.json();
    return await response.text();
}

// Default-headers som følger med hvert API-kall (f.eks. x-otp-token for
// ekstern-innsender-flyten). Sett via api.settHeader / fjernHeader.
const defaultHeaders = {};

async function utfør(path, options = {}, { hopperOver401 = false } = {}) {
    const headers = { ...defaultHeaders, ...(options.headers || {}) };
    const r = await fetch(path, { ...options, headers });
    if (r.status === 401 && !hopperOver401) {
        // SWA gjør redirect via responseOverrides — dette bør sjelden trigge
        window.location.href = '/.auth/login/aad?post_login_redirect_uri=' + encodeURIComponent(window.location.pathname);
        return null;
    }
    if (!r.ok) {
        const feil = await les(r);
        throw new Error(typeof feil === 'string' ? feil : (feil.melding || `${r.status} ${r.statusText}`));
    }
    return await les(r);
}

export const api = {
    get: (path, opts) => utfør(path, {}, opts),
    post: (path, body, opts) => utfør(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }, opts),
    put: (path, body, opts) => utfør(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }, opts),
    del: (path, opts) => utfør(path, { method: 'DELETE' }, opts),
    settHeader: (navn, verdi) => { defaultHeaders[navn] = verdi; },
    fjernHeader: (navn) => { delete defaultHeaders[navn]; }
};
