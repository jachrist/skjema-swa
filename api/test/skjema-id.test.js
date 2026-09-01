/**
 * Tester for tildeling av Skjema_id.
 *
 * Bakgrunn: `lagreSkjema` bruker upsert. Deles det ut en ID som allerede
 * finnes, skrives det eksisterende skjemaet over i stillhet — ingen feilmelding,
 * bare et skjema med nye svar og gammel innsender. Det skjedde på dev-tenanten
 * 01.09.2026 etter at produksjonsdata var kopiert inn uten at Teller fulgte med.
 *
 * Derfor er det ikke nok å teste at telleren teller. Det som må holde er at en
 * opptatt ID ALDRI deles ut, uansett hva telleren står på.
 *
 * Kjøres med:  node api/test/skjema-id.test.js
 */
const storage = require('../src/lib/storage');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/** Teller-tabell i minnet, med ETag slik den ekte har. */
function fakeTeller(start = null) {
    const rader = new Map();
    if (start !== null) rader.set('120', { Nummer: start, etag: 'e0' });
    let etagNr = 0;
    return {
        rader,
        async getEntity(pk, rk) {
            const r = rader.get(rk);
            if (!r) { const e = new Error('not found'); e.statusCode = 404; throw e; }
            return { partitionKey: pk, rowKey: rk, ...r };
        },
        async createEntity(e) {
            if (rader.has(e.rowKey)) { const f = new Error('conflict'); f.statusCode = 409; throw f; }
            rader.set(e.rowKey, { Nummer: e.Nummer, etag: `e${++etagNr}` });
        },
        async updateEntity(e, _modus, opts) {
            const r = rader.get(e.rowKey);
            if (opts?.etag && r.etag !== opts.etag) { const f = new Error('precondition'); f.statusCode = 412; throw f; }
            rader.set(e.rowKey, { Nummer: e.Nummer, etag: `e${++etagNr}` });
        },
        async upsertEntity(e) { rader.set(e.rowKey, { Nummer: e.Nummer, etag: `e${++etagNr}` }); }
    };
}

async function medTeller(teller, fn) {
    const orig = storage.sikreTabell;
    storage.sikreTabell = async () => teller;
    try { return await fn(); }
    finally { storage.sikreTabell = orig; }
}

// Lastes etter at stubben er på plass i hver test, siden modulen henter
// sikreTabell via modulobjektet.
const { genererSkjemaId } = require('../src/lib/skjema-id');

const ingenOpptatt = { idErOpptatt: async () => false };

async function kjor() {
    // ---------- normal telling ----------
    {
        const t = fakeTeller(null);
        const forste = await medTeller(t, () => genererSkjemaId('120', ingenOpptatt));
        sjekk('første skjema får 1', forste, '1');
        const andre = await medTeller(t, () => genererSkjemaId('120', ingenOpptatt));
        sjekk('neste får 2', andre, '2');
        sjekk('telleren står på 2', t.rader.get('120').Nummer, 2);
    }

    // ---------- eksisterende teller ----------
    {
        const t = fakeTeller(41);
        const id = await medTeller(t, () => genererSkjemaId('120', ingenOpptatt));
        sjekk('fortsetter fra lagret verdi', id, '42');
    }

    // ---------- kollisjon: hele poenget ----------
    {
        // Telleren står på 0, men skjema 1-20 finnes fra før — nøyaktig
        // situasjonen etter at data er kopiert inn uten Teller.
        const t = fakeTeller(0);
        const brukte = new Set(Array.from({ length: 20 }, (_, i) => String(i + 1)));
        const loggen = [];
        const id = await medTeller(t, () => genererSkjemaId('120', {
            idErOpptatt: async (_type, n) => brukte.has(String(n)),
            hoyesteBrukteId: async () => 20,
            log: (m) => loggen.push(m)
        }));

        sjekk('opptatt ID deles ikke ut', brukte.has(id), false);
        sjekk('ny ID kommer etter høyeste i bruk', id, '21');
        sjekk('telleren er reparert', t.rader.get('120').Nummer, 21);
        sjekk('og det logges hvorfor', /ute av takt/.test(loggen.join(' ')), true);
    }

    // ---------- kollisjon på ett enkelt hull ----------
    {
        // Telleren gir 5, som er tatt, men 6 er ledig. Reparasjonen skal ikke
        // hoppe lenger enn nødvendig.
        const t = fakeTeller(4);
        const brukte = new Set(['5']);
        const id = await medTeller(t, () => genererSkjemaId('120', {
            idErOpptatt: async (_type, n) => brukte.has(String(n)),
            hoyesteBrukteId: async () => 5
        }));
        sjekk('hopper bare forbi det som er tatt', id, '6');
    }

    // ---------- samtidighet ----------
    {
        // To innsendinger samtidig: den ene taper ETag-kampen og prøver igjen.
        // Ingen av dem skal få samme nummer.
        const t = fakeTeller(7);
        const ekte = t.updateEntity.bind(t);
        let forste = true;
        t.updateEntity = async (e, m, opts) => {
            if (forste) {
                forste = false;
                // Noen andre rakk å oppdatere raden imens.
                await t.upsertEntity({ rowKey: e.rowKey, Nummer: 8 });
                const f = new Error('precondition'); f.statusCode = 412; throw f;
            }
            return ekte(e, m, opts);
        };
        const id = await medTeller(t, () => genererSkjemaId('120', ingenOpptatt));
        sjekk('taper ETag-kampen og henter neste ledige', id, '9');
    }

    // ---------- gir opp i stedet for å dele ut noe farlig ----------
    {
        // Er alt opptatt uansett hva vi prøver, skal vi kaste — ikke returnere
        // en ID som ville skrevet over et eksisterende skjema.
        const t = fakeTeller(0);
        let melding = null;
        try {
            await medTeller(t, () => genererSkjemaId('120', {
                idErOpptatt: async () => true,
                hoyesteBrukteId: async () => 3
            }));
        } catch (e) { melding = e.message; }
        sjekk('kaster heller enn å dele ut opptatt ID', /Kunne ikke generere/.test(melding || ''), true);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
