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

function transformer(undervisningsenheter) {
    const emneRader = [];
    const studentRader = [];

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
        }
    }
    return { emneRader, studentRader };
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

    const sisteTermin = aktive[aktive.length - 1];
    const luTermin = { arstall: sisteTermin.arstall, terminbetegnelse: sisteTermin.betegnelse };
    const enheter = await fs.hentUndervisningsenheter(terminIder, 200, luTermin);
    log(`refresh-fs: hentet ${enheter.length} undervisningsenheter fra FS`);

    const { emneRader, studentRader } = transformer(enheter);
    log(`refresh-fs: ${emneRader.length} emne-rader, ${studentRader.length} student-rader`);

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

    await store.settMetadata('FS-Emner', { antallRader: emneRader.length, status: 'ok' });
    await store.settMetadata('FS-Studenter', { antallRader: studentRader.length, status: 'ok' });

    const varighet = ((Date.now() - startTid) / 1000).toFixed(1);
    log(`refresh-fs: fullført på ${varighet} s`);
    return {
        terminer: aktiveKortKoder,
        antallEmner: emneRader.length,
        antallStudenter: studentRader.length,
        varighetSekunder: Number(varighet)
    };
}

module.exports = { refreshFS, transformer, normaliserLuHtml };
