from django.db import migrations


def fix_empty_passwords(apps, schema_editor):
    User = apps.get_model("users", "User")
    # Django's UNUSABLE_PASSWORD_PREFIX is "!", set_unusable_password stores "!<random>"
    # Users with password="" were created by get_or_create without set_unusable_password
    for user in User.objects.filter(password=""):
        # Can't call set_unusable_password on a historical model, so set directly.
        # Django's make_password(None) returns "!<random>", but for historical models
        # we use the same convention: "!" prefix makes has_usable_password() return False.
        from django.contrib.auth.hashers import make_password
        user.password = make_password(None)
        user.save(update_fields=["password"])


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0003_alter_user_picture"),
    ]

    operations = [
        migrations.RunPython(fix_empty_passwords, migrations.RunPython.noop),
    ]
