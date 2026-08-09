/**
 * Registrer alle HTTP-funksjoner. Hver modul kaller app.http() ved require.
 * Legg til nye funksjoner her etter hvert som de bygges.
 */
require('./functions/ping');
require('./functions/hello-storage');
require('./functions/whoami');
require('./functions/skjematyper');
require('./functions/skjemaer');
require('./functions/vedlegg');
require('./functions/seed-eksempel');
require('./functions/postnumre');
require('./functions/roller');
require('./functions/refresh-fs');
require('./functions/varsling-diag');
require('./functions/datauttrekk');
require('./functions/pdf');
require('./functions/pb-token');
require('./functions/power-bi');

// Etter hvert:
// require('./functions/skjema');
// require('./functions/evaluering');
// require('./functions/skjemadefinisjon');
// require('./functions/token');
// require('./functions/vedlegg');
// require('./functions/datauttrekk');
// require('./functions/pdf');
// require('./functions/masterdata');
// require('./functions/rolle-admin');
// require('./functions/nokkel');
// require('./functions/logg');
// require('./functions/admin');
// require('./functions/refresh-fs');
