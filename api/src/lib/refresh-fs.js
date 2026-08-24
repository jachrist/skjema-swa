/**
 * Refresh av FS-data (Emner + EmneStudenter) til Table Storage.
 *
 * Flow:
 *   1. Beregn aktive terminer (forrige/inneværende/neste)
 *   2. Slå opp FS-termin-IDene
 *   3. Hent undervisningsenheter (paginert)
 *   4. Transformer til Emner-rader + EmneStudenter-rader
 *   5. Slett aktive terminer i storage, skriv nye rader
 *   6. Rydd partisjoner som ikke lenger er blant aktive
 *   7. Skriv metadata
 */

const terminer = require('./terminer');
const fs = require('./fs-client');
const store = require('./emner-storage');

const ROLLE_LAERER = 'LÆRER';
const ROLLE_HOVEDLAERER = 'HOVEDLÆRER';

// Azure Table property tåler 32 KiB — 30 KiB som trygg grense
const LU_MAX_LENGDE = 30000;

// FS avkorter studenterIKlasse stille ved 10 uten «first» (spec §6 funn 5).
const STUDENTER_PER_KLASSE = 1000;
const KLASSER_PER_SIDE = 50;

function normaliserLuHtml(html) {
    if (!html) return '';
    return String(html)
        .replace(/<list\s+listType="bulleted"\s*>/gi, '<ul>')
        .replace(/<list\s+listType="numbered"\s*>/gi, '<ol>')
        .replace(/<list[^>]*>/gi, '<ul>')
        .replace(/<\/list>/gi, '</ul>')
        .replace(/<listItem\s*>/gi, '<li>')
        .replace(/<\/listItem>/gi, '</li>');
}

function utledLu(emne) {
    const noder = emne?.beskrivelsesavsnitt?.nodes || [];
    if (noder.length === 0) return '';
    const samlet = noder.map(n => n?.innhold || '').filter(Boolean).join('<br><br>');
    const norm = normaliserLuHtml(samlet);
    if (norm.length > LU_MAX_LENGDE) return norm.slice(0, LU_MAX_LENGDE - 10) + '…</p>';
    return norm;
}

function delAvPersonRoller(personroller, rolleKode) {
    const treff = (personroller?.nodes || []).filter(p => p.fsRolle?.kode === rolleKode);
    return treff.map(p => ({
        FN: p.personProfil?.navn?.fornavn || '',
        EN: p.personProfil?.navn?.etternavn || '',
        EP: p.personProfil?.institusjonsEpost || ''
    })).filter(p => p.EP);
}

/**
 * Bygg FilterStudent-rader for én student under én filterkategori.
 * Se docs/FILTERSTUDENT-SPEC.md §3.
 */
function filterRad(fk, fv, student, generasjon) {
    return {
        partitionKey: store.filterPk(fk, fv),
        rowKey: String(student.EP).toLowerCase(),
        FN: student.FN || '',
        EN: student.EN || '',
        EP: student.EP,
        Termin: student.Termin || '',
        G: generasjon
    };
}

function transformer(undervisningsenheter, generasjon = '') {
    const emneRader = [];
    const studentRader = [];
    const filterRader = [];

    for (const u of undervisningsenheter) {
        const tArstall = u.termin?.arstall;
        const tBetegn = u.termin?.betegnelse?.kode;
        if (!tArstall || !tBetegn) continue;
        const terminKort = terminer.kortKode(tArstall, tBetegn);

        const ek = u.emne?.kode;
        const vk = u.emne?.versjonskode;
        if (!ek || !vk) continue;

        const en = u.emne?.navnAlleSprak?.nb || '';
        const sp = u.emne?.studieprogramkoblinger?.[0]?.studieprogram;
        const c = u.emne?.campuser?.[0]?.campus;

        const larere = delAvPersonRoller(u.personroller, ROLLE_LAERER);
        const hovedlarere = delAvPersonRoller(u.personroller, ROLLE_HOVEDLAERER);

        emneRader.push({
            partitionKey: terminKort,
            rowKey: `${ek}-${vk}`,
            EK: ek,
            VK: vk,
            EN: en,
            SK: sp?.kode || '',
            SN: sp?.navnAlleSprak?.nb || '',
            C: c?.kode || '',
            Larere: JSON.stringify(larere),
            Hovedlarere: JSON.stringify(hovedlarere),
            LU: utledLu(u.emne)
        });

        for (const sr of (u.studieretter?.nodes || [])) {
            const profil = sr.student?.personProfil;
            const epost = profil?.institusjonsEpost || '';
            if (!epost) continue;
            studentRader.push({
                partitionKey: `${terminKort}|${ek}-${vk}`,
                rowKey: epost.toLowerCase(),
                FN: profil.navn?.fornavn || '',
                EN: profil.navn?.etternavn || '',
                EP: epost
            });

            const student = {
                FN: profil.navn?.fornavn || '',
                EN: profil.navn?.etternavn || '',
                EP: epost,
                Termin: terminKort
            };
            // EK-radene er dagens EmneStudenter-rader med prefiks på nøkkelen.
            filterRader.push(filterRad('EK', `${terminKort}|${ek}-${vk}`, student, generasjon));
            filterRader.push(filterRad('ALLE', '', student, generasjon));
        }
    }
    return { emneRader, studentRader, filterRader };
}

