from django.db import models
from django.db.models import Q


class ProjectManager(models.Manager):
    def active(self):
        return self.filter(is_active=True)

    def for_user(self, user):
        # Projects the user owns OR is a member of (RBAC collaboration).
        return self.active().filter(Q(owner=user) | Q(members__user=user)).distinct()


class AppManager(models.Manager):
    def active(self):
        return self.filter(is_active=True)

    def for_project(self, project):
        return self.active().filter(project=project)

    def for_user(self, user):
        """Query apps through project relationship."""
        return self.active().filter(project__owner=user)


class EndpointManager(models.Manager):
    def active(self):
        return self.filter(is_active=True)

    def for_app(self, app):
        return self.active().filter(app=app)


class EnvironmentManager(models.Manager):
    def active(self):
        return self.filter(is_active=True)

    def for_app(self, app):
        return self.active().filter(app=app)
