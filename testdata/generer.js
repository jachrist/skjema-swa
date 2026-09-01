#!/usr/bin/env node
/**
 * Genererer syntetiske testdata for dev-tenanten.
 *
 * Bakgrunn: rolle- og teamlogikken kan ikke testes skikkelig med én bruker, og
 * produksjonsdata hører ikke hjemme i dev. Dette gir et sett brukere, team og
 * roller som ser ekte nok ut til å avsløre feil, uten å være noen.
 *
 * Brukernavnene følger samme mønster som i produksjon — forbokstav pluss
 * etternavn, `fborresen@` — slik at testdataene ligner det de erstatter. Ved
 * navnekollisjon utvides forbokstaven, som i virkeligheten.
 *
 * Rollene her er BEVISST bare de som ikke kommer fra Felles Studentsystem.
 * Emneansvarlig og klassebaserte roller genereres av FS-synkroniseringen hver
 * natt; lager vi dem her også, tester vi mot data som blir overskrevet.
 *
 * Kjøringen er deterministisk. Samme seed gir samme personer, så et testtilfelle
 * som viser til «hbratt@jcconsulting.no» fortsetter å gjelde etter en regenerering.
 *
 * Bruk:
 *   node testdata/generer.js            # skriver JSON-filene i denne mappa
 *   node testdata/generer.js --seed 42  # annet utvalg
 */
const fs = require('fs');
const path = require('path');

const DOMENE = 'jcconsulting.no';
const ANTALL_BRUKERE = 50;
const ANTALL_TEAM = 8;

const FORNAVN = [
    'Kari', 'Ola', 'Ingrid', 'Lars', 'Anne', 'Bjørn', 'Silje', 'Erik', 'Marte', 'Håkon',
    'Nora', 'Jonas', 'Astrid', 'Magnus', 'Ida', 'Sindre', 'Hanne', 'Espen', 'Guro', 'Trond',
    'Linnea', 'Anders', 'Maja', 'Fredrik', 'Solveig', 'Vegard', 'Thea', 'Kristian', 'Mona', 'Øyvind',
    'Elin', 'Sondre', 'Camilla', 'Rune', 'Tuva', 'Henrik', 'Berit', 'Morten', 'Live', 'Petter',
    'Randi', 'Steinar', 'Ane', 'Jørgen', 'Hilde', 'Torbjørn', 'Emilie', 'Aslak', 'Marit', 'Gunnar'
];

const ETTERNAVN = [
    'Hansen', 'Johansen', 'Olsen', 'Larsen', 'Andersen', 'Pedersen', 'Nilsen', 'Kristiansen',
    'Jensen', 'Karlsen', 'Johnsen', 'Pettersen', 'Eriksen', 'Berg', 'Haugen', 'Hagen',
    'Johannessen', 'Andreassen', 'Jacobsen', 'Dahl', 'Jørgensen', 'Halvorsen', 'Lund', 'Strand',
    'Solberg', 'Moe', 'Iversen', 'Bakken', 'Nordvik', 'Fjeld', 'Aune', 'Rønning', 'Lie',
    'Sandvik', 'Ødegård', 'Bråten', 'Vik', 'Holm', 'Nygård', 'Løken', 'Myhre', 'Ellingsen',
    'Gulbrandsen', 'Sæther', 'Tangen', 'Rustad', 'Kvam', 'Berge', 'Bye', 'Foss'
];

const TEAM = [
    { navn: 'Fagstab utdanning',        beskrivelse: 'Planlegging og oppfølging av utdanningsløp' },
    { navn: 'Kvalitetsarbeid',          beskrivelse: 'Kvalitetssikring og evaluering' },
    { navn: 'Anskaffelser',             beskrivelse: 'Behandling av anskaffelsesplaner' },
    { navn: 'Personell og HR',          beskrivelse: 'Personalsaker og fraværshåndtering' },
    { navn: 'Digitalisering',           beskrivelse: 'Systemforvaltning og automatisering' },
    { navn: 'Cyberingeniørskolen',      beskrivelse: 'Skolens administrative team' },
    { navn: 'Befalsskolen',             beskrivelse: 'Skolens administrative team' },
    { navn: 'Ledergruppen',             beskrivelse: 'Skolens ledelse' }
];