/**
 * Transformer klasser fra FS til FilterStudent-rader (KL/KU/SP/ALLE) samt
 * metadata-rader for klasse- og kull-dropdownene.
 *
 * Klassens studieprogram kan ikke leses fra klasse-noden i FS og utledes
 * derfor fra studentenes egne studieretter — se spec §6b funn 8. Er det mer
 * enn ett program i en klasse, brytes antakelsen og det logges.
 */
function transformerKlasser(klasser, generasjon = '', log = () => {}) {
    const filterRader = [];
    const metaRader = [];
    // Kull spenner over flere klasser, så metadata må akkumuleres — ellers
    // overskriver siste klasse antallet fra de foregående.
    const kullMeta = new Map();
    let hoppetOver = 0;
    let avkortet = 0;

    for (const k of klasser) {
        const kode = k?.kode;
        if (!kode) continue;

        const arstall = k.kull?.terminV2?.arstall;
        const betegnelse = k.kull?.terminV2?.betegnelse?.kode;
        if (!arstall || !betegnelse) continue;
        const terminKort = terminer.kortKode(arstall, betegnelse);

        const noder = k.studenterIKlasse?.nodes || [];
        // Tomme klasser er utgåtte — de rydder seg selv bort ved at de ikke
        // produserer rader. totalCount kan IKKE brukes her (spec §6 funn 2b).
        if (noder.length === 0) { hoppetOver++; continue; }
        if (noder.length >= STUDENTER_PER_KLASSE) avkortet++;

        const klasseNavn = k.navnAlleSprak?.und || kode;
        const kullNavn = k.kull?.navnAlleSprak?.no || '';

        const studenter = [];
        const programmer = new Set();
        for (const n of noder) {
            const ps = n?.programStudierett;
            const profil = ps?.student?.personProfil;
            const epost = profil?.institusjonsEpost || '';
            const sp = ps?.studieprogram?.kode || '';
            if (!epost || !sp) continue;
            programmer.add(sp);
            studenter.push({
                FN: profil.navn?.fornavn || '',
                EN: profil.navn?.etternavn || '',
                EP: epost,
                Termin: terminKort,
                SP: sp,
                SN: ps.studieprogram?.navnAlleSprak?.nb || ''
            });
        }
        if (studenter.length === 0) { hoppetOver++; continue; }

        if (programmer.size > 1) {
            log(`refresh-fs: ADVARSEL — klasse "${kode}" (${terminKort}) har studenter fra ` +
                `flere studieprogram: ${[...programmer].join(', ')}. Klassen splittes over ` +
                `like mange KL-partisjoner. Se docs/FILTERSTUDENT-SPEC.md §6b funn 8.`);
        }

        for (const s of studenter) {
            filterRader.push(filterRad('KL', `${s.SP}|${terminKort}|${kode}`, s, generasjon));
            filterRader.push(filterRad('KU', `${s.SP}|${terminKort}`, s, generasjon));
            filterRader.push(filterRad('SP', s.SP, s, generasjon));
            filterRader.push(filterRad('ALLE', '', s, generasjon));
        }

        // Metadata for dropdownene — én rad per (klasse, program) og (kull, program)
        for (const sp of programmer) {
            const antall = studenter.filter(s => s.SP === sp).length;
            const sn = studenter.find(s => s.SP === sp)?.SN || '';
            metaRader.push({
                partitionKey: 'KLASSE',
                rowKey: store.trygtNokkelledd(`${sp}|${terminKort}|${kode}`),
                Navn: `${klasseNavn} (${sp}, ${terminKort})`,
                SP: sp, Termin: terminKort, Antall: antall, G: generasjon
            });
            const kullNokkel = store.trygtNokkelledd(`${sp}|${terminKort}`);
            const eksisterende = kullMeta.get(kullNokkel);
            if (eksisterende) {
                eksisterende.Antall += antall;
                if (!eksisterende.Navn && kullNavn) eksisterende.Navn = `${kullNavn} (${terminKort})`;
            } else {
                kullMeta.set(kullNokkel, {
                    partitionKey: 'KULL',
                    rowKey: kullNokkel,
                    Navn: `${kullNavn || sn || sp} (${terminKort})`,
                    SP: sp, Termin: terminKort, Antall: antall, G: generasjon
                });
            }
        }
    }

    metaRader.push(...kullMeta.values());
    return { filterRader, metaRader, hoppetOver, avkortet };
}

