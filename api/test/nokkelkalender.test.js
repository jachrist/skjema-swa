/**
 * Tester for nøkkelkalenderens logikk. Kjøres med:
 *   node api/test/nokkelkalender.test.js
 */
const k = require('../src/lib/nokkelkalender-storage');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) { ok++; }
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

// ---------- utlopFraSas ----------
const ekte = 'BlobEndpoint=https://stfhsskjemapilot.blob.core.windows.net/;QueueEndpoint=https://x.queue.core.windows.net/;'
    + 'FileEndpoint=https://x.file.core.windows.net/;TableEndpoint=https://stfhsskjemapilot.table.core.windows.net/;'
    + 'SharedAccessSignature=sv=2026-02-06&ss=bfqt&srt=sco&sp=rwdlacuytfx&se=2027-05-01T04:31:01Z&st=2026-08-27T20:16:01Z&spr=https';
sjekk('SAS fra portalen', k.utlopFraSas(ekte), '2027-05-01T04:31:01.000Z');
sjekk('se= først i signaturen',
    k.utlopFraSas('TableEndpoint=https://x/;SharedAccessSignature=se=2027-01-02T03:04:05Z&sp=rl'),
    '2027-01-02T03:04:05.000Z');
sjekk('URL-kodet dato',
    k.utlopFraSas('SharedAccessSignature=sv=1&se=2027-05-01T04%3A31%3A01Z&sp=rl'),
    '2027-05-01T04:31:01.000Z');
sjekk('kontonøkkel har ingen se=',
    k.utlopFraSas('DefaultEndpointsProtocol=https;AccountName=fhsskjemadev;AccountKey=abc123==;EndpointSuffix=core.windows.net'),
    null);
sjekk('tom verdi', k.utlopFraSas(''), null);
sjekk('ikke lokket av response=',
    k.utlopFraSas('https://flyt.example.com/x?api-version=1&response=2&sig=abc'), null);
sjekk('ugyldig dato i se=', k.utlopFraSas('SharedAccessSignature=sv=1&se=tull&sp=rl'), null);

// ---------- normaliserDato ----------
sjekk('bare dato → slutten av dagen', k.normaliserDato('2027-05-01'), '2027-05-01T23:59:59.999Z');
sjekk('tom streng', k.normaliserDato(''), '');
sjekk('31. februar avvises', k.normaliserDato('2027-02-31'), null);
sjekk('full ISO beholdes', k.normaliserDato('2027-05-01T04:31:01Z'), '2027-05-01T04:31:01.000Z');
// Den viktigste: V8 tolker dette som 2001-09-01 uten å klage, og en dato
// 25 år bakover ville meldt hemmeligheten som utløpt for lengst.
sjekk('«1. september» avvises', k.normaliserDato('1. september'), null);
sjekk('«mai 2027» avvises', k.normaliserDato('mai 2027'), null);
sjekk('01.05.2027 avvises', k.normaliserDato('01.05.2027'), null);

// ---------- varslingsTrinn ----------
sjekk('60 dagers varsel, 70 igjen → for tidlig', k.varslingsTrinn(70, 60), null);
sjekk('60 dagers varsel, 60 igjen → trinn 60', k.varslingsTrinn(60, 60), 60);
sjekk('60 dagers varsel, 20 igjen → står fortsatt på 60', k.varslingsTrinn(20, 60), 60);
sjekk('60 dagers varsel, 14 igjen → trinn 14', k.varslingsTrinn(14, 60), 14);
sjekk('60 dagers varsel, 5 igjen → trinn 7', k.varslingsTrinn(5, 60), 7);
sjekk('60 dagers varsel, 2 igjen → trinn 3', k.varslingsTrinn(2, 60), 3);
sjekk('60 dagers varsel, 0 igjen → trinn 1', k.varslingsTrinn(0, 60), 1);
sjekk('utløpt → trinn 0', k.varslingsTrinn(-3, 60), 0);
sjekk('ingen dato → null', k.varslingsTrinn(null, 60), null);
sjekk('30 dagers varsel, 45 igjen → for tidlig', k.varslingsTrinn(45, 30), null);
sjekk('lavt varsel (3), 10 igjen → for tidlig', k.varslingsTrinn(10, 3), null);
sjekk('lavt varsel (3), 2 igjen → trinn 3', k.varslingsTrinn(2, 3), 3);
sjekk('lavt varsel (3), 1 igjen → trinn 1', k.varslingsTrinn(1, 3), 1);

