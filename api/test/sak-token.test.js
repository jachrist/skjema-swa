/**
 * Sak-lenka til en ekstern innsender — tokenet, sjekken og lenkene.
 *
 * Meldt 04.11.2026: eksterne fikk lenker i kvittering, beslutningsvarsel og
 * samtalevarsel som krevde innlogging. De har ingen konto. Lenkene bærer nå
 * et sak-token (lib/sak-token.js), og testene under passer på det som kan gå
 * galt med det:
 *
 *   - et token som åpner en ANNEN sak, eller for en annen innsender
 *   - et OTP- eller utsendingstoken som godtas som sak-token, eller omvendt —
 *     de tre deler nøkkel
 *   - kopimottakere på kvitteringen som får innsenderens token
 *   - innloggede innsendere som får token de ikke trenger
 *   - frontend og backend som kaller parameteren eller headeren noe ulikt
 *   - en rute som tar imot headeren uten å sjekke den mot saken
 *
 * Varslingen kjøres EKTE, med fetch fanget; lenkene leses ut av payloaden.
 *
 * Kjøres med:  node api/test/sak-token.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

process.env.OTP_HMAC_KEY = 'k'.repeat(40);
process.env.SWA_URL = 'https://www.fskjema.no';

const sakToken = require('../src/lib/sak-token');
const otpToken = require('../src/lib/otp-token');
const utsendingToken = require('../src/lib/utsending-token');
const ekstern = require('../src/lib/ekstern-auth');
const varsling = require('../src/lib/varsling');
const rollerStorage = require('../src/lib/roller-storage');

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');
const req = (headere = {}) => ({ headers: { get: (n) => headere[n.toLowerCase()] ?? null } });

const SAK = { Skjematype_id: '45', Skjema_id: '10', Innsender_Epost: 'ola@example.no', EksternInnsender: true };

// ---------- 1. tokenet ----------
{
    const t = sakToken.utsted({ skjematypeId: '45', skjemaId: '10', mottaker: ' Ola@Example.no ' });
    const v = sakToken.valider(t);
    sjekk('gyldig', v.gyldig, true);
    sjekk('bundet til saken', [v.skjematypeId, v.skjemaId], ['45', '10']);
    sjekk('adressen normalisert', v.mottaker, 'ola@example.no');

    const [p, sig] = t.split('.');
    const endret = Buffer.from(JSON.stringify({ typ: 'sak', st: '45', sid: '11', m: 'ola@example.no', exp: Date.now() + 1e9 }))
        .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    sjekk('annen sak med gammel signatur avvises', sakToken.valider(`${endret}.${sig}`).gyldig, false);
    sjekk('tom signatur avvises', sakToken.valider(`${p}.`).gyldig, false);
    sjekk('utløpt avvises', sakToken.valider(sakToken.utsted({ skjematypeId: '45', skjemaId: '10', mottaker: 'a@b.no', dagerGyldig: -1 })).gyldig, false);
    sjekk('uten sak kan ikke utstedes', (() => { try { sakToken.utsted({ skjematypeId: '45', mottaker: 'a@b.no' }); return 'utstedt'; } catch { return 'kastet'; } })(), 'kastet');
}

// ---------- 2. tre tokentyper, én nøkkel: ingen kan stå for en annen ----------
{
    const otp = otpToken.utstedToken('epost', 'ola@example.no');
    const uts = utsendingToken.utsted({ batchId: 'b1', mottaker: 'ola@example.no', skjematypeId: '45' });
    const sak = sakToken.utsted({ skjematypeId: '45', skjemaId: '10', mottaker: 'ola@example.no' });
    sjekk('OTP-token er ikke et sak-token', sakToken.valider(otp).gyldig, false);
    sjekk('utsendingstoken er ikke et sak-token', sakToken.valider(uts).gyldig, false);
    sjekk('sak-token er ikke et OTP-token', otpToken.valider(sak).gyldig, false);
    sjekk('sak-token er ikke et utsendingstoken', utsendingToken.valider(sak).gyldig, false);
}

// ---------- 3. autentiserSak: tokenet OG saken ----------
{
    const t = sakToken.utsted({ skjematypeId: '45', skjemaId: '10', mottaker: 'ola@example.no' });
    const r = req({ 'x-sak-token': t });
    sjekk('egen sak slipper inn', ekstern.autentiserSak(r, '45', '10', SAK), { ok: true, mottaker: 'ola@example.no' });
    sjekk('annen sak avvises', ekstern.autentiserSak(r, '45', '11', { ...SAK, Skjema_id: '11' }).ok, false);
    sjekk('annen skjematype avvises', ekstern.autentiserSak(r, '46', '10', SAK).ok, false);
    sjekk('ny innsender på saken avvises', ekstern.autentiserSak(r, '45', '10', { ...SAK, Innsender_Epost: 'kari@example.no' }).ok, false);
    sjekk('sak som ikke finnes avvises', ekstern.autentiserSak(r, '45', '10', null).ok, false);
    sjekk('uten token avvises', ekstern.autentiserSak(req(), '45', '10', SAK).ok, false);
}

// ---------- 4. rekkefølgen mellom veiene ----------
{
    sjekk('utsending først', ekstern.velgAuthvei(req({ 'x-utsending-token': 'x', 'x-sak-token': 'y' }), 'a@b'), 'utsending');
    sjekk('sak foran OTP', ekstern.velgAuthvei(req({ 'x-sak-token': 'y', 'x-otp-token': 'z' }), null), 'sak');
    sjekk('sak foran cookie', ekstern.velgAuthvei(req({ 'x-sak-token': 'y' }), 'a@b'), 'sak');
    sjekk('ekstern innsender: OTP', ekstern.erEksternInnsender({ EksternInnsender: true }), true);
    sjekk('ekstern innsender: utsending', ekstern.erEksternInnsender({ Utsending_BatchId: 'b1' }), true);
    sjekk('innlogget innsender er ikke ekstern', ekstern.erEksternInnsender({ Innsender_Epost: 'a@b' }), false);
}

// ---------- 5. lenkene i varslene ----------
/** Kjør `fn` med fanget fetch; returnerer payloadene flyten ville fått. */
async function fang(fn) {
    const forrige = { fetch: global.fetch, url: process.env.VARSLING_FLOW_URL, av: process.env.VARSLING_DEAKTIVERT, hent: rollerStorage.hentInnehavere };
    const fanget = [];
    process.env.VARSLING_FLOW_URL = 'https://eksempel.invalid/flyt';
    delete process.env.VARSLING_DEAKTIVERT;
    rollerStorage.hentInnehavere = async () => [];
    global.fetch = async (_u, o) => { fanget.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
    try { await fn(); }
    catch (e) { console.log(`      (kastet: ${e.message})`); }
    finally {
        global.fetch = forrige.fetch;
        rollerStorage.hentInnehavere = forrige.hent;
        if (forrige.url === undefined) delete process.env.VARSLING_FLOW_URL; else process.env.VARSLING_FLOW_URL = forrige.url;
        if (forrige.av !== undefined) process.env.VARSLING_DEAKTIVERT = forrige.av;
    }
    return fanget;
}
/** Tokenet i en lenke, validert — eller null. */
function tokenI(url) {
    if (!url) return null;
    const t = new URL(url).searchParams.get('t');
    return t ? sakToken.valider(t) : null;
}

(async () => {
    const ST = { Skjematype_id: '45', Skjematype_navn: 'Søknad',
        Innsenderkvittering: { Aktiv: true, Emne: 'Kvittering', Tekst: 'Takk. $lenke',
            Kopi: { Personer: ['leder@jccodevel.onmicrosoft.com'] } } };

    // Kvittering, ekstern innsender med kopi: to e-poster.
    {
        const p = await fang(() => varsling.sendInnsenderKvittering({ ...SAK, Seksjoner: [] }, ST));
        sjekk('ekstern + kopi gir to e-poster', p.length, 2);
        const tilInnsender = p.find(x => x.mottakere[0]?.epost === 'ola@example.no');
        const tilKopi = p.find(x => x.mottakere[0]?.epost === 'leder@jccodevel.onmicrosoft.com');
        sjekk('innsenderen står alene', tilInnsender?.mottakere.length, 1);
        // Valgfri kjeding hele veien: mangler e-posten, skal det bli én rød
        // linje, ikke et kast som tar resten av fila med seg.
        const v = tokenI(tilInnsender?.lenker?.[0]?.url);
        sjekk('innsenderens lenke har token for saken', v && [v.gyldig, v.skjemaId, v.mottaker], [true, '10', 'ola@example.no']);
        sjekk('lenka går til visningen', tilInnsender && new URL(tilInnsender.lenker[0].url).pathname, '/visning.html');
        sjekk('lenka står i teksten også', !!tilInnsender?.epost_og_teams?.html?.includes('t='), true);
        // Over ALLE e-postene: ingen som når kopimottakeren, bærer tokenet.
        sjekk('kopimottakeren får e-post', !!tilKopi, true);
        sjekk('kopimottakeren får ikke tokenet',
            p.filter(x => JSON.stringify(x.mottakere).includes('leder@')).some(x => JSON.stringify(x.lenker).includes('t=')), false);
        sjekk('lenka bruker SWA_URL', !!tilInnsender?.lenker?.[0]?.url?.startsWith('https://www.fskjema.no/'), true);
    }

    // Kvittering, innlogget innsender: én e-post, ingen token.
    {
        const p = await fang(() => varsling.sendInnsenderKvittering(
            { Skjematype_id: '45', Skjema_id: '10', Innsender_Epost: 'ansatt@jccodevel.onmicrosoft.com', Seksjoner: [] }, ST));
        sjekk('innlogget: én e-post', p.length, 1);
        sjekk('innlogget: ingen token', JSON.stringify(p).includes('t='), false);
    }

    // Beslutning: ompuss lenker til utfyllingen, annet til visningen — begge med token.
    {
        const steg = { Steg: 1, Stegnavn: 'Vurdering', Beslutningsvalg: [
            { Nummer: 1, Tekst: 'Godkjent' }, { Nummer: 2, Tekst: 'Fikses', Handling: 'ompuss' }] };
        const [godkjent] = await fang(() => varsling.sendBeslutningVarsling(SAK, ST, steg, 1, 'Godkjent', ''));
        const [ompuss] = await fang(() => varsling.sendBeslutningVarsling(SAK, ST, steg, 2, 'Fikses', ''));
        sjekk('beslutning: visning med token', [new URL(godkjent.lenker[0].url).pathname, tokenI(godkjent.lenker[0].url)?.gyldig], ['/visning.html', true]);
        sjekk('ompuss: utfylling med token', [new URL(ompuss.lenker[0].url).pathname, tokenI(ompuss.lenker[0].url)?.gyldig], ['/index.html', true]);
    }

    // Samtale: innsenderens lenke har token, behandlernes ikke.
    {
        const samtaleStorage = require('../src/lib/samtale-storage');
        const forrige = samtaleStorage.erDempet;
        samtaleStorage.erDempet = async () => false;
        const sak = { ...SAK, Behandling: [{ Steg: 1, Personer: ['beh@jccodevel.onmicrosoft.com'], Roller: [], Team: [], Beslutning: 0 }] };
        const p = await fang(() => varsling.sendSamtaleVarsling(sak, ST, { Avsender: 'annen@jccodevel.onmicrosoft.com' }));
        samtaleStorage.erDempet = forrige;
        const tilInnsender = p.find(x => x.mottakere.some(m => m.epost === 'ola@example.no'));
        const tilBehandler = p.find(x => x.mottakere.some(m => m.epost === 'beh@jccodevel.onmicrosoft.com'));
        const url = tilInnsender && new URL(tilInnsender.lenker[0].url);
        sjekk('samtale: innsender til kvitteringen med token', url && [url.pathname, url.hash, tokenI(url.href)?.gyldig], ['/kvittering.html', '#samtale', true]);
        sjekk('samtale: behandler uten token', tilBehandler && new URL(tilBehandler.lenker[0].url).searchParams.has('t'), false);
    }

    // ---------- 6. samme navn på begge sider ----------
    {
        const fe = les('frontend', 'js', 'sak-lenke.js');
        const param = /export const SAK_PARAM = '([^']+)'/.exec(fe)?.[1];
        const header = /export const SAK_HEADER = '([^']+)'/.exec(fe)?.[1];
        sjekk('frontend: parameter', param, 't');
        sjekk('backend leser samme header', les('api', 'src', 'lib', 'ekstern-auth.js').includes(`get?.('${header}')`), true);
        sjekk('varslingen skriver samme parameter', les('api', 'src', 'lib', 'varsling.js').includes(`&${param}=\${encodeURIComponent(t)}`), true);

        // medSakToken, kjørt: ankeret (#samtale) skal stå sist.
        const kode = fe.replace(/^export /gm, '');
        const { medSakToken } = new Function(`${kode}; return { medSakToken };`)();
        sjekk('token før anker', medSakToken('/kvittering.html?a=1#samtale', 'x y'), '/kvittering.html?a=1&t=x%20y#samtale');
        sjekk('uten token uendret', medSakToken('/visning.html?a=1', ''), '/visning.html?a=1');

        for (const side of ['visning.html', 'kvittering.html', 'index.html']) {
            sjekk(`${side} bruker sak-lenka`, /brukSakToken\(api, params\)/.test(les('frontend', side)), true);
        }
        sjekk('visning: ingen innlogging med token', /if \(!bruker && !sakT\)/.test(les('frontend', 'visning.html')), true);
    }

    // ---------- 7. hver rute som tar imot headeren, sjekker den mot saken ----------
    {
        const ruter = {
            'skjemaer.js': les('api', 'src', 'functions', 'skjemaer.js'),
            'samtale.js': les('api', 'src', 'functions', 'samtale.js'),
            'pdf.js': les('api', 'src', 'functions', 'pdf.js')
        };
        for (const [fil, kilde] of Object.entries(ruter)) {
            const veier = (kilde.match(/=== 'sak'/g) || []).length;
            const sjekker = (kilde.match(/autentiserSak\(request/g) || []).length;
            sjekk(`${fil}: hver sak-vei kaller autentiserSak`, veier > 0 && veier === sjekker, true);
        }
        // Lagringen gir en ekstern et token til kvitteringen — bare ved
        // innsending, for saken som ble lagret, og feltet står alltid.
        sjekk('lagringen svarer med SakToken', /SakToken: sakTokenSvar/.test(ruter['skjemaer.js']), true);
        sjekk('bare for eksterne, og bare ved innsending',
            /if \(\(eksternAuth \|\| utsendingAuth \|\| sakAuth\) && Number\(skjemaData\.Skjema_status\) >= 2\)/.test(ruter['skjemaer.js']), true);
        sjekk('utstedt for innsenderen som ble lagret',
            /sakToken\.utsted\(\{ skjematypeId, skjemaId, mottaker: skjemaData\.Innsender_Epost \}\)/.test(ruter['skjemaer.js']), true);
        sjekk('index.html tar det med til kvitteringen', /resp\.SakToken \|\| sakT/.test(les('frontend', 'index.html')), true);

        // Lagring med token: bare retting av en sak sendt tilbake.
        sjekk('lagring krever status «til revidering»',
            /autentiserSak\(request, skjematypeId, id, lagret\)[\s\S]{0,600}Skjema_status\) !== STATUS_SENDT_TILBAKE/.test(ruter['skjemaer.js']), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => { console.log('FEIL  testen kastet:', e.message, e.stack); process.exit(1); });
