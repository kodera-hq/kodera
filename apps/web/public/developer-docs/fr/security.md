# Architecture & sécurité

> Comprenez ce qui existe, ce qui est borné et ce qui reste à intégrer.

## Identité et politique des salons

Un émetteur OIDC externe de type Keycloak peut fournir l’identité. L’assurance WebAuthn/hwk relève de la politique d’identité configurée, jamais d’un badge ou d’une assertion locale de l’interface. Community ne fournit pas de fournisseur d’identité.

synapse-policy 0.1.8 applique la politique de salon configurée avec le service room-access. Les appartenances authentifiées et les droits viennent du plan de contrôle ; les aperçus locaux n’en accordent aucun.

> Les clients et le SDK utilisent Apache-2.0 ; le serveur et la politique Synapse utilisent AGPL-3.0-or-later. Enterprise Edition dispose d’une licence commerciale distincte.

## Codecs Rust, audio et proximité

kodera-rs fournit identifiants, métadonnées natives bornées, codecs de trame signée ProximityFrame v1 et balises de découverte rotatives v2 de 27 octets, ainsi que les moteurs optionnels OpenMLS/Megolm/passkeys et les bindings navigateur wasm32. Les audits publics vérifient les signatures Ed25519 v1 et les tags HMAC-SHA256 v2 ; aucun ne prouve appartenance, distance ou disponibilité radio, et le TTL v1 n’est pas signé par conception.

La synthèse sonore Web définit SYNTH_SAMPLE_RATE = 48000. Cela ne prouve pas l’existence d’un moteur DSP Rust livré ou d’un provider audio matériel natif. Les moteurs crypto natifs/wasm32 optionnels et les interfaces matérielles ne doivent pas être présentés comme un relais E2EE actif, un trousseau système ou une intégration radio achevée.

> Cette référence n’active ni radio BLE, ni chiffrement média de bout en bout, ni garantie de service d’urgence.

## Métadonnées de thème portables

kodera-theme:v1: est un format de partage de thème borné à 2048 octets UTF-8 dans le codec natif. Son base64 canonique encode un schéma JSON strict à cinq valeurs RGB, avec quatre préréglages.

Un code thème transporte des métadonnées visuelles. Le base64 n’est pas du chiffrement ; n’y placez ni secret ni revendication de droits. Les aperçus natifs de profil et d’IAM ne sont pas des droits authentifiés.

> Seuls les exemples de configuration appartiennent au contrôle de version. Ne commitez jamais de secrets d’environnement, clés privées ou identifiants locataires réels.

## Sources

- [ARCHITECTURE.md](https://github.com/kodera-hq/kodera/blob/main/ARCHITECTURE.md)

- [packages/kodera-rs/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/kodera-rs/README.md)

- [packages/kodera-rs/docs/native-crypto.md](https://github.com/kodera-hq/kodera/blob/main/packages/kodera-rs/docs/native-crypto.md)

- [packages/synapse-policy/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/synapse-policy/README.md)

- [apps/web/src/features/sounds/synth.ts](https://github.com/kodera-hq/kodera/blob/main/apps/web/src/features/sounds/synth.ts)