async function ryddGamleTerminer(aktiveKortKoder) {
    const aktiveSet = new Set(aktiveKortKoder);

    const emnePartisjoner = await store.listPartisjoner(store.TABELL_EMNER);
    for (const pk of emnePartisjoner) {
        if (!aktiveSet.has(pk)) await store.slettAlleIPartisjon(store.TABELL_EMNER, pk);
    }

    const studPartisjoner = await store.listPartisjoner(store.TABELL_STUDENTER);
    for (const pk of studPartisjoner) {
        const termin = pk.split('|')[0];
        if (!aktiveSet.has(termin)) await store.slettAlleIPartisjon(store.TABELL_STUDENTER, pk);
    }
}

/**
 * Hovedfunksjon — kalles fra HTTP-trigger (via GitHub Actions cron).
 */
async function refreshFS(log = (...a) => console.log(...a)) {
    const startTid = Date.now();
    log('refresh-fs: starter');

    const aktive = terminer.aktiveTerminer();
    log(`refresh-fs: aktive terminer = ${aktive.map(t => t.kort).join(', ')}`);

    const idMap = await fs.hentTerminer(aktive.map(t => ({ arstall: t.arstall, betegnelse: t.betegnelse })));
    const terminIder = [];
    for (const t of aktive) {
        const id = idMap.get(`${t.arstall}-${t.betegnelse}`);
        if (id) terminIder.push(id);
        else log(`refresh-fs: ADVARSEL — fant ikke FS-termin-id for ${t.kort}`);
    }
    if (terminIder.length === 0) throw new Error('Fant ingen FS-termin-IDer for aktive terminer');

    // Emnebeskrivelsen hentes for INNEVÆRENDE termin, ikke siste aktive.
    // gjelderFraTerminer treffer bare tekstversjoner knyttet til akkurat den
    // terminen som oppgis, og for neste termin er de ennå ikke skrevet — derfor
    // sto LU-kolonnen tom. Verifisert 2026-08-24 med refresh-fs/diag-lu:
    // 0 av 8 emner ga innhold for neste termin, 8 av 8 for inneværende.
    const naaTermin = aktive[1];
    const luTermin = { arstall: naaTermin.arstall, terminbetegnelse: naaTermin.betegnelse };
    const enheter = await fs.hentUndervisningsenheter(terminIder, 200, luTermin);
    log(`refresh-fs: hentet ${enheter.length} undervisningsenheter fra FS (beskrivelse fra ${naaTermin.kort})`);

    // Generasjonsmarkør for FilterStudent-ryddingen (spec §5)
    const generasjon = new Date().toISOString();

    const { emneRader, studentRader, filterRader: emneFilterRader } = transformer(enheter, generasjon);
    log(`refresh-fs: ${emneRader.length} emne-rader, ${studentRader.length} student-rader`);

    // Klasser/kull/studieprogram — egen FS-spørring (spec §6)
    let klasseFilterRader = [];
    let klasseMetaRader = [];
    let klasseDiag = { fraFs: 0, medStudenter: 0, utenStudenter: 0, avkortet: 0, feil: '' };
    try {
        const klasser = await fs.hentKlasser(KLASSER_PER_SIDE, STUDENTER_PER_KLASSE);
        log(`refresh-fs: hentet ${klasser.length} klasser fra FS`);
        const kr = transformerKlasser(klasser, generasjon, log);
        klasseFilterRader = kr.filterRader;
        klasseMetaRader = kr.metaRader;
        klasseDiag = {
            fraFs: klasser.length,
            medStudenter: klasser.length - kr.hoppetOver,
            utenStudenter: kr.hoppetOver,
            avkortet: kr.avkortet,
            feil: ''
        };
        log(`refresh-fs: ${klasseFilterRader.length} klasse-filterrader, ` +
            `${klasseMetaRader.length} metarader, ${kr.hoppetOver} klasser uten studenter hoppet over`);
        if (kr.avkortet > 0) {
            log(`refresh-fs: ADVARSEL — ${kr.avkortet} klasse(r) traff grensen på ` +
                `${STUDENTER_PER_KLASSE} studenter og kan være avkortet`);
        }
    } catch (e) {
        // Klasse-delen skal ikke velte emne-refreshen mens den er ny
        klasseDiag.feil = String(e.message || e).slice(0, 500);
        log(`refresh-fs: FEIL i klasse-henting (emner er upåvirket): ${e.message}`);
    }

    const aktiveKortKoder = aktive.map(t => t.kort);
    for (const tk of aktiveKortKoder) {
        await store.slettAlleIPartisjon(store.TABELL_EMNER, tk);
    }
    const allStud = await store.listPartisjoner(store.TABELL_STUDENTER);
    for (const pk of allStud) {
        const termin = pk.split('|')[0];
        if (aktiveKortKoder.includes(termin)) await store.slettAlleIPartisjon(store.TABELL_STUDENTER, pk);
    }

    await store.upsertBatch(store.TABELL_EMNER, emneRader);
    await store.upsertBatch(store.TABELL_STUDENTER, studentRader);
    await ryddGamleTerminer(aktiveKortKoder);

    // FilterStudent: skriv ALLE nye rader først, rydd så bort forrige
    // generasjon. Rekkefølgen gir null tomt vindu for brukerne (spec §5).
    const alleFilterRader = [...emneFilterRader, ...klasseFilterRader, ...klasseMetaRader];
    let filterSlettet = 0;
    if (alleFilterRader.length > 0) {
        const { lagret } = await store.upsertBatch(store.TABELL_FILTERSTUDENT, alleFilterRader);
        filterSlettet = await store.slettGamleGenerasjoner(store.TABELL_FILTERSTUDENT, generasjon);
        log(`refresh-fs: FilterStudent — ${lagret} rader skrevet, ${filterSlettet} gamle slettet`);
    } else {
        log('refresh-fs: ADVARSEL — ingen FilterStudent-rader bygget, hopper over rydding');
    }

    await store.settMetadata('FS-Emner', { antallRader: emneRader.length, status: 'ok' });
    await store.settMetadata('FS-Studenter', { antallRader: studentRader.length, status: 'ok' });
    await store.settMetadata('FS-FilterStudent', { antallRader: alleFilterRader.length, status: 'ok' });
    await store.settMetadata('FS-Klasser', {
        antallRader: klasseMetaRader.length,
        status: klasseDiag.feil ? 'feil' : 'ok',
        feil: klasseDiag.feil,
        ekstra: {
            KlasserFraFs: klasseDiag.fraFs,
            KlasserMedStudenter: klasseDiag.medStudenter,
            KlasserUtenStudenter: klasseDiag.utenStudenter,
            KlasserAvkortet: klasseDiag.avkortet
        }
    });

    const varighet = ((Date.now() - startTid) / 1000).toFixed(1);
    log(`refresh-fs: fullført på ${varighet} s`);
    return {
        terminer: aktiveKortKoder,
        antallEmner: emneRader.length,
        antallStudenter: studentRader.length,
        antallFilterRader: alleFilterRader.length,
        antallKlasseRader: klasseFilterRader.length,
        antallSlettetGammel: filterSlettet,
        varighetSekunder: Number(varighet)
    };
}

module.exports = { refreshFS, transformer, transformerKlasser, normaliserLuHtml };
