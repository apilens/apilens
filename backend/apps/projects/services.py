import logging

from django.db import transaction

from core.exceptions.base import NotFoundError
from .models import App

logger = logging.getLogger(__name__)


class AppService:
    @staticmethod
    @transaction.atomic
    def create_app(owner, name: str, description: str = "") -> App:
        app = App(owner=owner, name=name, description=description)
        app.save()
        return app

    @staticmethod
    def list_apps(owner):
        return App.objects.filter(owner=owner, is_active=True)

    @staticmethod
    def get_app_by_slug(owner, slug: str) -> App:
        try:
            return App.objects.get(owner=owner, slug=slug, is_active=True)
        except App.DoesNotExist:
            raise NotFoundError("App not found")

    @staticmethod
    @transaction.atomic
    def update_app(owner, slug: str, name: str = None, description: str = None) -> App:
        app = AppService.get_app_by_slug(owner, slug)
        if name is not None:
            app.name = name
        if description is not None:
            app.description = description
        app.save()
        return app

    @staticmethod
    @transaction.atomic
    def delete_app(owner, slug: str) -> None:
        app = AppService.get_app_by_slug(owner, slug)
        app.is_active = False
        app.save(update_fields=["is_active", "updated_at"])
