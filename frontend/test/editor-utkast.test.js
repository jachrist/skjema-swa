/**
 * Tester for autolagringen i editoren.
 *
 * Koden ligger inline i frontend/editor.html, som all annen editorkode. Testen
 * klipper ut AUTOLAGRING-seksjonen og kjører den mot stubber for DOM og
 * localStorage. Det er logikken rundt utkastet som er verdt å teste — når det
 * skrives, når det tilbys tilbake, og når det ryddes bort — for en feil der
 * koster brukeren arbeidet sitt.
 *
 * Kjøres med:  node frontend/test/editor-utkast.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'editor.html');
const START = '// ==================== AUTOLAGRING OG UTKAST ====================';
const SLUTT = '// ---- Lagre / Slett / Kopier ----';

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

function hentSeksjon() {
    const html = fs.readFileSync(HTML, 'utf8');
    const i = html.indexOf(START);
    const j = html.indexOf(SLUTT, i);
    if (i < 0 || j < 0) throw new Error('Fant ikke AUTOLAGRING-seksjonen i editor.html');
    return html.slice(i, j);
}

/** Minimal DOM og localStorage — akkurat nok til at seksjonen kan kjøre. */
function lagMiljo({ eksisterendeId = null, kopiFraId = null, lager = {} } = {}) {
    const elementer = {};
    const lagElement = () => ({
        textContent: '', innerHTML: '',
        klasser: new Set(),
        classList: { toggle(k, på) { på ? this.klasser?.add(k) : this.klasser?.delete(k); } }
    });
    for (const id of ['lagre-status', 'utkast-banner']) elementer[id] = lagElement();

    const lyttere = { window: {}, document: {} };
    const toaster = [];
    // console.warn fanges opp i stedet for å skrives ut — den forventede
    // advarselen i kvote-testen skal ikke se ut som en feil i CI-loggen.
    const advarsler = [];

    const ctx = {
        data: null,
        eksisterendeId, kopiFraId,
        console: { ...console, warn: (...a) => advarsler.push(a.join(" ")) },
        Date, JSON, Math, setInterval: () => 1, clearInterval: () => {},
        sikreFeltIder: () => {},
        rendrer: () => {},
        toast: (t) => toaster.push(t),
        escapeHtml: (s) => String(s ?? ''),
        localStorage: {
            _: { ...lager },
            getItem(k) { return Object.prototype.hasOwnProperty.call(this._, k) ? this._[k] : null; },
            setItem(k, v) { this._[k] = String(v); },
            removeItem(k) { delete this._[k]; }
        },
        document: {
            getElementById: (id) => elementer[id] || null,
            addEventListener: (n, f) => { lyttere.document[n] = f; },
            visibilityState: 'visible'
        },
    };
    vm.createContext(ctx);
    // I nettleseren er window === globalThis, så window.x = … blir en global.
    // Stubben må gjøre det samme, ellers finnes ikke gjenopprettUtkast().
    ctx.globalThis = ctx;
    ctx.window = ctx;
    ctx.addEventListener = (n, f) => { lyttere.window[n] = f; };
    vm.runInContext(hentSeksjon(), ctx);
    return { ctx, elementer, lyttere, toaster, advarsler };
}

const NOKKEL_NY = 'skjematype-utkast:ny';
const NOKKEL_42 = 'skjematype-utkast:42';
const skjema = (navn) => ({ Skjema_navn: navn, Seksjoner: [] });

// ---------- nøkkelvalg ----------
{
    const nyM = lagMiljo();
    sjekk('nytt skjema bruker «ny»-nøkkelen', nyM.ctx.utkastNokkel(), NOKKEL_NY);
    const eksM = lagMiljo({ eksisterendeId: '42' });
    sjekk('eksisterende skjema bruker id-en', eksM.ctx.utkastNokkel(), NOKKEL_42);
    const kopiM = lagMiljo({ kopiFraId: '42' });
    sjekk('kopi får egen nøkkel', kopiM.ctx.utkastNokkel(), 'skjematype-utkast:kopi-42');
}

