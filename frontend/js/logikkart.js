/**
 * logikkart.js — skjematypens logikk som et tre: hvilke seksjoner og felt som
 * vises når, og hvilke behandlingssteg som følger hverandre.
 *
 * Laget 26.11.2026 på ønske fra en oppdragsgiver med en skjematype med mange
 * betingede seksjoner, felt og steg. Forbildet var et tankekart brukeren hadde
 * tegnet for hånd: spørsmålet, og under det det som dukker opp «hvis ja».
 *
 * ## Plasseringen
 *
 * Et felt som vises på vilkår om ÉTT annet felt i SAMME seksjon, henges under
 * det feltet, med vilkåret på grenen («hvis «Ja»»). Det er tankekartets form,
 * og den som leser ser spørsmålet og følgene samlet.
 *
 * Alt annet blir stående der det står i skjemaet, med vilkåret som merkelapp:
 * vilkår om flere felt, om felt i en annen seksjon, og alle seksjoner. Å henge
 * en hel seksjon under et felt i en annen seksjon ville flyttet den ut av
 * rekkefølgen utfylleren møter, og gjort treet dypere enn skjemaet. Feltet det
 * avhenger av får i stedet en merkelapp «styrer …» med lenke dit.
 *
 * Behandlingsstegene henges under steget de er avhengige av (`AvhengigAv`).
 * Steg uten avhengighet starter ved innsending, parallelt.
 *
 * ## Én regel, ett sted
 *
 * Feltoppslaget bruker samme to referanseformer som vilkårsmotoren
 * (`vilkar.js`): feltets Id, eller posisjon `S-FF`. `behandling-N` er et
 * stegs beslutning, med `stegnummerFraRef` fra samme modul. Beslutningenes
 * farge er `typeFor` fra behandling-utfall.js.
 *
 * Modulen har ingen DOM. `byggLogikkart` gir et tre av rene objekter, og
 * `tilHtml` gjør det om til HTML der all tekst fra definisjonen er escapet.
 */
import { escapeHtml } from './escape.js';
import { migrerTilDNF, stegnummerFraRef, IDAG_REF } from './vilkar.js';
import { typeFor } from './behandling-utfall.js';

const OPERATOR = {
    '=': '=', '!=': '≠', '<': '<', '<=': '≤', '>': '>', '>=': '≥',
    tom: 'er tom', ikke_tom: 'er fylt ut', inneholder: 'inneholder'
};
const UTEN_VERDI = new Set(['tom', 'ikke_tom']);

