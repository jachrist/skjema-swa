/**
 * Sertifikat-legitimasjon mot Entra — og at hemmelighetsveien er uendret.
 *
 * Et sertifikat sendes ikke som en hemmelighet. Entra vil ha en
 * `client_assertion`: en JWT signert med privatnøkkelen, der `x5t` er
 * SHA-1-avtrykket av sertifikatet, slik at Entra vet hvilken offentlig nøkkel
 * den skal verifisere mot.
 *
 * **Den viktigste sjekken her er at ingenting endret seg.** Backupen i prod
 * og pilot går på client secret. Er `GRAPH_CLIENT_CERT_PEM` ikke satt, skal
 * kroppen i token-kallet være nøyaktig den samme som før sertifikatstøtten
 * kom — parameter for parameter.
 *
 * **PEM, ikke PKCS#12.** Målt 19.10.2026 på Node 22.22: `createPrivateKey`
 * avviser PFX i alle former (`ERR_OSSL_UNSUPPORTED`). Key Vault leverer PFX
 * når sertifikatet er importert med innholdstype `application/x-pkcs12`, og da
 * finnes det ingen vei videre — det skal sies tydelig, ikke feile som en
 * signaturfeil langt unna årsaken.
 *
 * Sertifikatet i testen lages med openssl ved kjøring. Et ekte nøkkelpar i
 * repoet ville vært et funn for enhver hemmelighetsskanner, og en skanner med
 * falske positiver er en skanner folk slutter å lese.
 *
 * Kjøres med:  node api/test/graph-sertifikat.test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const graph = require('../src/lib/graph-opplast.js');
const BASIS = { tenantId: 'tenant-1', clientId: 'klient-1', site: 'fhs.sharepoint.com:/sites/X' };

// ---------- 1. hemmelighetsveien er uendret ----------
//
// Dette er garantien prod hviler på. Settes ikke den nye variabelen, skal
// kallet se ut nøyaktig som før.
{
    const p = graph.tokenKropp({ ...BASIS, clientSecret: 'hemmelig' });
    sjekk('kroppen bærer nøyaktig de fire gamle parameterne',
        [...p.keys()].sort(),
        ['client_id', 'client_secret', 'grant_type', 'scope']);
    sjekk('client_secret er verdien', p.get('client_secret'), 'hemmelig');
    sjekk('scope er uendret', p.get('scope'), 'https://graph.microsoft.com/.default');
    sjekk('grant_type er uendret', p.get('grant_type'), 'client_credentials');
    sjekk('ingen assertion snek seg inn', p.get('client_assertion'), null);
    sjekk('heller ikke assertion-typen', p.get('client_assertion_type'), null);
}

// ---------- 2. hemmeligheten vinner når begge er satt ----------
//
// Et halvferdig sertifikatoppsett skal ikke kunne ta ned en backup som
// virker. Rekkefølgen er en beslutning, ikke en tilfeldighet.
{
    let p = null, kastet = null;
    try { p = graph.tokenKropp({ ...BASIS, clientSecret: 'hemmelig', clientCertPem: 'noe-rot' }); }
    catch (e) { kastet = e.message; }
    sjekk('kallet går igjennom når hemmeligheten er satt', kastet, null);
    sjekk('hemmeligheten vinner', p && p.get('client_secret'), 'hemmelig');
    sjekk('og sertifikatet røres ikke', p && p.get('client_assertion'), null);
}

// ---------- 3. konfigurasjonen godtar én av to ----------
{
    sjekk('bare hemmelighet holder', graph.erKonfigurert({ ...BASIS, clientSecret: 'x' }), true);
    sjekk('bare sertifikat holder', graph.erKonfigurert({ ...BASIS, clientCertPem: 'y' }), true);
    sjekk('ingen av delene holder ikke', graph.erKonfigurert(BASIS), false);

    // Kontrakten utad er uendret — `manglerKonfig({})` melder de samme fire
    // navnene som før. `env-inventar.test.js` leser den lista.
    sjekk('manglerKonfig er uendret for tom konfig', graph.manglerKonfig({}),
        ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'BACKUP_SHAREPOINT_SITE']);
    sjekk('og melder ingenting når sertifikatet dekker legitimasjonen',
        graph.manglerKonfig({ ...BASIS, clientCertPem: 'y' }), []);
}

// ---------- 4. feil format sier hva som er galt ----------
{
    const kast = (k) => {
        try { graph.tokenKropp(k); return null; } catch (e) { return e.message; }
    };

    // Base64-PFX fra Key Vault, slik den faktisk ser ut.
    const pfx = kast({ ...BASIS, clientCertPem: 'MIIKxQIBAzCCCn8GCSqGSIb3DQEHAaCCCnAEggps' });
    sjekk('PFX avvises', pfx !== null, true);
    sjekk('og meldingen nevner PKCS#12', /PKCS#12/.test(pfx || ''), true);
    sjekk('og sier hva som skal gjøres i stedet',
        /application\/x-pem-file/.test(pfx || ''), true);

    // PEM med nøkkel, men uten sertifikatet: da finnes det ingen x5t.
    const utenCert = kast({ ...BASIS, clientCertPem: '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----' });
    sjekk('PEM uten sertifikat avvises', utenCert !== null, true);
    sjekk('og meldingen nevner avtrykket', /x5t/.test(utenCert || ''), true);
}

// ---------- 5. den ekte signaturen ----------
//
// Et sertifikat som openssl lager, en JWT koden signerer, og en verifikasjon
// mot sertifikatets egen offentlige nøkkel — altså det Entra gjør.
{
    let pem = null;
    const mappe = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-cert-'));
    try {
        const k = path.join(mappe, 'k.pem'), c = path.join(mappe, 'c.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', k,
            '-out', c, '-days', '1', '-nodes', '-subj', '/CN=test'], { stdio: 'ignore' });
        pem = fs.readFileSync(k, 'utf8') + fs.readFileSync(c, 'utf8');
    } catch (e) {
        // Ikke hopp stille over. Uten denne sjekken er signaturveien uprøvd,
        // og det er den eneste delen som ikke kan feilsøkes fra en logg.
        feil++;
        console.log('FEIL  kunne ikke lage testsertifikat — openssl kreves for denne sjekken\n'
            + `      ${String(e.message || e).slice(0, 120)}`);
    } finally {
        fs.rmSync(mappe, { recursive: true, force: true });
    }

    if (pem) {
        const p = graph.tokenKropp({ ...BASIS, clientCertPem: pem });

        sjekk('kroppen bærer assertion-typen', p.get('client_assertion_type'),
            'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
        sjekk('og ingen client_secret', p.get('client_secret'), null);

        const jwt = p.get('client_assertion') || '';
        const deler = jwt.split('.');
        sjekk('assertionen har tre deler', deler.length, 3);

        const lesDel = (i) => JSON.parse(Buffer.from(deler[i], 'base64url').toString('utf8'));
        const hode = lesDel(0), krav = lesDel(1);

        sjekk('alg er RS256', hode.alg, 'RS256');
        sjekk('typ er JWT', hode.typ, 'JWT');

        const sertifikat = new crypto.X509Certificate(pem);
        const avtrykk = crypto.createHash('sha1').update(sertifikat.raw).digest('base64url');
        sjekk('x5t er sertifikatets SHA-1-avtrykk', hode.x5t, avtrykk);

        sjekk('aud er tenantens token-endepunkt', krav.aud,
            'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
        sjekk('iss og sub er klient-ID-en', [krav.iss, krav.sub], ['klient-1', 'klient-1']);
        sjekk('jti er satt', typeof krav.jti === 'string' && krav.jti.length > 10, true);
        sjekk('exp ligger etter nbf', krav.exp > krav.nbf, true);
        sjekk('og levetiden er ti minutter', krav.exp - krav.nbf, 600);

        // Det avgjørende: Entra verifiserer signaturen mot den offentlige
        // nøkkelen i sertifikatet. Gjør ikke vi det her, er alt over bare form.
        const v = crypto.createVerify('RSA-SHA256').update(`${deler[0]}.${deler[1]}`);
        sjekk('signaturen verifiserer mot sertifikatets offentlige nøkkel',
            v.verify(sertifikat.publicKey, Buffer.from(deler[2], 'base64url')), true);

        // To kall skal ikke gi samme jti — en gjenbrukt jti kan avvises.
        const annen = graph.tokenKropp({ ...BASIS, clientCertPem: pem }).get('client_assertion');
        sjekk('ny assertion får ny jti',
            lesDel(1).jti !== JSON.parse(Buffer.from(annen.split('.')[1], 'base64url').toString()).jti, true);
    }
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
