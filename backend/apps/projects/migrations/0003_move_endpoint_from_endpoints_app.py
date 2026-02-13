"""
Move Endpoint model from apps.endpoints to apps.projects.

State-only migration: the DB table ('endpoints') stays exactly as-is.
"""

import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("projects", "0002_initial"),
        ("endpoints", "0001_initial"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.CreateModel(
                    name="Endpoint",
                    fields=[
                        ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                        ("path", models.CharField(max_length=500)),
                        ("method", models.CharField(choices=[("GET", "Get"), ("POST", "Post"), ("PUT", "Put"), ("PATCH", "Patch"), ("DELETE", "Delete")], default="GET", max_length=10)),
                        ("description", models.TextField(blank=True, default="")),
                        ("is_active", models.BooleanField(default=True)),
                        ("last_seen_at", models.DateTimeField(blank=True, null=True)),
                        ("created_at", models.DateTimeField(auto_now_add=True)),
                        ("updated_at", models.DateTimeField(auto_now=True)),
                        ("app", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="endpoints", to="projects.app")),
                    ],
                    options={
                        "db_table": "endpoints",
                        "ordering": ["path", "method"],
                        "constraints": [
                            models.UniqueConstraint(fields=("app", "path", "method"), name="unique_endpoint_per_app"),
                        ],
                    },
                ),
            ],
            database_operations=[],
        ),
    ]
