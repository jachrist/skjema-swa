/**
 * Later som `node_modules` ikke finnes.
 *
 * Lastes med `node --require` foran en testfil. Enhver `require` av en
 * npm-pakke kaster; relative stier, absolutte stier og innebygde moduler
 * slipper gjennom.
 *
 * Hvorfor: deploy-steget kjører testene UTEN `npm ci`, fordi de skal være
 * raske og fordi Azure-SDK-ene lastes lat. En test som likevel drar inn en
 * pakke, feiler først i deployen — og stopper utrullingen. Det skjedde
 * 31.08.2026 og holdt to commits tilbake. Med denne kjøres samme betingelse
 * lokalt og i CI, der den koster sekunder i stedet for en feilsøkingsrunde.
 *
 * Trenger en test en pakke for å dekke noe ekte (som jszip i
 * backup-strom.test.js), skal den fange feilen og hoppe over den delen —
 * ikke kreve pakken.
 */
const Module = require('module');
const path = require('path');

const origLoad = Module._load;
const erSti = (r) => r.startsWith('.') || path.isAbsolute(r);
const erInnebygd = (r) => Module.builtinModules.includes(r.replace(/^node:/, ''));

Module._load = function (req, ...rest) {
    if (!erSti(req) && !erInnebygd(req)) {
        const e = new Error(
            `Testen krever npm-pakken '${req}', men deploy kjører testene uten node_modules. ` +
            `Gjør avhengigheten valgfri (try/catch rundt require, og hopp over den delen), ` +
            `eller stub den ut. Se scripts/uten-node-modules.js.`
        );
        e.code = 'MODULE_NOT_FOUND';
        throw e;
    }
    return origLoad.call(this, req, ...rest);
};
