/**
 * Samtale-tabellen — gruppechat mellom innsender og behandlere.
 *
 * Egen tabell, én rad per innlegg. Dagens `Dialog[]` ligger inne i skjemaets
 * JSON-streng og deler et budsjett på 32 000 tegn med svarene og hele
 * behandlingshistorikken. For «omfattende kommunikasjon» er ikke det en grense
 * man nærmer seg — det er en man treffer, midt i en pågående sak.
 *
 * Fire ting testes, og tre av dem er stille feil:
 *
 *   **Radnøkkelen sorterer og er unik.** Tidsstempel først gir kronologi
 *   gratis. Uten det tilfeldige suffikset ville to innlegg i samme
 *   millisekund kollidert — og med upsert hadde det ene overskrevet det andre
 *   uten en lyd.
 *
 *   **`etter` gir bare det nye.** Det er pollingen. Feiler filteret, henter
 *   klienten hele tråden hvert tiende sekund, og ingenting ser galt ut.
 *
 *   **For langt innlegg avvises av oss.** Ellers er det Table Storage som
 *   sier nei, med en HTTP-kode, etter at brukeren har skrevet ferdig.
 *
 *   **Demping feiler lukket.** Et varsel for mye er en irritasjon; et varsel
 *   for lite er en sak som blir stående fordi ingen visste at den ventet.
 *
 * Testen kjører uten `node_modules` — derfor bygger `samtale-storage` sitt
 * eget OData-filter i stedet for å bruke SDK-ens `odata`.
 *
 * Kjøres med:  node api/test/samtale-storage.test.js
 */
let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const storage = require('../src/lib/storage');
const samtale = require('../src/lib/samtale-storage');

/**
 * Tabell-stubb som faktisk tolker filteret.
 *
 * Den kunne ignorert det og returnert alt — og da ville `etter`-testen bestått
 * uansett hva filteret sa. Et filter ingen leser, er ikke testet.
 */
function stubb() {
    const tabeller = new Map();
    const hent = (navn) => {
        if (!tabeller.has(navn)) tabeller.set(navn, new Map());
        return tabeller.get(navn);
    };
    storage.sikreTabell = async (navn) => {
        const rader = hent(navn);
        const id = (e) => `${e.partitionKey}|${e.rowKey}`;
        return {
            createEntity: async (e) => {
                if (rader.has(id(e))) { const f = new Error('finnes'); f.statusCode = 409; throw f; }
                rader.set(id(e), { ...e });
            },
            upsertEntity: async (e) => rader.set(id(e), { ...e }),
            getEntity: async (pk, rk) => {
                const e = rader.get(`${pk}|${rk}`);
                if (!e) { const f = new Error('404'); f.statusCode = 404; throw f; }
                return e;
            },
            listEntities: ({ queryOptions } = {}) => {
                const f = queryOptions?.filter || '';
                const pk = /PartitionKey eq '((?:[^']|'')*)'/.exec(f)?.[1]?.replace(/''/g, "'");
                const gt = /RowKey gt '((?:[^']|'')*)'/.exec(f)?.[1]?.replace(/''/g, "'");
                const treff = [...rader.values()]
                    .filter(e => (pk === undefined || e.partitionKey === pk))
                    .filter(e => (gt === undefined || e.rowKey > gt));
                return (async function* () { for (const e of treff) yield e; })();
            }
        };
    };
    return tabeller;
}