// ---------- ingen endringer ----------
{
    const { ctx, elementer } = lagMiljo({ eksisterendeId: '42' });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    sjekk('uendret skjema har ingen ulagrede endringer', ctx.harUlagredeEndringer(), false);
    sjekk('statuslinja er rolig', elementer['lagre-status'].textContent, 'Ingen endringer');
    sjekk('ingenting skrives til localStorage', ctx.lagreUtkast(), false);
    sjekk('ingen banner', elementer['utkast-banner'].innerHTML, '');
}

// ---------- endring → utkast ----------
{
    const { ctx, elementer } = lagMiljo({ eksisterendeId: '42' });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    ctx.data.Skjema_navn = 'Reiseregning 2027';
    sjekk('endring oppdages', ctx.harUlagredeEndringer(), true);
    sjekk('utkastet skrives', ctx.lagreUtkast(), true);

    const lagret = JSON.parse(ctx.localStorage.getItem(NOKKEL_42));
    sjekk('utkastet inneholder dataene', lagret.data.Skjema_navn, 'Reiseregning 2027');
    sjekk('utkastet har navn til banneret', lagret.navn, 'Reiseregning 2027');
    sjekk('statuslinja advarer', /^Ulagrede endringer — utkast tatt vare på \d{2}:\d{2}$/.test(elementer['lagre-status'].textContent), true);
}

// ---------- utkast likt serverversjonen ryddes bort ----------
{
    const identisk = JSON.stringify({ tid: new Date().toISOString(), navn: 'Reiseregning', data: skjema('Reiseregning') });
    const { ctx, elementer } = lagMiljo({ eksisterendeId: '42', lager: { [NOKKEL_42]: identisk } });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    sjekk('identisk utkast gir ingen banner', elementer['utkast-banner'].innerHTML, '');
    sjekk('identisk utkast slettes', ctx.localStorage.getItem(NOKKEL_42), null);
}

// ---------- utkast som avviker tilbys tilbake ----------
{
    const nyere = JSON.stringify({ tid: new Date().toISOString(), navn: 'Reiseregning 2027', data: skjema('Reiseregning 2027') });
    const { ctx, elementer, toaster } = lagMiljo({ eksisterendeId: '42', lager: { [NOKKEL_42]: nyere } });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    sjekk('banner vises', /Ulagret utkast funnet/.test(elementer['utkast-banner'].innerHTML), true);
    sjekk('banneret nevner navnet', /Reiseregning 2027/.test(elementer['utkast-banner'].innerHTML), true);

    ctx.gjenopprettUtkast();
    sjekk('dataene er byttet ut', ctx.data.Skjema_navn, 'Reiseregning 2027');
    sjekk('banneret forsvinner', elementer['utkast-banner'].innerHTML, '');
    // Det gjenopprettede innholdet er fortsatt ikke lagret på serveren, og må
    // fortsatt utløse både advarsel og lukkevarsel.
    sjekk('gjenopprettet innhold regnes som ulagret', ctx.harUlagredeEndringer(), true);
    sjekk('brukeren blir minnet på å lagre', toaster.length, 1);
}

// ---------- forkast ----------
{
    const nyere = JSON.stringify({ tid: new Date().toISOString(), navn: 'X', data: skjema('X') });
    const { ctx, elementer } = lagMiljo({ eksisterendeId: '42', lager: { [NOKKEL_42]: nyere } });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    ctx.forkastUtkast();
    sjekk('forkastet utkast er borte', ctx.localStorage.getItem(NOKKEL_42), null);
    sjekk('banneret er borte', elementer['utkast-banner'].innerHTML, '');
    sjekk('dataene er urørt', ctx.data.Skjema_navn, 'Reiseregning');
}

