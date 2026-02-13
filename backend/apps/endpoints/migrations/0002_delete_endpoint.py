"""
Remove Endpoint model from endpoints app state (moved to projects app).

State-only: no DB changes.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("endpoints", "0001_initial"),
        ("projects", "0003_move_endpoint_from_endpoints_app"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.DeleteModel(name="Endpoint"),
            ],
            database_operations=[],
        ),
    ]