async function kjor() {
    const opprinnelig = storage.sikreTabell;
    try {
        // ---------- radnøkkel ----------
        {
            const a = samtale.radNokkel(new Date('2026-09-18T10:00:00.000Z'));
            const b = samtale.radNokkel(new Date('2026-09-18T10:00:01.000Z'));
            sjekk('eldre sorterer først', a < b, true);
            sjekk('tidsstempelet står forrest', a.startsWith('2026-09-18T10:00:00.000Z-'), true);

            // Samme millisekund, mange innlegg. Uten suffikset ville disse
            // vært identiske, og alle bortsett fra én hadde forsvunnet.
            const t = new Date('2026-09-18T10:00:00.000Z');
            const rekke = Array.from({ length: 200 }, () => samtale.radNokkel(t));
            sjekk('unik i samme millisekund', new Set(rekke).size, 200);

            // ... og de skal fortsatt komme i rekkefølge. Tilfeldighet alene
            // løser kollisjonen, ikke sorteringen: da kunne et svar vist seg
            // over spørsmålet.
            sjekk('og sortert', rekke.every((k, i) => i === 0 || rekke[i - 1] < k), true);
        }

        // ---------- OData-sitering ----------
        {
            sjekk('vanlig verdi', samtale.sitat('t1:42'), "'t1:42'");
            // En apostrof som ikke dobles, avslutter strengen midt i filteret.
            sjekk('apostrof dobles', samtale.sitat("o'brien"), "'o''brien'");
        }

        // ---------- legge til ----------
        {
            stubb();
            const i1 = await samtale.leggTil('t1', '42', {
                avsender: 'Kari@FHS.no', avsenderNavn: 'Kari Nordmann', tekst: '  Hei, har dere fått vedlegget?  '
            });
            sjekk('teksten trimmes', i1.Tekst, 'Hei, har dere fått vedlegget?');
            sjekk('avsender normaliseres', i1.Avsender, 'kari@fhs.no');
            sjekk('navnet følger med', i1.AvsenderNavn, 'Kari Nordmann');
            sjekk('kilde er swa som standard', i1.Kilde, 'swa');

            const i2 = await samtale.leggTil('t1', '42', {
                avsender: 'per@fhs.no', tekst: 'Ja, kommer i morgen', kilde: 'otp'
            });
            sjekk('kilde kan settes', i2.Kilde, 'otp');

            // Et innlegg uten innhold er ikke et innlegg.
            for (const [navn, arg] of [
                ['tom tekst', { avsender: 'a@b.no', tekst: '' }],
                ['bare mellomrom', { avsender: 'a@b.no', tekst: '   ' }],
                ['uten avsender', { avsender: '', tekst: 'noe' }]
            ]) {
                let kastet = false;
                try { await samtale.leggTil('t1', '42', arg); } catch (_) { kastet = true; }
                sjekk(`${navn} avvises`, kastet, true);
            }

            // Grensen håndheves av oss, ikke av Table Storage.
            let melding = '';
            try {
                await samtale.leggTil('t1', '42', { avsender: 'a@b.no', tekst: 'x'.repeat(samtale.MAKS_TEGN + 1) });
            } catch (e) { melding = e.message; }
            sjekk('for langt innlegg avvises', /for langt/.test(melding), true);
            sjekk('og meldingen sier hvor grensen går', melding.includes(String(samtale.MAKS_TEGN)), true);

            // Akkurat på grensen skal gå gjennom.
            const grense = await samtale.leggTil('t1', '42', { avsender: 'a@b.no', tekst: 'y'.repeat(samtale.MAKS_TEGN) });
            sjekk('nøyaktig maks går gjennom', grense.Tekst.length, samtale.MAKS_TEGN);
        }

        // ---------- hente ----------
        {
            stubb();
            await samtale.leggTil('t1', '42', { avsender: 'a@b.no', tekst: 'første' });
            await samtale.leggTil('t1', '42', { avsender: 'b@b.no', tekst: 'andre' });
            await samtale.leggTil('t1', '99', { avsender: 'c@b.no', tekst: 'annen sak' });

            const alle = await samtale.hentInnlegg('t1', '42');
            sjekk('bare denne saken', alle.map(i => i.Tekst), ['første', 'andre']);

            // Pollingen: bare det som har kommet siden sist.
            const nye = await samtale.hentInnlegg('t1', '42', { etter: alle[0].Id });
            sjekk('etter siste gir bare det nye', nye.map(i => i.Tekst), ['andre']);
            sjekk('etter det siste gir ingenting',
                (await samtale.hentInnlegg('t1', '42', { etter: alle[1].Id })).length, 0);

            sjekk('tom sak', await samtale.hentInnlegg('t1', 'finnes-ikke'), []);
        }

        // ---------- sammendrag ----------
        {
            stubb();
            sjekk('uten innlegg', await samtale.sammendrag('t1', '42'), { Antall: 0, SisteDato: '' });
            await samtale.leggTil('t1', '42', { avsender: 'a@b.no', tekst: 'en' });
            const siste = await samtale.leggTil('t1', '42', { avsender: 'b@b.no', tekst: 'to' });
            const s = await samtale.sammendrag('t1', '42');
            sjekk('antall', s.Antall, 2);
            sjekk('dato for det siste', s.SisteDato, siste.Dato);
            // Teksten skal IKKE med — dette går i et regneark som lastes ned.
            sjekk('ingen tekst i sammendraget', Object.keys(s), ['Antall', 'SisteDato']);
        }

        // ---------- demping ----------
        {
            stubb();
            sjekk('udempet i utgangspunktet', await samtale.erDempet('t1', '42', 'kari@fhs.no'), false);
            await samtale.settDemping('t1', '42', 'Kari@FHS.no', true);
            sjekk('dempet', await samtale.erDempet('t1', '42', 'kari@fhs.no'), true);

            // Per sak, ikke per bruker: samme person i en annen sak skal
            // fortsatt varsles.
            sjekk('dempingen gjelder bare denne saken',
                await samtale.erDempet('t1', '99', 'kari@fhs.no'), false);
            sjekk('og bare denne brukeren',
                await samtale.erDempet('t1', '42', 'ola@fhs.no'), false);

            await samtale.settDemping('t1', '42', 'kari@fhs.no', false);
            sjekk('kan skrus av igjen', await samtale.erDempet('t1', '42', 'kari@fhs.no'), false);

            // En tabell som er nede skal gi «ikke dempet» — altså varsle.
            storage.sikreTabell = async () => { throw new Error('nede'); };
            sjekk('feiler lukket mot å varsle', await samtale.erDempet('t1', '42', 'kari@fhs.no'), false);
        }
    } finally {
        storage.sikreTabell = opprinnelig;
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error(e); process.exit(1); });
