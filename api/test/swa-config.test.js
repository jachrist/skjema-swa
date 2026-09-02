/**
 * Validering av staticwebapp.config.<miljø>.json.
 *
 * SWA validerer fila ved deploy, og avviser den som helhet hvis én rute er
 * ugyldig. Utslaget er ikke en manglende regel — det er ingen regler i det
 * hele tatt: ruteregler, globale headere, 401-overriden og auth-blokka
 * forsvinner samtidig, og innlogging faller tilbake til SWA sin innebygde
 * AAD-provider mot /common/, som godtar konti fra hvilken som helst tenant.
 *
 * Det skjedde 02.09.2026 med «/api/skjematyper/*​/publikum». Jokertegn er
 * bare tillatt SIST i en rute; sto det inni, ble alt forkastet.
 *
 * Feilen vises bare i byggeloggen, og bare som en rød linje i en deploy som
 * ellers går grønt. Derfor sjekkes den her i stedet.
 *
 * Kjøres med:  node api/test/swa-config.test.js
 */
const fs = require('fs');
const path = require('path');

const rot = path.join(__dirname, '..', '..');
const filer = fs.readdirSync(rot).filter(n => /^staticwebapp\.config\.[a-z]+\.json$/.test(n));

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

sjekk('finner miljøkonfigurasjonene', filer.length >= 2, true);

for (const fil of filer) {
    const rå = fs.readFileSync(path.join(rot, fil), 'utf8');
    let j = null;
    try { j = JSON.parse(rå); } catch (e) { feil++; console.log(`FEIL  ${fil} er ugyldig JSON: ${e.message}`); continue; }

    const ruter = (j.routes || []).map(r => r.route);

    // ---------- jokertegn kun til slutt ----------
    {
        const ulovlige = ruter.filter(r => r.includes('*') && !r.endsWith('*'));
        sjekk(`${fil}: ingen jokertegn inni en rute`, ulovlige, []);
    }

    // ---------- ruter skal begynne med / ----------
    {
        const uten = ruter.filter(r => !r.startsWith('/'));
        sjekk(`${fil}: alle ruter starter med /`, uten, []);
    }

    // ---------- ingen duplikater ----------
    {
        const sett = new Set();
        const duplikat = ruter.filter(r => sett.size === sett.add(r).size);
        sjekk(`${fil}: ingen dupliserte ruter`, duplikat, []);
    }

    // ---------- catch-all sist ----------
    {
        // SWA tar første treff. Ligger /api/* før de anonyme unntakene, blir
        // de aldri nådd — og cron-jobbene får 401 uten at noe annet feiler.
        const iApi = ruter.indexOf('/api/*');
        const anonymeEtter = (j.routes || [])
            .slice(iApi + 1)
            .filter(r => r.route.startsWith('/api/') && (r.allowedRoles || []).includes('anonymous'))
            .map(r => r.route);
        if (iApi !== -1) sjekk(`${fil}: ingen anonyme api-ruter etter /api/*`, anonymeEtter, []);
    }

    // ---------- endepunktene cron-jobbene kaller må være anonyme ----------
    {
        // GitHub Actions har ingen SWA-sesjon; de autentiserer med
        // x-scheduler-key i handleren. Faller en av disse under
        // «authenticated», stopper den nattlige jobben stille.
        const anonyme = new Set((j.routes || [])
            .filter(r => (r.allowedRoles || []).includes('anonymous'))
            .map(r => r.route));
        const kreves = [
            '/api/refresh-fs', '/api/utsending/purre', '/api/backup/kjor',
            '/api/nokkelkalender/sjekk', '/api/postnumre/refresh-bring',
            '/api/utsending/send-forfalte'
        ];
        sjekk(`${fil}: cron-endepunkter er anonyme`, kreves.filter(r => !anonyme.has(r)), []);
    }

    // ---------- landingssiden ----------
    {
        // index.html er utfyllingssiden og krever en skjematype_id i URL-en.
        // Sender vi «/» eller en ukjent sti dit, moetes brukeren av «Mangler
        // skjematype_id» rett etter innlogging. Skjemavelgeren er landingssiden.
        const rot = (j.routes || []).find(r => r.route === '/');
        sjekk(`${fil}: / peker på skjemavelgeren`, rot?.rewrite, '/velgskjematype.html');
        sjekk(`${fil}: ukjent sti peker på skjemavelgeren`,
            j.navigationFallback?.rewrite, '/velgskjematype.html');
        // Rota må ligge før eventuelle bredere treff — SWA tar det første.
        sjekk(`${fil}: /-ruta ligger først`, (j.routes || [])[0]?.route, '/');
    }

    // ---------- auth-blokka ----------
    {
        const reg = j.auth?.identityProviders?.azureActiveDirectory?.registration;
        sjekk(`${fil}: har auth-registrering`, !!reg, true);
        if (reg) {
            // Tenant FØR /v2.0. Omvendt rekkefølge gjør blokka ugyldig, og da
            // brukes SWA sin innebygde provider mot /common/ i stillhet.
            sjekk(`${fil}: issuer har riktig form`,
                /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i.test(reg.openIdIssuer), true);
            // Skal være NAVNET på en app-setting, ikke selve client-id-en.
            sjekk(`${fil}: clientIdSettingName er et navn`,
                /^[0-9a-f-]{36}$/i.test(reg.clientIdSettingName), false);
        }
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
