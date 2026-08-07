/**
 * Termin-logikk.
 *
 * En "termin" i FS er kombinasjonen årstall + betegnelse ("VÅR" eller "HØST").
 * VÅR dekker januar–juni, HØST dekker juli–desember.
 *
 * Vi opererer med tre aktive terminer av gangen: forrige, inneværende, neste.
 *
 * Kort termin-kode (brukes som PartitionKey i Emner-tabellen):
 *   "26V" = VÅR 2026, "26H" = HØST 2026
 */

const BETEGNELSER = ['VÅR', 'HØST'];

function kortKode(arstall, betegnelse) {
    const aa = String(arstall).slice(-2);
    return `${aa}${betegnelse === 'VÅR' ? 'V' : 'H'}`;
}

function inneverende(dato = new Date()) {
    const arstall = dato.getFullYear();
    const maaned = dato.getMonth() + 1;
    const betegnelse = maaned <= 6 ? 'VÅR' : 'HØST';
    return { arstall, betegnelse, kort: kortKode(arstall, betegnelse) };
}

function forrigeTermin(t) {
    if (t.betegnelse === 'VÅR') {
        return { arstall: t.arstall - 1, betegnelse: 'HØST', kort: kortKode(t.arstall - 1, 'HØST') };
    }
    return { arstall: t.arstall, betegnelse: 'VÅR', kort: kortKode(t.arstall, 'VÅR') };
}

function nesteTermin(t) {
    if (t.betegnelse === 'VÅR') {
        return { arstall: t.arstall, betegnelse: 'HØST', kort: kortKode(t.arstall, 'HØST') };
    }
    return { arstall: t.arstall + 1, betegnelse: 'VÅR', kort: kortKode(t.arstall + 1, 'VÅR') };
}

function aktiveTerminer(dato = new Date()) {
    const naa = inneverende(dato);
    return [forrigeTermin(naa), naa, nesteTermin(naa)];
}

module.exports = {
    inneverende,
    forrigeTermin,
    nesteTermin,
    aktiveTerminer,
    kortKode,
    BETEGNELSER
};
