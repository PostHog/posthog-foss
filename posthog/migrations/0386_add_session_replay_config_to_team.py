# Generated by Django 3.2.19 on 2024-01-03 16:51

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "0385_exception_autocapture_off_for_all"),
    ]

    operations = [
        migrations.AddField(
            model_name="team",
            name="session_replay_config",
            field=models.JSONField(blank=True, null=True),
        ),
    ]
