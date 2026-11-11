# Référence API & webhooks

> Lisez les contrats épinglés avant d’envoyer une requête.

## Deux frontières API distinctes

Core API 0.41.0 est le contrat de la console client. Agent API 0.5.0 est celui de l’agent locataire ; ses opérations et son authentification constituent une frontière distincte. Les deux utilisent OpenAPI 3.1.

La console utilise son transport Core authentifié. Elle n’appelle pas directement les fournisseurs d’identité, d’infrastructure ou les endpoints de contrôle locataires.

> Renseignez KODERA_CORE_API_BASE avec la vraie base Core terminant par /api/v1. Fournissez un token autorisé via votre propre session terminal. Cet exemple est copié, jamais exécuté ici.

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $KODERA_ACCESS_TOKEN" \
  --header "Accept: application/json" \
  "$KODERA_CORE_API_BASE/me"
```

## Statuts, problèmes et idempotence

Utilisez le schéma de réponse de chaque opération épinglée, dont application/problem+json lorsqu’il est déclaré. HTTP 401/403 n’est pas un succès hors ligne ; un 409 demande de lire la réponse réelle de l’opération.

Ne réessayez pas aveuglément les mutations. Conservez la même clé d’idempotence pour vérifier une attribution incertaine. L’endpoint instant-claim implémenté et le contrat généré demandent encore un rapprochement.

Les refus SDK incluent SIGNATURE_MISMATCH et TIMESTAMP_OUT_OF_RANGE. Ce sont des refus, jamais une invitation à affaiblir la vérification.

> Un service indisponible ou un 503 peut produire un aperçu local, jamais une fausse attribution Cloud.

## Séparer les octets du transport et l’autorité des événements

Vérifiez les octets bruts avant de parser ou normaliser le JSON. Toute modification du corps, même un espace, change sa signature. Liez secret, organisation et salon cible par une configuration serveur de confiance.

Les en-têtes de livraison et d’événement ne sont pas signés par le transcript SDK v1. Le routage signé dans le corps et la protection antirejeu du handler restent nécessaires.

> Le simulateur ci-dessous n’envoie aucune requête réseau, ne crée aucun webhook et ne conserve ni secret ni cache antirejeu.

## Sources

- [packages/api-contract/core-api.openapi.yaml](https://github.com/kodera-hq/kodera/blob/main/packages/api-contract/core-api.openapi.yaml)

- [packages/api-contract/agent-api.openapi.yaml](https://github.com/kodera-hq/kodera/blob/main/packages/api-contract/agent-api.openapi.yaml)

- [packages/extension-sdk/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/extension-sdk/README.md)
