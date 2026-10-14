#!/usr/bin/env bash
#
# Steg 1 i docs/BESLUTNING-EGEN-FUNCTION-APP.md: oppretter en Function App og
# lenker den til en Static Web App, slik at ett spørsmål kan besvares —
#
#     Sender SWA x-ms-client-principal videre til en lenket backend?
#
# Svaret avgjør hele forslaget om å flytte API-et ut av SWA Managed Functions.
# Gjør den det ikke, stopper det der, og da rives alt dette ned igjen.
#
# LES SKRIPTET FØR DU KJØRER DET. Det oppretter ressurser og tildeler roller
# i abonnementet ditt. Ingenting her er destruktivt, men alt koster og alt
# etterlater spor.
#
# Krever: az CLI, innlogget (`az login`), og rett til å opprette ressurser og
# tildele roller i ressursgruppa. Rolletildeling krever «User Access
# Administrator» eller «Owner» — har du det ikke, stopper skriptet der og sier
# fra, og resten må gjøres av en som har det.
#
# Bruk:
#   scripts/steg1-funcapp.sh                 # viser hva den ville gjort
#   KJOER=ja scripts/steg1-funcapp.sh        # gjør det
set -euo pipefail

# ─── fyll ut ────────────────────────────────────────────────────────────────
RG="${RG:-}"                      # ressursgruppa SWA-en ligger i
STED="${STED:-norwayeast}"        # samme region som SWA-en
SWA="${SWA:-}"                    # navnet på Static Web App-en (pilot)
FUNCAPP="${FUNCAPP:-}"            # navnet den nye Function App-en skal ha
LAGRING="${LAGRING:-}"            # lagringskontoen Function App-en trenger for seg selv
KEYVAULT="${KEYVAULT:-}"          # miljøets Key Vault, f.eks. kv-fhsskjema-pilot
DATALAGRING="${DATALAGRING:-}"    # lagringskontoen MED DATAENE (tabeller og blob)
# ────────────────────────────────────────────────────────────────────────────

KJOER="${KJOER:-nei}"

mangler=()
for v in RG SWA FUNCAPP LAGRING KEYVAULT DATALAGRING; do
    [ -z "${!v}" ] && mangler+=("$v")
done
if [ ${#mangler[@]} -gt 0 ]; then
    echo "Fyll ut, eller sett som miljøvariabler: ${mangler[*]}" >&2
    exit 1
fi

kjør() {
    if [ "$KJOER" = "ja" ]; then
        echo "→ $*"
        "$@"
    else
        echo "   $*"
    fi
}

if [ "$KJOER" != "ja" ]; then
    echo "TØRRKJØRING — ingenting gjøres. Sett KJOER=ja for å utføre."
    echo
fi

echo "== 1. Lagringskonto til Function App-en selv =="
# Function App-runtime trenger sin egen konto til tilstand og låser. Den skal
# IKKE være den samme som bærer dataene — en feil der blander driftsartefakter
# inn i tabellene som backupen tar.
kjør az storage account create \
    --name "$LAGRING" --resource-group "$RG" --location "$STED" \
    --sku Standard_LRS --allow-blob-public-access false --min-tls-version TLS1_2

echo
echo "== 2. Function App, Node 22, Linux =="
kjør az functionapp create \
    --name "$FUNCAPP" --resource-group "$RG" --storage-account "$LAGRING" \
    --consumption-plan-location "$STED" --runtime node --runtime-version 22 \
    --functions-version 4 --os-type Linux

echo
echo "== 3. System-assigned managed identity =="
kjør az functionapp identity assign --name "$FUNCAPP" --resource-group "$RG"

echo
echo "== 4. Rolletildelinger =="
echo "   (krever User Access Administrator eller Owner)"
if [ "$KJOER" = "ja" ]; then
    PRINCIPAL=$(az functionapp identity show --name "$FUNCAPP" --resource-group "$RG" --query principalId -o tsv)
    SUB=$(az account show --query id -o tsv)
    echo "   identitet: $PRINCIPAL"
else
    PRINCIPAL='<identitetens principalId>'
    SUB='<abonnements-id>'
fi
for rolle in "Storage Table Data Contributor" "Storage Blob Data Contributor"; do
    kjør az role assignment create --assignee "$PRINCIPAL" --role "$rolle" \
        --scope "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$DATALAGRING"
done
kjør az role assignment create --assignee "$PRINCIPAL" --role "Key Vault Secrets User" \
    --scope "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.KeyVault/vaults/$KEYVAULT"

echo
echo "== 5. App settings =="
# Steg 1 deployer UENDRET kode, og den leser fortsatt connection string. Den
# settes derfor som i dag. Å legge om til managed identity er steg 3, og
# gjøres først når steg 1 og 2 har svart.
echo "   Kopier app settings fra SWA-en manuelt, eller sett dem her."
echo "   MERK: 'az staticwebapp appsettings list' skriver hemmeligheter i klartekst"
echo "         til terminalen. Ikke lim utdata derfra inn i en sak, en e-post"
echo "         eller et chatvindu."
echo "   az functionapp config appsettings set --name $FUNCAPP --resource-group $RG --settings MILJO=pilot"

echo
echo "== 6. Lenk Function App-en til SWA-en =="
echo "   ADVARSEL: dette ERSTATTER de managed functions SWA-en kjører i dag."
echo "   Trafikk til /api/* går til Function App-en fra dette øyeblikket."
echo "   Angre med:  az staticwebapp backends unlink --name $SWA --resource-group $RG"
echo "               og deretter en ny ordinær deploy fra deploy-pilot.yml."
if [ "$KJOER" = "ja" ]; then
    FUNC_ID=$(az functionapp show --name "$FUNCAPP" --resource-group "$RG" --query id -o tsv)
else
    FUNC_ID='<Function App-ens resource id>'
fi
kjør az staticwebapp backends link --name "$SWA" --resource-group "$RG" \
    --backend-resource-id "$FUNC_ID" --backend-region "$STED"

echo
cat <<'SLUTT'
== Deretter ==

1. Kjør .github/workflows/deploy-funcapp-pilot.yml manuelt, med navnet på
   Function App-en. Den krever secreten AZURE_FUNCAPP_CREDENTIALS i
   miljøet — se docs/BESLUTNING-EGEN-FUNCTION-APP.md.

2. Svar på spørsmålet:

       curl -s https://<swa-url>/api/ping | jq .

   Uinnlogget skal `principal.headerMottatt` være false. Logg deretter inn i
   nettleseren og åpne /api/ping der.

   headerMottatt: true, harUpn: true   → forslaget holder, gå til steg 2
   headerMottatt: false                → SWA sender den ikke videre.
                                         Forslaget stopper her.
   headerMottatt: true, harUpn: false  → den kommer, men er tom. Noter
                                         merknaden og undersøk videre.

3. Uansett utfall: skriv svaret inn i beslutningsnotatet, med dato.
SLUTT
