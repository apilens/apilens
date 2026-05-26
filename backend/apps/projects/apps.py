from django.apps import AppConfig


class ProjectsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.projects"
    label = "projects"

    def ready(self):
        # Wire signal handlers (cascade-delete for uploaded files).
        from . import signals  # noqa: F401

