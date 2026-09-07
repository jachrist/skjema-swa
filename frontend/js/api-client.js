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

function tilInnlogging() {
    window.location.href = '/.auth/login/aad?post_login_redirect_uri=' +
        encodeURIComponent(window.location.pathname + window.location.search);
}

async function utfør(path, options = {}, { hopperOver401 = false } = {}) {
    const headers = { ...defaultHeaders, ...(options.headers || {}) };
    const r = await fetch(path, { ...options, headers });
    if (r.status === 401 && !hopperOver401) {
        tilInnlogging();
        return null;
    }

    // Sesjonen kan ha løpt ut midt i en økt. SWA svarer da 401 på API-kallet,
    // men `responseOverrides` gjør om svaret til en 302 til innlogging — og
    // fetch følger den i stillhet. Er brukeren fortsatt gyldig hos Entra,
    // ender vi med en HTML-side og status 200 der kalleren ventet JSON.
    //
    // Det ser ikke ut som en autentiseringsfeil. Kalleren får en streng, og
    // feilen dukker opp langt unna årsaken: `innehavere.map is not a function`,
    // eller et tall som plutselig er antall tegn i en HTML-side. Derfor fanges
    // det her, én gang, i stedet for i hvert kall.
    const ct = r.headers.get('content-type') || '';
    if (path.startsWith('/api/') && !ct.includes('application/json')) {
        if (r.redirected || ct.includes('text/html')) {
            if (!hopperOver401) { tilInnlogging(); return null; }
            const e = new Error('Sesjonen er utløpt — logg inn på nytt');
            e.status = 401;
            throw e;
        }
    }

    if (!r.ok) {
        const feil = await les(r);
        const e = new Error(typeof feil === 'string' ? feil : (feil.melding || `${r.status} ${r.statusText}`));
        e.status = r.status;
        throw e;
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