// ---------- gammelt utkast ----------
{
    const gammelt = JSON.stringify({
        tid: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        navn: 'Fjorårets', data: skjema('Fjorårets')
    });
    const { ctx, elementer } = lagMiljo({ eksisterendeId: '42', lager: { [NOKKEL_42]: gammelt } });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    sjekk('utkast eldre enn en uke tilbys ikke', elementer['utkast-banner'].innerHTML, '');
    sjekk('og ryddes bort', ctx.localStorage.getItem(NOKKEL_42), null);
}

// ---------- ødelagt utkast ----------
{
    const { ctx, elementer } = lagMiljo({ eksisterendeId: '42', lager: { [NOKKEL_42]: '{ ikke json' } });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    sjekk('ugyldig JSON i lageret velter ikke editoren', elementer['utkast-banner'].innerHTML, '');
    sjekk('utkast uten data ignoreres', ctx.hentUtkast(), null);
}

// ---------- lukkevarsel ----------
{
    const { ctx, lyttere } = lagMiljo({ eksisterendeId: '42' });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();

    let hindret = false;
    const hendelse = () => ({ preventDefault() { hindret = true; }, returnValue: null });

    let e = hendelse();
    lyttere.window.beforeunload(e);
    sjekk('ingen advarsel når alt er lagret', hindret, false);

    ctx.data.Skjema_navn = 'Endret';
    e = hendelse();
    lyttere.window.beforeunload(e);
    sjekk('advarsel ved ulagrede endringer', hindret, true);
    sjekk('utkastet skrives i samme slengen', !!ctx.localStorage.getItem(NOKKEL_42), true);

    // Bevisst navigasjon — Kopier, Slett, reload etter lagring — skal ikke spørre.
    hindret = false;
    ctx.forlatUtenAdvarsel();
    e = hendelse();
    lyttere.window.beforeunload(e);
    sjekk('bevisst navigasjon spør ikke', hindret, false);
}

// ---------- fanebytte ----------
{
    const { ctx, lyttere } = lagMiljo({ eksisterendeId: '42' });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    ctx.data.Skjema_navn = 'Endret i skjul';
    ctx.document.visibilityState = 'hidden';
    lyttere.document.visibilitychange();
    sjekk('utkast tas vare på når fanen skjules',
        JSON.parse(ctx.localStorage.getItem(NOKKEL_42)).data.Skjema_navn, 'Endret i skjul');
}

// ---------- fullt lager ----------
{
    const { ctx, elementer, advarsler } = lagMiljo({ eksisterendeId: '42' });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    ctx.data.Skjema_navn = 'Endret';
    ctx.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    sjekk('fullt lager gir false, ikke unntak', ctx.lagreUtkast(), false);
    sjekk('og brukeren får beskjed',
        elementer['lagre-status'].textContent, 'Utkast kunne ikke lagres lokalt — lagre manuelt');
    sjekk('og feilen logges', /QuotaExceededError/.test(advarsler.join(" ")), true);
}

// ---------- etter lagring til server ----------
{
    const { ctx, elementer } = lagMiljo({ eksisterendeId: '42' });
    ctx.data = skjema('Reiseregning');
    ctx.startUtkastvakt();
    ctx.data.Skjema_navn = 'Endret';
    ctx.lagreUtkast();
    // Slik lagre() rydder opp etter en vellykket POST:
    vm.runInContext('sistLagretSerialisert = serialisert(); sistServerLagring = new Date(); fjernUtkast(); oppdaterLagreStatus();', ctx);
    sjekk('ingen ulagrede endringer igjen', ctx.harUlagredeEndringer(), false);
    sjekk('utkastet er ryddet bort', ctx.localStorage.getItem(NOKKEL_42), null);
    sjekk('statuslinja viser lagringstidspunkt',
        /^Lagret \d{2}:\d{2}$/.test(elementer['lagre-status'].textContent), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
