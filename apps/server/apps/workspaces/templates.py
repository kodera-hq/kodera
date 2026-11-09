"""Official industry workspace templates for Kodera onboarding and warm-pool claim."""

from dataclasses import dataclass

from .models import TEMPLATE_KEY, Channel


class UnknownWorkspaceTemplateError(ValueError):
    """Raised when a requested workspace template identifier is not in the official catalogue."""

    def __init__(self, template_id: str) -> None:
        super().__init__(f"unknown workspace template: {template_id}")
        self.template_id = template_id


@dataclass(frozen=True, slots=True)
class CategoryBlueprint:
    key: str
    name: str

    @property
    def db_template_key(self) -> str:
        """Database-safe template_key conforming to models.TEMPLATE_KEY."""
        return self.key.replace("-", "_")


@dataclass(frozen=True, slots=True)
class ChannelBlueprint:
    category_key: str
    template_key: str
    name: str
    kind: str
    topic: str = ""

    @property
    def db_template_key(self) -> str:
        """Database-safe template_key conforming to models.TEMPLATE_KEY."""
        return self.template_key.replace("-", "_")


@dataclass(frozen=True, slots=True)
class WorkspaceTemplate:
    id: str
    label_fr: str
    categories: tuple[CategoryBlueprint, ...]
    channels: tuple[ChannelBlueprint, ...]
    default_connectors: tuple[str, ...]
    recommended_roles: tuple[str, ...]
    default_theme_id: str