// Roller som IKKE kommer fra FS. Tomt omfang betyr «gjelder uten avgrensning».
const ROLLER = [
    { rolle: 'Sjef',                     omfang: 'Befalsskolen',        beskrivelse: 'Øverste leder ved skolen', antall: 1 },
    { rolle: 'Sjef',                     omfang: 'Cyberingeniørskolen', beskrivelse: 'Øverste leder ved skolen', antall: 1 },
    { rolle: 'Administrativ godkjenner', omfang: 'Fagstab',             beskrivelse: 'Godkjenner administrative søknader', antall: 3 },
    { rolle: 'Administrativ godkjenner', omfang: 'Fellesadministrasjonen', beskrivelse: 'Godkjenner administrative søknader', antall: 2 },
    { rolle: 'Kvalitetsmedarbeider',     omfang: 'Kvalitetsarbeid',     beskrivelse: 'Følger opp kvalitetsavvik og evalueringer', antall: 3 },
    { rolle: 'Anskaffelsesansvarlig',    omfang: 'Fellesadministrasjonen', beskrivelse: 'Behandler anskaffelsesplaner', antall: 2 },
    { rolle: 'Økonomiansvarlig',         omfang: 'Fellesadministrasjonen', beskrivelse: 'Vurderer økonomiske konsekvenser', antall: 2 },
    { rolle: 'Personellansvarlig',       omfang: 'Personell',           beskrivelse: 'Behandler personellsaker', antall: 2 },
    { rolle: 'Verneombud',               omfang: 'Befalsskolen',        beskrivelse: 'Verneombud for skolen', antall: 1 },
    { rolle: 'Verneombud',               omfang: 'Cyberingeniørskolen', beskrivelse: 'Verneombud for skolen', antall: 1 },
    { rolle: 'Systemeier',               omfang: '',                    beskrivelse: 'Eier av skjemaløsningen', antall: 1 },
    { rolle: 'Arkivar',                  omfang: '',                    beskrivelse: 'Arkivfaglig ansvar', antall: 2 },
    { rolle: 'Skjemaskaper',             omfang: '',                    beskrivelse: 'Kan opprette og redigere skjematyper', antall: 3 }
];

/**
 * Liten deterministisk generator (mulberry32). Math.random ville gitt nye
 * personer for hver kjøring, og da ville et testtilfelle som viser til en
 * bestemt bruker sluttet å gjelde.
 */
function tilfeldig(seed) {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

const arg = process.argv.indexOf('--seed');
const SEED = arg > -1 ? Number(process.argv[arg + 1]) || 1 : 1;
const rnd = tilfeldig(SEED);

const heltall = (maks) => Math.floor(rnd() * maks);
const plukk = (liste) => liste[heltall(liste.length)];

/** Trekk n unike elementer uten å endre kildelista. */
function plukkFlere(liste, n) {
    const kopi = [...liste];
    const ut = [];
    for (let i = 0; i < n && kopi.length; i++) ut.push(...kopi.splice(heltall(kopi.length), 1));
    return ut;
}

/** «Bjørn Foss» → bfoss@. Ved kollisjon utvides forbokstaven, som i virkeligheten. */
function lagBrukernavn(fornavn, etternavn, tatt) {
    const reint = (s) => s.toLowerCase()
        .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
        .replace(/[^a-z]/g, '');
    const en = reint(etternavn);
    const fn = reint(fornavn);
    for (let i = 1; i <= fn.length; i++) {
        const kandidat = `${fn.slice(0, i)}${en}`;
        if (!tatt.has(kandidat)) return kandidat;
    }
    let n = 2;
    while (tatt.has(`${fn}${en}${n}`)) n++;
    return `${fn}${en}${n}`;
}

// ---------- brukere ----------
const tatt = new Set();
const brukere = [];
const brukteNavn = new Set();
while (brukere.length < ANTALL_BRUKERE) {
    const fornavn = plukk(FORNAVN);
    const etternavn = plukk(ETTERNAVN);
    const helt = `${fornavn} ${etternavn}`;
    if (brukteNavn.has(helt)) continue;
    brukteNavn.add(helt);
    const bruker = lagBrukernavn(fornavn, etternavn, tatt);
    tatt.add(bruker);
    brukere.push({
        UPN: `${bruker}@${DOMENE}`,
        Fornavn: fornavn,
        Etternavn: etternavn,
        Navn: helt
    });
}

// ---------- team ----------
const grupper = TEAM.map(t => {
    const antall = 3 + heltall(4); // 3-6
    return {
        Team: t.navn,
        Beskrivelse: t.beskrivelse,
        Medlemmer: plukkFlere(brukere, antall).map(b => ({
            EP: b.UPN, FN: b.Fornavn, EN: b.Etternavn, Navn: b.Navn
        }))
    };
});

// ---------- roller ----------
const innehavere = [];
for (const r of ROLLER) {
    for (const b of plukkFlere(brukere, r.antall)) {
        innehavere.push({
            Rolle: r.rolle,
            Omfang: r.omfang,
            UPN: b.UPN,
            FN: b.Fornavn,
            EN: b.Etternavn,
            Rollebeskrivelse: r.beskrivelse
        });
    }
}

// ---------- skriv ----------
const ut = (navn, data) => {
    const sti = path.join(__dirname, navn);
    fs.writeFileSync(sti, JSON.stringify(data, null, 2) + '\n');
    console.log(`${navn.padEnd(28)} ${Array.isArray(data) ? data.length : (data.grupper?.length ?? '')} rader`);
};

ut('brukere.json', brukere);
ut('team.json', { grupper });
ut('roller.json', innehavere);

// CSV til rolleimporten i admin-panelet, som leser overskrifter på norsk.
const csv = ['Rolle;Omfang;UPN;Fornavn;Etternavn;Rollebeskrivelse']
    .concat(innehavere.map(r => [r.Rolle, r.Omfang, r.UPN, r.FN, r.EN, r.Rollebeskrivelse].join(';')))
    .join('\r\n') + '\r\n';
fs.writeFileSync(path.join(__dirname, 'roller.csv'), csv);
console.log(`${'roller.csv'.padEnd(28)} ${innehavere.length} rader`);

console.log(`\nSeed ${SEED} — samme seed gir samme personer.`);
