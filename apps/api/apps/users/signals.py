"""Auto-cleanup of uploaded files when their owning row is deleted.

Django's `ImageField` does NOT delete the underlying file when the model
row is deleted — it just clears the FK. Without this signal, deleting a
User row leaves the profile picture as an orphan in the storage bucket
forever.
"""

from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import User


@receiver(post_delete, sender=User)
def delete_user_picture(sender, instance: User, **kwargs):
    if instance.picture:
        # save=False because the row is already gone — nothing left to save.
        instance.picture.delete(save=False)
