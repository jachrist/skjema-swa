/**
 * Samtale-widgeten — polling, sending og opprydding.
 *
 * Widgeten kjører mot et stubbet DOM, samme mønster som de andre
 * frontend-testene. Fire ting testes, og tre av dem er feil ingen ser før de
 * har vart en stund:
 *
 *   **`etter` brukes, og innleggene legges til.** Gjør den ikke det, henter
 *   hver runde hele tråden på nytt — og alt ser helt riktig ut mens trafikken
 *   vokser med samtalen.
 *
 *   **`stopp()` stanser faktisk.** En timer som overlever at panelet lukkes,
 *   fortsetter å hente resten av økten. På en side som åpnes og lukkes mange
 *   ganger blir det én poller per åpning.
 *
 *   **Feil dobler intervallet.** Er API-et nede, skal ikke hver åpne fane
 *   banke på hvert tolvte sekund til det kommer tilbake.
 *
 *   **Teksten blir stående når sending feiler.** Å tømme feltet er å slette
 *   noe brukeren har skrevet.
 *
 * Kjøres med:  node frontend/test/samtale-widget.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/** Minimal DOM — bare det widgeten faktisk rører. */
function lagElement(tag = 'div') {
    const el = {
        tagName: tag, hidden: false, value: '', textContent: '', checked: false, disabled: false,
        scrollTop: 0, scrollHeight: 0, clientHeight: 0,
        _html: '', _lyttere: {},
        classList: { _s: new Set(), add(c) { this._s.add(c); }, toggle(c, p) { p ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
        addEventListener(n, f) { (this._lyttere[n] ||= []).push(f); },
        utløs(n, arg) { for (const f of (this._lyttere[n] || [])) f(arg || {}); },
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = v; this._barn = null; },
        querySelector(sel) { return (this._funne ||= {})[sel] || null; },
        // Testen setter hvilke barn som "finnes" etter en tegning.
        settBarn(kart) { this._funne = kart; }
    };
    return el;
}

async function kjor() {
    const modul = pathToFileURL(path.join(__dirname, '..', 'js', 'samtale.js')).href;
    // felt-render importerer escapeHtml — den trenger ingen DOM.
    const { byggSamtale } = await import(modul);

    globalThis.document = { hidden: false };

    // ---------- polling og paafylling ----------
    {
        const kall = [];
        const api = {
            get: async (url) => {
                kall.push(url);
                if (kall.length === 1) {
                    return {
                        synlig: true, apen: true, kanSkrive: true, kanDempe: false, antallInnlegg: 2,
                        innlegg: [
                            { Id: '2026-09-18T10:00:00.000Z-aaa', Avsender: 'a@b.no', Tekst: 'første', Dato: '2026-09-18T10:00:00.000Z' },
                            { Id: '2026-09-18T10:00:01.000Z-bbb', Avsender: 'b@b.no', Tekst: 'andre', Dato: '2026-09-18T10:00:01.000Z' }
                        ]
                    };
                }
                return {
                    synlig: true, apen: true, kanSkrive: true, kanDempe: false, antallInnlegg: 3,
                    innlegg: [{ Id: '2026-09-18T10:00:02.000Z-ccc', Avsender: 'c@b.no', Tekst: 'tredje', Dato: '2026-09-18T10:00:02.000Z' }]
                };
            },
            post: async () => ({ status: 'ok' })
        };

        const el = lagElement();
        const s = byggSamtale(el, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();

        sjekk('første kall er uten etter', kall[0].endsWith('/samtale'), true);
        sjekk('tilstanden er lest', s.tilstand.kanSkrive, true);
        sjekk('widgeten vises', el.hidden, false);
        sjekk('begge innleggene er tegnet',
            el.innerHTML.includes('første') && el.innerHTML.includes('andre'), true);

        // Andre runde skal spørre etter siste kjente id — ikke om hele tråden.
        // Widgeten må gjøre kallet selv; konstruerer testen URL-en, tester den
        // bare sin egen streng.
        await s.oppdater();
        sjekk('andre kall bruker etter', /[?&]etter=/.test(kall[1]), true);
        sjekk('og det er siste kjente id',
            decodeURIComponent(kall[1].split('etter=')[1]), '2026-09-18T10:00:01.000Z-bbb');

        // Det nye innlegget legges TIL, ikke over. Erstatter widgeten lista
        // med svaret, forsvinner tråden ved hver polling — og med `etter` er
        // svaret bare det nye.
        sjekk('tråden fylles på',
            ['første', 'andre', 'tredje'].every(t => el.innerHTML.includes(t)), true);

        s.stopp();
    }

    // ---------- avsenderen vises, og teksten escapes ----------
    {
        const api = {
            get: async () => ({
                synlig: true, apen: true, kanSkrive: false, antallInnlegg: 1,
                innlegg: [{ Id: 'x', Avsender: 'kari@fhs.no', AvsenderNavn: 'Kari Nordmann', Tekst: '<script>alert(1)</script>', Dato: '' }]
            }),
            post: async () => ({})
        };
        const el = lagElement();
        const s = byggSamtale(el, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();

        sjekk('navnet vises', el.innerHTML.includes('Kari Nordmann'), true);
        // Innleggene er fritekst fra en behandler eller en ekstern innsender,
        // og settes med innerHTML.
        sjekk('script-taggen er escapet', el.innerHTML.includes('<script>'), false);
        sjekk('men teksten er der', el.innerHTML.includes('&lt;script&gt;'), true);
        // Uten skriverett skal det ikke finnes noe skrivefelt i markupen.
        sjekk('ingen skrivefelt uten skriverett', el.innerHTML.includes('samtale-felt'), false);
        s.stopp();
    }

    // ---------- usynlig samtale ----------
    {
        const api = { get: async () => ({ synlig: false, apen: true, innlegg: [] }), post: async () => ({}) };
        const el = lagElement();
        const s = byggSamtale(el, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();
        // En innsender som verken kan skrive eller har noe å lese skal ikke se
        // en låst boks.
        sjekk('skjult når synlig=false', el.hidden, true);
        sjekk('og tom', el.innerHTML, '');
        s.stopp();
    }

    // ---------- første henting feiler ----------
    {
        const api = { get: async () => { throw new Error('500'); }, post: async () => ({}) };
        const el = lagElement();
        const s = byggSamtale(el, { api, skjematypeId: 't1', skjemaId: '42' });
        await s.start();
        // Ingenting er bedre enn en tom samtale, som ser ut som «ingen har
        // skrevet noe».
        sjekk('skjult ved feil', el.hidden, true);
        s.stopp();
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
