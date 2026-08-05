/**
 * Sentral fetch-wrapper. Håndterer 401 (redirect til login) og feilmeldinger.
 * SWA setter automatisk auth-cookies — vi trenger ikke bygge tokens selv.
 */
async function les(response) {
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await response.json();
    return await response.text();
}

async function utfør(path, options = {}) {
    const r = await fetch(path, options);
    if (r.status === 401) {
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
    get: (path) => utfør(path),
    post: (path, body) => utfør(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }),
    put: (path, body) => utfør(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }),
    del: (path) => utfør(path, { method: 'DELETE' })
};
