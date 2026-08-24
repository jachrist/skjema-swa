/**
 * Klient mot Felles Studentsystem (FS) sin GraphQL-API.
 *
 * Autentisering: Basic auth (brukernavn + passord fra env).
 * Endepunkt: process.env.FS_API_URL.
 *
 * Eksponerer:
 *   hentTerminer(arstallBetegnelsePar)
 *   hentUndervisningsenheter(terminIder, sidestorrelse?, luTermin?)
 */

const FS_API_URL = process.env.FS_API_URL || 'https://api.fellesstudentsystem.no/graphql/';
const FS_API_USER = process.env.FS_API_USER || '';
const FS_API_PASSWORD = process.env.FS_API_PASSWORD || '';
const FS_EIER_ORG_KODE = process.env.FS_EIER_ORG_KODE || '1627';

function authHeader() {
    if (!FS_API_USER || !FS_API_PASSWORD) {
        throw new Error('FS_API_USER og/eller FS_API_PASSWORD mangler i env');
    }
    const token = Buffer.from(`${FS_API_USER}:${FS_API_PASSWORD}`).toString('base64');
    return `Basic ${token}`;
}

async function kallGraphQl(query, variables) {
    const respons = await fetch(FS_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader(),
            'Feature-Flags': 'beta,experimental'
        },
        body: JSON.stringify({ query, variables })
    });

    if (!respons.ok) {
        const tekst = await respons.text().catch(() => '');
        throw new Error(`FS GraphQL ${respons.status}: ${tekst.slice(0, 500)}`);
    }

    const data = await respons.json();
    if (data.errors && data.errors.length > 0) {
        throw new Error(`FS GraphQL errors: ${JSON.stringify(data.errors).slice(0, 500)}`);
    }
    return data.data;
}

/**
 * Hent FS-termin-IDer for en gitt liste av {arstall, betegnelse}-par.
 * Returnerer en Map: "{arstall}-{betegnelse}" → FS-id.
 */
async function hentTerminer(arstallBetegnelsePar) {
    const unikeArstall = [...new Set(arstallBetegnelsePar.map(p => p.arstall))];

    const query = `
        query Terminer($filter: QueryTerminerFilterInput!) {
            terminer(filter: $filter) {
                edges {
                    node {
                        id
                        arstall
                        betegnelse { kode }
                    }
                }
            }
        }
    `;

    const data = await kallGraphQl(query, {
        filter: {
            eierOrganisasjonskode: FS_EIER_ORG_KODE,
            arstall: unikeArstall
        }
    });

    const alle = (data.terminer?.edges || []).map(e => e.node);
    const map = new Map();
    for (const t of alle) {
        map.set(`${t.arstall}-${t.betegnelse?.kode}`, t.id);
    }

    const resultat = new Map();
    for (const par of arstallBetegnelsePar) {
        const n = `${par.arstall}-${par.betegnelse}`;
        if (map.has(n)) resultat.set(n, map.get(n));
    }
    return resultat;
}

/**
 * Hent alle undervisningsenheter for en eller flere terminer. Paginerer via cursor.
 *
 * Hvis luTermin ({arstall, terminbetegnelse}) er gitt, inkluderer spørringen
 * beskrivelsesavsnitt med tekstkategori "E-FHSLUB" (forventet læringsutbytte).
 */