/** Kort, ren tekst: Markdown og HTML tas bort, lange tekster kuttes. */
export function kortTekst(t, maks = 90) {
    const s = String(t ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[*_`#>]+/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    return s.length > maks ? `${s.slice(0, maks - 1).trimEnd()}…` : s;
}

function pad(n) {
    return String(n ?? '').padStart(2, '0');
}

/** Merkelappen for felttypen — slik tankekartet hadde dem. */
export function typeMerke(felt) {
    const t = String(felt?.Type || 'Tekst');
    if (t === 'Flervalg-knapper' || t === 'Flervalg-dropdown') {
        const flere = felt.MerkAlle || Number(felt.Max_valg || 1) > 1;
        return { tekst: flere ? 'Flervalg' : 'Enkeltvalg', klasse: flere ? 'flervalg' : 'enkeltvalg' };
    }
    if (t === 'Informasjon') return { tekst: 'Infoboks', klasse: 'info' };
    if (t === 'Tekst') return { tekst: felt.Flerlinje ? 'Fritekst (flere linjer)' : 'Fritekst', klasse: 'tekst' };
    if (t === 'Opplasting') return { tekst: 'Vedlegg', klasse: 'vedlegg' };
    if (t === 'Dato' || t === 'Tidspunkt') return { tekst: t, klasse: 'dato' };
    return { tekst: t, klasse: 'annet' };
}

/**
 * Oppslag fra referanse til felt, på begge formene vilkårsmotoren godtar.
 * Gir `{ felt, seksjon, ref }` eller null.
 */
function byggFeltoppslag(seksjoner) {
    const perId = new Map();
    const perPosisjon = new Map();
    for (const sek of (seksjoner || [])) {
        const sekNr = sek?.Seksjon_nummer ?? sek?.Nummer;
        for (const felt of (sek?.Felter || [])) {
            const info = { felt, seksjon: sek, ref: `${sekNr}-${pad(felt?.Nummer)}` };
            if (felt?.Id) perId.set(String(felt.Id).toLowerCase(), info);
            perPosisjon.set(info.ref, info);
        }
    }
    return (ref) => {
        let r = String(ref ?? '').trim();
        if (r.startsWith('{') && r.endsWith('}')) r = r.slice(1, -1).trim();
        if (!r) return null;
        const m = /^(\d+)-(\d+)$/.exec(r);
        if (m) return perPosisjon.get(`${Number(m[1])}-${pad(m[2])}`) || null;
        return perId.get(r.toLowerCase()) || null;
    };
}

/** Feltets navn i en setning: «Er det inngått databehandleravtale?» (2-01). */
function feltNavn(info) {
    if (!info) return 'ukjent felt';
    const tekst = kortTekst(info.felt?.Tekst?.Verdi ?? info.felt?.Tekst, 60);
    return tekst ? `«${tekst}»` : `felt ${info.ref}`;
}

/** Verdien i en betingelse, med valgets tekst når feltet har valg. */
function verdiTekst(verdi, info, finnFelt, behandling, stegNr) {
    if (verdi && typeof verdi === 'object' && !Array.isArray(verdi)) {
        const ref = String(verdi.Felt ?? '').trim();
        const dager = Number(verdi.PlussDager || 0);
        const grunn = ref === IDAG_REF ? 'dagens dato' : feltNavn(finnFelt(ref));
        return dager ? `${grunn} ${dager > 0 ? '+' : '−'} ${Math.abs(dager)} dager` : grunn;
    }
    if (stegNr !== null) {
        const steg = (behandling || []).find(s => Number(s?.Steg) === stegNr);
        const valg = (steg?.Beslutningsvalg || []).find(v => Number(v?.Nummer) === Number(verdi));
        return valg ? `«${kortTekst(valg.Tekst, 40)}»` : `beslutning ${verdi}`;
    }
    const valg = (info?.felt?.Valg || []).find(v => String(v?.Valg_nr) === String(verdi) || v?.Tekst === verdi);
    if (valg) return `«${kortTekst(valg.Tekst, 40)}»`;
    return `«${kortTekst(verdi, 40)}»`;
}

/** Hva venstresiden er: et felt, et steg, eller ukjent. */
function venstreside(ref, finnFelt, behandling) {
    const stegNr = stegnummerFraRef(ref);
    if (stegNr !== null) {
        const steg = (behandling || []).find(s => Number(s?.Steg) === stegNr);
        const navn = kortTekst(steg?.Stegnavn, 40);
        return { stegNr, info: null, navn: `steg ${stegNr}${navn ? ` «${navn}»` : ''}` };
    }
    const info = finnFelt(ref);
    return { stegNr: null, info, navn: feltNavn(info) };
}

/**
 * Vilkåret som en setning. `utenFelt` utelater feltnavnet — til grenen under
 * feltet vilkåret gjelder, der det står rett ovenfor.
 */
export function vilkarSomTekst(vilkar, { finnFelt, behandling, utenFelt = false } = {}) {
    const dnf = migrerTilDNF(vilkar);
    if (!dnf || !Array.isArray(dnf.EllerAv) || dnf.EllerAv.length === 0) return '';
    const grupper = dnf.EllerAv.map(g => (g?.OgAv || []).filter(Boolean).map(b => {
        const v = venstreside(b.Felt, finnFelt, behandling);
        const op = OPERATOR[b.Operator] || b.Operator || '=';
        const hoyre = UTEN_VERDI.has(b.Operator) ? '' : ` ${verdiTekst(b.Verdi, v.info, finnFelt, behandling, v.stegNr)}`;
        if (utenFelt) return b.Operator === '=' || !b.Operator ? hoyre.trim() : `${op}${hoyre}`;
        return `${v.navn} ${op}${hoyre}`;
    }).join(' og '));
    const tomme = grupper.filter(g => !g);
    if (tomme.length) return 'aldri (en gruppe uten betingelser)';
    return grupper.length > 1 ? grupper.map(g => (g.includes(' og ') ? `(${g})` : g)).join(' eller ') : grupper[0];
}

/** Feltene vilkåret ser på (venstresidene), uten steg og `@idag`. */
function felterIVilkar(vilkar, finnFelt) {
    const dnf = migrerTilDNF(vilkar);
    const ut = new Set();
    for (const g of (dnf?.EllerAv || [])) {
        for (const b of (g?.OgAv || [])) {
            if (!b || stegnummerFraRef(b.Felt) !== null) continue;
            const info = finnFelt(b.Felt);
            ut.add(info ? info.felt : `ukjent:${b.Felt}`);
            const v = b.Verdi;
            if (v && typeof v === 'object' && !Array.isArray(v) && v.Felt && String(v.Felt) !== IDAG_REF) {
                const h = finnFelt(v.Felt);
                ut.add(h ? h.felt : `ukjent:${v.Felt}`);
            }
        }
    }
    return [...ut];
}

function behandlere(steg) {
    const deler = [];
    for (const p of (steg?.Personer || [])) deler.push(String(p));
    for (const r of (steg?.Roller || [])) deler.push(String(r?.Rolle ? `${r.Rolle}${r.Omfang ? `(${r.Omfang})` : ''}` : r));
    for (const t of (steg?.Team || [])) deler.push(`Team: ${String(t)}`);
    if (steg?.InnsenderBehandler) deler.push('innsenderen');
    return deler;
}

/**
 * Bygg treet.
 *
 * Node: `{ id, slag, tittel, ref?, merker: [{tekst, klasse}], betingelse?,
 * gren?, styrer: [{id, tekst}], barn: [], iLogikk }`.
 *
 * `gren` er vilkåret på streken inn til noden, når den er hengt under feltet
 * vilkåret gjelder. `betingelse` er vilkåret som merkelapp, når den står der
 * den står i skjemaet. `iLogikk` er sann for alt som styrer eller styres —
 * resten kan skjules i den kompakte visningen.
 */
export function byggLogikkart(def) {
    const seksjoner = Array.isArray(def?.Seksjoner) ? def.Seksjoner : [];
    const behandling = Array.isArray(def?.Behandling) ? def.Behandling : [];
    const finnFelt = byggFeltoppslag(seksjoner);
    const tekst = (v, utenFelt = false) => vilkarSomTekst(v, { finnFelt, behandling, utenFelt });

    const nodeForFelt = new Map();
    const styrer = new Map();         // felt → [{ id, tekst }]
    const leggTilStyrer = (felt, id, t) => {
        if (!felt || typeof felt !== 'object') return;
        if (!styrer.has(felt)) styrer.set(felt, []);
        styrer.get(felt).push({ id, tekst: t });
    };

    const rot = {
        id: 'rot', slag: 'rot', tittel: kortTekst(def?.Skjema_navn, 80) || 'Skjematype',
        merker: [{ tekst: def?.Fase || 'Utvikling', klasse: 'fase' }], styrer: [], barn: [], iLogikk: true
    };

    seksjoner.forEach((sek, si) => {
        const sekNr = sek?.Seksjon_nummer ?? sek?.Nummer ?? (si + 1);
        const sekId = `seksjon-${sekNr}`;
        const sekNode = {
            id: sekId, slag: 'seksjon',
            tittel: kortTekst(sek?.Seksjon_overskrift, 80) || `Seksjon ${sekNr}`,
            ref: `Seksjon ${sekNr}`, merker: [], styrer: [], barn: [], iLogikk: false
        };
        if (sek?.Vises) {
            sekNode.betingelse = `Vises hvis ${tekst(sek.Vises)}`;
            sekNode.iLogikk = true;
            for (const f of felterIVilkar(sek.Vises, finnFelt)) leggTilStyrer(f, sekId, `seksjon ${sekNr}`);
        }
        rot.barn.push(sekNode);

        for (const felt of (sek?.Felter || [])) {
            const ref = `${sekNr}-${pad(felt?.Nummer)}`;
            const id = `felt-${ref}`;
            const merke = typeMerke(felt);
            const node = {
                id, slag: 'felt', ref,
                tittel: kortTekst(felt?.Tekst?.Verdi ?? felt?.Tekst, 90) || `(felt ${ref} uten tekst)`,
                merker: [merke], styrer: [], barn: [], iLogikk: false
            };
            if (felt?.Obligatorisk) node.merker.push({ tekst: 'Obligatorisk', klasse: 'obligatorisk' });
            if (felt?.ObligatoriskHvis) {
                node.merker.push({ tekst: `Obligatorisk hvis ${tekst(felt.ObligatoriskHvis)}`, klasse: 'vilkar' });
                node.iLogikk = true;
                for (const f of felterIVilkar(felt.ObligatoriskHvis, finnFelt)) leggTilStyrer(f, id, `obligatorisk ${ref}`);
            }
            const regler = Array.isArray(felt?.Validering) ? felt.Validering.length : 0;
            if (regler) node.merker.push({ tekst: `${regler} valideringsregel${regler === 1 ? '' : 'er'}`, klasse: 'validering' });
            if (felt?.FasteData) node.merker.push({ tekst: 'Valg fra datakilde', klasse: 'datakilde' });
            nodeForFelt.set(felt, node);

            let forelder = sekNode;
            if (felt?.Vises) {
                node.iLogikk = true;
                const styrende = felterIVilkar(felt.Vises, finnFelt);
                const enEneste = styrende.length === 1 && typeof styrende[0] === 'object' ? styrende[0] : null;
                const iSammeSeksjon = enEneste && (sek.Felter || []).indexOf(enEneste) > -1
                    && (sek.Felter || []).indexOf(enEneste) < (sek.Felter || []).indexOf(felt)
                    && nodeForFelt.has(enEneste);
                if (iSammeSeksjon) {
                    forelder = nodeForFelt.get(enEneste);
                    node.gren = `hvis ${tekst(felt.Vises, true)}`;
                    forelder.iLogikk = true;
                } else {
                    node.betingelse = `Vises hvis ${tekst(felt.Vises)}`;
                    for (const f of styrende) leggTilStyrer(f, id, `felt ${ref}`);
                }
            }
            forelder.barn.push(node);
        }
    });

    if (behandling.length) {
        const bNode = {
            id: 'behandling', slag: 'behandling', tittel: 'Behandling',
            merker: [{ tekst: `${behandling.length} steg`, klasse: 'fase' }], styrer: [], barn: [], iLogikk: true
        };
        const stegNoder = new Map();
        for (const steg of behandling) {
            const nr = Number(steg?.Steg);
            const id = `steg-${nr}`;
            const node = {
                id, slag: 'steg', ref: `Steg ${nr}`,
                tittel: kortTekst(steg?.Stegnavn, 60) || `Steg ${nr}`,
                merker: [], styrer: [], barn: [], iLogikk: true,
                behandlere: behandlere(steg)
            };
            if (String(steg?.Flyt_url || '').trim()) node.merker.push({ tekst: 'Ekstern flyt', klasse: 'flyt' });
            if (steg?.Beslutning_alle === true) node.merker.push({ tekst: 'Alle må avgjøre', klasse: 'annet' });
            if (Number(steg?.Frist?.Dager) > 0) node.merker.push({ tekst: `Frist ${Number(steg.Frist.Dager)} dager`, klasse: 'annet' });
            for (const v of (steg?.Beslutningsvalg || [])) {
                node.merker.push({ tekst: kortTekst(v?.Tekst, 30) || `Valg ${v?.Nummer}`, klasse: `valg-${typeFor(v)}` });
            }
            if (steg?.Vilkår) {
                node.betingelse = `Kjøres hvis ${tekst(steg.Vilkår)}`;
                for (const f of felterIVilkar(steg.Vilkår, finnFelt)) leggTilStyrer(f, id, `steg ${nr}`);
            }
            stegNoder.set(nr, { node, steg });
        }
        for (const [nr, { node, steg }] of stegNoder) {
            const avh = Number(steg?.AvhengigAv);
            const forelder = avh && avh !== nr && stegNoder.has(avh) ? stegNoder.get(avh).node : bNode;
            if (forelder !== bNode) node.gren = 'når ferdig';
            forelder.barn.push(node);
        }
        rot.barn.push(bNode);
    }

    for (const [felt, liste] of styrer) {
        const node = nodeForFelt.get(felt);
        if (!node) continue;
        // Det som alt henger rett under feltet, trenger ingen lenke dit.
        const underMeg = new Set(node.barn.map(b => b.id));
        node.styrer = liste.filter(s => !underMeg.has(s.id));
        node.iLogikk = true;
    }
    // En seksjon er med i den kompakte visningen når noe i den er det.
    const merk = (n) => {
        for (const b of n.barn) if (merk(b)) n.iLogikk = true;
        return n.iLogikk;
    };
    merk(rot);
    return rot;
}

/**
 * Treet som HTML. All tekst fra definisjonen går gjennom escapeHtml.
 *
 * `bareLogikk` tar bare med det som styrer eller styres. Det er en egen
 * tegning, ikke skjulte noder: strekene mellom søsken regnes av CSS ut fra
 * første og siste barn, og et skjult barn ville latt en strek henge løs.
 */
export function tilHtml(node, { bareLogikk = false } = {}) {
    const merker = (node.merker || []).map(m =>
        `<span class="merke ${escapeHtml(m.klasse)}">${escapeHtml(m.tekst)}</span>`).join('');
    const gren = node.gren ? `<div class="gren-tekst">${escapeHtml(node.gren)}</div>` : '';
    const betingelse = node.betingelse ? `<div class="betingelse">${escapeHtml(node.betingelse)}</div>` : '';
    const behandlere = node.behandlere?.length
        ? `<div class="behandlere">👤 ${escapeHtml(node.behandlere.join(', '))}</div>` : '';
    const styrer = node.styrer?.length
        ? `<div class="styrer">→ styrer ${node.styrer.map(s =>
            `<a href="#${escapeHtml(s.id)}">${escapeHtml(s.tekst)}</a>`).join(', ')}</div>` : '';
    const ref = node.ref ? `<span class="ref">${escapeHtml(node.ref)}</span>` : '';
    const boks = `<div class="node ${escapeHtml(node.slag)}" id="${escapeHtml(node.id)}">`
        + `${gren}<div class="tittel">${ref}${escapeHtml(node.tittel)}</div>`
        + `${merker ? `<div class="merker">${merker}</div>` : ''}${betingelse}${behandlere}${styrer}</div>`;
    const synlige = (node.barn || []).filter(b => !bareLogikk || b.iLogikk);
    const barn = synlige.length
        ? `<div class="barn">${synlige.map(b => tilHtml(b, { bareLogikk })).join('')}</div>` : '';
    return `<div class="gren">${boks}${barn}</div>`;
}
