# Generated by Django 4.1.13 on 2024-03-12 23:14

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "0396_projects_and_environments"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql="""
                    -- For each team without a parent project, create such a project
                    INSERT INTO posthog_project (id, name, created_at, organization_id)
                    SELECT id, name, created_at, organization_id
                    FROM posthog_team
                    WHERE project_id IS NULL;
                    -- At this point, all teams have a parent project, so we can safely set project_id on every team
                    UPDATE posthog_team
                    SET project_id = id;""",
                    reverse_sql=migrations.RunSQL.noop,
                )
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="team",
                    name="project",
                    field=models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="teams",
                        related_query_name="team",
                        to="posthog.project",
                    ),
                ),
            ],
        )
    ]