// ---------- tilstand ----------
sjekk('utløpt', k.tilstand(-1, 'ja'), 'utløpt');
sjekk('kritisk ved 7', k.tilstand(7, 'ja'), 'kritisk');
sjekk('snart ved 8', k.tilstand(8, 'ja'), 'snart');
sjekk('snart ved 30', k.tilstand(30, 'ja'), 'snart');
sjekk('ok ved 31', k.tilstand(31, 'ja'), 'ok');
sjekk('uten dato → ukjent', k.tilstand(null, 'ja'), 'ukjent');
sjekk('skal ikke roteres → fast', k.tilstand(3, 'nei'), 'fast');

// ---------- skalVarsles ----------
const na = new Date('2026-09-01T08:00:00Z');
const rad = (o) => ({ Roteres: 'ja', VarsleDagerFor: 30, SistVarslet: '', SistVarsletTrinn: null, ...o });

sjekk('for tidlig', k.skalVarsles(rad({ DagerIgjen: 45 }), na), null);
sjekk('første varsel på 30', k.skalVarsles(rad({ DagerIgjen: 28 }), na), 30);
sjekk('ikke på nytt samme trinn',
    k.skalVarsles(rad({ DagerIgjen: 20, SistVarsletTrinn: 30 }), na), null);
sjekk('eskalerer til 14',
    k.skalVarsles(rad({ DagerIgjen: 12, SistVarsletTrinn: 30 }), na), 14);
sjekk('eskalerer til 7',
    k.skalVarsles(rad({ DagerIgjen: 6, SistVarsletTrinn: 14 }), na), 7);
sjekk('hopper rett til 1 hvis jobben ikke kjørte',
    k.skalVarsles(rad({ DagerIgjen: 1, SistVarsletTrinn: 30 }), na), 1);
sjekk('«skal ikke roteres» varsles aldri',
    k.skalVarsles(rad({ DagerIgjen: -5, Roteres: 'nei' }), na), null);
sjekk('uten dato varsles ikke', k.skalVarsles(rad({ DagerIgjen: null }), na), null);
sjekk('utløpt varsles',
    k.skalVarsles(rad({ DagerIgjen: -2, SistVarsletTrinn: 1 }), na), 0);
sjekk('utløpt varsles daglig, men ikke to ganger samme dag',
    k.skalVarsles(rad({ DagerIgjen: -2, SistVarsletTrinn: 0, SistVarslet: '2026-09-01T07:00:00Z' }), na), null);
sjekk('utløpt varsles igjen dagen etter',
    k.skalVarsles(rad({ DagerIgjen: -2, SistVarsletTrinn: 0, SistVarslet: '2026-08-31T07:00:00Z' }), na), 0);

// ---------- slug ----------
sjekk('slug med norske tegn', k.slug('Nøkkel for FS-pålogging'), 'nøkkel-for-fs-pålogging');
sjekk('slug uten skilletegn på kantene', k.slug('  (SAS) — TODO!  '), 'sas-todo');
sjekk('tomt navn', k.slug(''), 'uten-navn');
sjekk('slug er stabil for standardinventaret',
    k.STANDARD.map(m => k.slug(m.Navn)).length === new Set(k.STANDARD.map(m => k.slug(m.Navn))).size, true);

// ---------- dagerTil ----------
sjekk('dagerTil framover', k.dagerTil('2026-09-11T08:00:00Z', na), 10);
sjekk('dagerTil bakover', k.dagerTil('2026-08-30T08:00:00Z', na), -2);
sjekk('dagerTil uten dato', k.dagerTil('', na), null);

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