TEMPLATES: dict[str, WorkspaceTemplate] = {
    "audiovisual-production": WorkspaceTemplate(
        id="audiovisual-production",
        label_fr="Société de production audiovisuelle",
        categories=(
            CategoryBlueprint("production", "Production & Tournage"),
            CategoryBlueprint("post-production", "Post-Production & Rushes"),
            CategoryBlueprint("plateaux", "Plateaux & Salles Vocales"),
        ),
        channels=(
            ChannelBlueprint(
                "production",
                "production",
                "production",
                Channel.Kind.TEXT,
                "Coordination générale des projets et plannings de production",
            ),
            ChannelBlueprint(
                "production",
                "tournage",
                "tournage",
                Channel.Kind.TEXT,
                "Feuilles de service, repérages et logistique plateau",
            ),
            ChannelBlueprint(
                "post-production",
                "post-production",
                "post-production",
                Channel.Kind.TEXT,
                "Montage, étalonnage, mixage et validations Frame.io",
            ),
            ChannelBlueprint(
                "post-production",
                "dailies-rushes",
                "dailies-rushes",
                Channel.Kind.TEXT,
                "Retours quotidiens sur les rushes et notes timecodées",
            ),
            ChannelBlueprint(
                "plateaux",
                "plateau-regie",
                "plateau-regie",
                Channel.Kind.AUDIO,
                "Canal vocal direct plateau et régie",
            ),
            ChannelBlueprint(
                "plateaux",
                "salle-montage",
                "salle-montage",
                Channel.Kind.AUDIO,
                "Session vocale de revue montage et post-production",
            ),
        ),
        default_connectors=("frameio-review-bridge", "nextcloud-drive-notifier"),
        recommended_roles=(
            "Producteur",
            "Réalisateur",
            "post-production",
            "Superviseur VFX/Son",
        ),
        default_theme_id="real-black",
    ),
    "tech-studio": WorkspaceTemplate(
        id="tech-studio",
        label_fr="Studio Tech & Produit",
        categories=(
            CategoryBlueprint("general", "Général"),
            CategoryBlueprint("engineering", "Ingénierie & Produit"),
            CategoryBlueprint("voice", "Salons Vocaux"),
        ),
        channels=(
            ChannelBlueprint(
                "general",
                "general",
                "general",
                Channel.Kind.TEXT,
                "Annonces d'équipe et coordination quotidienne",
            ),
            ChannelBlueprint(
                "engineering",
                "releases",
                "releases",
                Channel.Kind.TEXT,
                "Suivi des déploiements, changelogs et mises en production",
            ),
            ChannelBlueprint(
                "engineering",
                "incidents",
                "incidents",
                Channel.Kind.TEXT,
                "Gestion des alertes de production et post-mortems",
            ),
            ChannelBlueprint(
                "voice",
                "standup",
                "standup",
                Channel.Kind.AUDIO,
                "Point quotidien d'équipe à faible latence",
            ),
            ChannelBlueprint(
                "voice",
                "pairing",
                "pairing",
                Channel.Kind.AUDIO,
                "Session vocale de pair-programming et revue de code",
            ),
        ),
        default_connectors=("github-webhook", "linear-sync", "sentry-alerts"),
        recommended_roles=("Lead Tech", "Product", "SRE", "Security"),
        default_theme_id="ardoise",
    ),
    "b2b-advisory": WorkspaceTemplate(
        id="b2b-advisory",
        label_fr="Cabinet & Conseil B2B",
        categories=(
            CategoryBlueprint("cabinet", "Vie du Cabinet"),
            CategoryBlueprint("missions", "Missions & Livrables"),
            CategoryBlueprint("salles", "Salles de Réunion"),
        ),
        channels=(
            ChannelBlueprint(
                "cabinet",
                "general",
                "general",
                Channel.Kind.TEXT,
                "Coordination interne du cabinet et annonces",
            ),
            ChannelBlueprint(
                "missions",
                "missions-clients",
                "missions-clients",
                Channel.Kind.TEXT,
                "Suivi des mandats, cadrages et comités de pilotage",
            ),
            ChannelBlueprint(
                "missions",
                "livrables",
                "livrables",
                Channel.Kind.TEXT,
                "Revue des rapports, synthèses et propositions commerciales",
            ),
            ChannelBlueprint(
                "salles",
                "salle-associes",
                "salle-associes",
                Channel.Kind.AUDIO,
                "Salle vocale des associés et directeurs",
            ),
            ChannelBlueprint(
                "salles",
                "point-client",
                "point-client",
                Channel.Kind.AUDIO,
                "Pont audio pour réunions et restitutions",
            ),
        ),
        default_connectors=(
            "qonto-treasury-alerts",
            "stripe-revenue-events",
            "calcom-booking-sync",
        ),
        recommended_roles=("Associé", "Directeur de mission", "Consultant", "Finance"),
        default_theme_id="givre",
    ),
    "public-sector": WorkspaceTemplate(
        id="public-sector",
        label_fr="Collectivité & Secteur Public",
        categories=(
            CategoryBlueprint("collectivite", "Services & Direction"),
            CategoryBlueprint("deliberations", "Projets & Délibérations"),
            CategoryBlueprint("permanence", "Permanence Vocale"),
        ),
        channels=(
            ChannelBlueprint(
                "collectivite",
                "accueil",
                "accueil",
                Channel.Kind.TEXT,
                "Informations générales des agents et de la direction",
            ),
            ChannelBlueprint(
                "collectivite",
                "services-generaux",
                "services-generaux",
                Channel.Kind.TEXT,
                "Coordination inter-services et logistique",
            ),
            ChannelBlueprint(
                "deliberations",
                "deliberations",
                "deliberations",
                Channel.Kind.TEXT,
                "Préparation des dossiers, arrêtés et séances",
            ),
            ChannelBlueprint(
                "permanence",
                "salle-du-conseil",
                "salle-du-conseil",
                Channel.Kind.AUDIO,
                "Salle vocale pour réunions de direction et commissions",
            ),
            ChannelBlueprint(
                "permanence",
                "permanence",
                "permanence",
                Channel.Kind.AUDIO,
                "Canal vocal d'astreinte et de continuité de service",
            ),
        ),
        default_connectors=("nextcloud-drive-notifier",),
        recommended_roles=("Direction", "Secrétariat général", "Agent", "Astreinte"),
        default_theme_id="givre",
    ),
    "crisis-cell": WorkspaceTemplate(
        id="crisis-cell",
        label_fr="Cellule de Crise & Sécurité",
        categories=(
            CategoryBlueprint("commandement", "Commandement & Veille"),
            CategoryBlueprint("operations", "Opérations Terrain"),
            CategoryBlueprint("ponts", "Ponts Audio Tactiques"),
        ),
        channels=(
            ChannelBlueprint(
                "commandement",
                "commandement",
                "commandement",
                Channel.Kind.TEXT,
                "Décisions de cellule, points de situation et arbitrages",
            ),
            ChannelBlueprint(
                "operations",
                "journal-operations",
                "journal-operations",
                Channel.Kind.TEXT,
                "Main courante horodatée des actions engagées",
            ),
            ChannelBlueprint(
                "commandement",
                "veille-menaces",
                "veille-menaces",
                Channel.Kind.TEXT,
                "Signaux d'alerte, indicateurs et suivi SOC",
            ),
            ChannelBlueprint(
                "ponts",
                "pont-commandement",
                "pont-commandement",
                Channel.Kind.AUDIO,
                "Pont vocal permanent du poste de commandement",
            ),
            ChannelBlueprint(
                "ponts",
                "canal-tactique",
                "canal-tactique",
                Channel.Kind.AUDIO,
                "Canal audio d'intervention rapide des équipes terrain",
            ),
        ),
        default_connectors=("sentry-alerts", "github-webhook"),
        recommended_roles=(
            "Commandant d'incident",
            "Opérateur SOC",
            "Coordinateur terrain",
            "Communication",
        ),
        default_theme_id="real-black",
    ),
}


def resolve_template(template_id: str) -> WorkspaceTemplate:
    """Return the official WorkspaceTemplate for `template_id` or raise UnknownWorkspaceTemplateError."""
    if not isinstance(template_id, str) or template_id not in TEMPLATES:
        raise UnknownWorkspaceTemplateError(str(template_id))
    return TEMPLATES[template_id]


def list_templates() -> list[WorkspaceTemplate]:
    """Return the ordered catalogue of official workspace templates."""
    return list(TEMPLATES.values())


__all__ = [
    "TEMPLATE_KEY",
    "TEMPLATES",
    "CategoryBlueprint",
    "ChannelBlueprint",
    "UnknownWorkspaceTemplateError",
    "WorkspaceTemplate",
    "list_templates",
    "resolve_template",
]
