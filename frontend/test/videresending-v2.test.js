/**
 * Videresendingen på v2-prod (videresending-v2/ og
 * .github/workflows/deploy-v2-videresending.yml).
 *
 * Siden erstatter v2-appen på gentle-dune etter cutover. To ting må holde:
 *
 *   - Stien og spørrestrengen følger med. En lenke til
 *     gentle-dune/visning.html?id=5 skal havne på www/visning.html?id=5,
 *     ikke på forsiden.
 *   - Den havner aldri på v3-prod. Gjør den det, sender produksjonen alt til
 *     seg selv i ring. Workflowen beviser derfor at tokenet tilhører
 *     gentle-dune, i et preview-miljø, FØR produksjonsmiljøet røres.
 *
 * Kjøres med:  node frontend/test/videresending-v2.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');

// ---------- siden ----------
const side = les('videresending-v2', 'index.html');
const skript = /<script>([\s\S]*?)<\/script>/.exec(side)?.[1] || '';
const til = (pathname, search = '', hash = '') => {
    let mål = null;
    const window = { location: { pathname, search, hash, replace: (u) => { mål = u; } } };
    new Function('window', skript)(window);
    return mål;
};
sjekk('forsiden går til www', til('/'), 'https://www.fskjema.no/');
sjekk('sti og spørrestreng følger med', til('/visning.html', '?id=5', '#beslutning'),
    'https://www.fskjema.no/visning.html?id=5#beslutning');
sjekk('utsendingslenke følger med', til('/index.html', '?utsending=abc.def'),
    'https://www.fskjema.no/index.html?utsending=abc.def');
sjekk('uten skript: meta refresh til www', /http-equiv="refresh" content="\d+; url=https:\/\/www\.fskjema\.no\/"/.test(side), true);
sjekk('og en lenke å trykke på', /<a href="https:\/\/www\.fskjema\.no\/">/.test(side), true);

// ---------- konfigurasjonen ----------
const konfig = JSON.parse(les('videresending-v2', 'staticwebapp.config.json'));
sjekk('alle stier serveres av siden', konfig.navigationFallback?.rewrite, '/index.html');
sjekk('og en 404 også', konfig.responseOverrides?.['404']?.rewrite, '/index.html');
sjekk('ingen innlogging kreves', [konfig.auth, konfig.routes], [undefined, undefined]);
sjekk('mappa har bare de to filene', fs.readdirSync(path.join(rot, 'videresending-v2')).sort(),
    ['index.html', 'staticwebapp.config.json']);

// ---------- workflowen ----------
const wf = les('.github', 'workflows', 'deploy-v2-videresending.yml');
const steg = wf.split(/\n\s+- (?:name|uses): /);
const indeks = (re) => steg.findIndex(s => re.test(s));
const preview = indeks(/deployment_environment: maalsjekk/);
const vakt = indeks(/Sjekk at tokenet tilhører gentle-dune/);
const produksjon = steg.findIndex((s, i) => i > vakt && /static-web-apps-deploy/.test(s) && !/deployment_environment/.test(s));
sjekk('preview før vakten, vakten før produksjonen', preview > -1 && vakt > preview && produksjon > vakt, true);
sjekk('vakten feiler på et annet vertsnavn', /\*\)\s*\n\s*echo "::error::Tokenet tilhører IKKE v2-prod[\s\S]*?exit 1/.test(wf), true);
sjekk('vakten feiler når Azure ikke gir adresse', /""\)\s*\n\s*echo "::error::Azure ga ingen preview-adresse[\s\S]*?exit 1/.test(wf), true);
sjekk('tokenet sammenlignes med v3-prod sitt', /"\$V2_TOKEN" = "\$V3_TOKEN"/.test(wf), true);
sjekk('v2-tokenet, ikke v3', (wf.match(/azure_static_web_apps_api_token: \$\{\{ secrets\.(\w+) \}\}/g) || [])
    .every(l => l.endsWith('AZURE_STATIC_WEB_APPS_API_TOKEN_PROD }}')), true);
sjekk('begge opplastingene tar videresending-v2', (wf.match(/app_location: "\.\/videresending-v2"/g) || []).length, 2);
sjekk('ingen Managed Functions', (wf.match(/api_location: ""/g) || []).length, 2);
sjekk('krever godkjenning som prod', /environment: prod\b/.test(wf), true);
const v2Vert = /V2_VERT: (\S+)/.exec(wf)?.[1];
sjekk('vertsnavnet er gentle-dune', v2Vert, 'gentle-dune-00a313603');
sjekk('vertsnavnet stemmer med kokeboka', les('docs', 'KOKEBOK-PROD-V3.md').includes(`https://${v2Vert}.`), true);

// Den vanlige deployen skal aldri ta med videresendingen.
sjekk('deploy-prod.yml rører ikke videresending-v2', /videresending-v2/.test(les('.github', 'workflows', 'deploy-prod.yml')), false);

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