async function hentUndervisningsenheter(terminIder, sidestorrelse = 200, luTermin = null) {
    const beskrivelseFelt = luTermin ? `
                        beskrivelsesavsnitt(
                            filter: {
                                tekstkategorikoder: "E-FHSLUB"
                                sprakkode6392: "NOR"
                                gjelderFraTerminer: [{arstall: ${Number(luTermin.arstall)}, terminbetegnelse: "${luTermin.terminbetegnelse}"}]
                            }
                        ) {
                            nodes { innhold }
                        }` : '';

    const query = `
        query Undervisningsenheter($terminer: [ID!]!, $first: Int!, $after: String, $eier: String!) {
            undervisningsenheter(
                filter: {
                    eierOrganisasjonskode: $eier
                    terminer: $terminer
                }
                first: $first
                after: $after
            ) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                    termin { arstall betegnelse { kode } }
                    emne {
                        kode
                        versjonskode
                        navnAlleSprak { nb }
                        campuser { campus { kode navnAlleSprak { nb } } }
                        studieprogramkoblinger {
                            studieprogram { kode navnAlleSprak { nb } }
                        }${beskrivelseFelt}
                    }
                    studieretter(first: 1000) {
                        totalCount
                        nodes {
                            student {
                                personProfil {
                                    navn { etternavn fornavn }
                                    institusjonsEpost
                                }
                            }
                        }
                    }
                    personroller {
                        nodes {
                            fsRolle { kode }
                            personProfil {
                                navn { fornavn etternavn }
                                institusjonsEpost
                            }
                        }
                    }
                }
            }
        }
    `;

    const alle = [];
    let cursor = '';
    let harMer = true;

    while (harMer) {
        const data = await kallGraphQl(query, {
            terminer: terminIder,
            first: sidestorrelse,
            after: cursor || null,
            eier: FS_EIER_ORG_KODE
        });
        const side = data.undervisningsenheter;
        alle.push(...(side?.nodes || []));
        harMer = side?.pageInfo?.hasNextPage === true;
        cursor = side?.pageInfo?.endCursor || '';
        if (harMer && !cursor) break;
    }
    return alle;
}

/**
 * Hent alle aktive klasser med kull og studenter. Paginerer via cursor.
 *
 * Feltvalg er begrenset til det som er verifisert mot FS 2026-08-17
 * (se docs/FILTERSTUDENT-SPEC.md §6):
 *   - klasse.navnAlleSprak.und   — klassenavnet ligger under "und", ikke "nb"
 *   - kull.navnAlleSprak.no      — kullnavnet under "no"
 *   - betegnelse.kode            — gir "HØST" (navnAlleSprak.nb gir "Høst",
 *                                  som ikke matcher terminer.kortKode)
 *
 * studenterIKlasse MÅ ha «first» — uten den avkorter FS stille ved 10.
 */
async function hentKlasser(sidestorrelse = 50, studenterPerKlasse = 1000) {
    const query = `
        query Klasser($first: Int!, $after: String, $studFirst: Int!, $eier: String!) {
            klasser(
                filter: { eierOrganisasjonskode: $eier, erAktiv: true }
                first: $first
                after: $after
            ) {
                pageInfo { hasNextPage endCursor }
                nodes {
                    kode
                    navnAlleSprak { und }
                    kull {
                        terminV2 { arstall betegnelse { kode } }
                        navnAlleSprak { no }
                    }
                    studenterIKlasse(first: $studFirst) {
                        totalCount
                        nodes {
                            programStudierett {
                                studieprogram { kode navnAlleSprak { nb } }
                                student {
                                    personProfil {
                                        navn { fornavn etternavn }
                                        institusjonsEpost
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    const alle = [];
    let cursor = '';
    let harMer = true;

    while (harMer) {
        const data = await kallGraphQl(query, {
            first: sidestorrelse,
            after: cursor || null,
            studFirst: studenterPerKlasse,
            eier: FS_EIER_ORG_KODE
        });
        const side = data.klasser;
        alle.push(...(side?.nodes || []));
        harMer = side?.pageInfo?.hasNextPage === true;
        cursor = side?.pageInfo?.endCursor || '';
        if (harMer && !cursor) break;
    }
    return alle;
}

module.exports = {
    hentTerminer,
    hentUndervisningsenheter,
    hentKlasser,
    // Kun for diagnose-endepunktet, som prøver ulike filtervarianter for å
    // finne ut hvorfor et felt kommer tomt tilbake.
    kallGraphQl
};
