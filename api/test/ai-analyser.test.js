/**
 * AI-importen: modellvalget og lesingen av svaret.
 *
 * To feil fra 29.10.2026, som lå oppå hverandre:
 *
 *   **Modell-ID-en fantes ikke.** `claude-sonnet-5-20260201` ga 404
 *   not_found_error fra Anthropic. Modell-ID-ene har ingen datosuffiks.
 *   `config/env.prod.json` satte den samme ugyldige verdien, så å rette bare
 *   koden ville latt prod stå igjen med feilen.
 *
 *   **Svaret ble lest som `content[0].text`.** Med tenkning på — standard når
 *   `thinking` utelates — er første blokk en `thinking`-blokk uten `text`.
 *   Analysen ville da feilet med «Ingen JSON» på et svar som var i orden, så
 *   snart modell-ID-en var rettet.
 *
 * Kjøres med:  node api/test/ai-analyser.test.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ekte = Module._load;
Module._load = function (forespurt, ...rest) {
    if (forespurt === '@azure/functions') return { app: { http() {} } };
    return ekte.call(this, forespurt, ...rest);
};
let modul;
try {
    modul = require('../src/functions/ai-analyser');
} finally {
    Module._load = ekte;
}

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const lesSvar = modul._lesSvar;
sjekk('ai-analyser eksporterer lesSvar', typeof lesSvar, 'function');

// ---------- 1. modellvalget ----------
{
    const modell = modul._DEFAULT_MODELL;
    sjekk('modell-ID-en har ingen datosuffiks', /-\d{8}$/.test(modell), false);
    sjekk('modell-ID-en er en Claude-modell', /^claude-/.test(modell), true);

    // Inventaret for prod setter verdien eksplisitt. De to skal ikke kunne
    // drive fra hverandre — det var slik prod ble stående med en modell som
    // ikke fantes.
    const prod = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'env.prod.json'), 'utf8'));
    const iProd = prod.ANTHROPIC_MODELL && prod.ANTHROPIC_MODELL.value;
    if (iProd !== undefined) sjekk('env.prod.json setter samme modell som koden', iProd, modell);
}

// ---------- 2. svaret leses fra text-blokkene ----------
{
    // Den ekte formen med tenkning på: thinking-blokk først, tom med
    // display «omitted».
    const medTenkning = {
        content: [
            { type: 'thinking', thinking: '', signature: 'abc' },
            { type: 'text', text: '{"Skjema_navn":"X","Seksjoner":[]}' }
        ],
        stop_reason: 'end_turn'
    };
    sjekk('teksten hentes forbi thinking-blokken',
        lesSvar(medTenkning).tekst, '{"Skjema_navn":"X","Seksjoner":[]}');
    sjekk('og et vanlig svar har ingen feil', lesSvar(medTenkning).feil, null);

    // Flere text-blokker settes sammen i rekkefølge.
    sjekk('flere text-blokker settes sammen',
        lesSvar({ content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], stop_reason: 'end_turn' }).tekst,
        '{"a":1}');

    sjekk('uten content blir teksten tom', lesSvar({}).tekst, '');
    sjekk('og feil er satt til null, ikke borte', 'feil' in lesSvar({}), true);
}

// ---------- 3. avvist og kuttet sier fra ----------
{
    const avvist = lesSvar({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } });
    sjekk('refusal gir en feil som sier det', /avviste/.test(avvist.feil || ''), true);
    sjekk('og kategorien står med', /cyber/.test(avvist.feil || ''), true);

    const kuttet = lesSvar({ content: [{ type: 'text', text: '{"Skjema_navn":' }], stop_reason: 'max_tokens' });
    sjekk('max_tokens gir en feil som sier det', /max_tokens/.test(kuttet.feil || ''), true);
    sjekk('og grensen står med', (kuttet.feil || '').includes(String(modul._MAKS_TOKENS)), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
