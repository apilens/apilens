"""Auto-cleanup of uploaded files when their owning row is deleted.

Django's `ImageField` doesn't delete the underlying file on row delete —
it just clears the FK. Without this, deleting an App row leaves the icon
as an orphan in the storage bucket forever.
"""

from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import App


@receiver(post_delete, sender=App)
def delete_app_icon(sender, instance: App, **kwargs):
    if instance.icon_image:
        # save=False because the row is already gone — nothing left to save.
        instance.icon_image.delete(save=False)
