from typing import Any
from django.conf import settings

import structlog
from asgiref.sync import async_to_sync
from django.db import transaction
from django.db.models import Q
from rest_framework import exceptions, filters, request, response, serializers, status, viewsets
from rest_framework.decorators import action

from posthog.api.routing import TeamAndOrgViewSetMixin
from posthog.api.shared import UserBasicSerializer
from posthog.constants import DATA_WAREHOUSE_TASK_QUEUE
from posthog.hogql.context import HogQLContext
from posthog.hogql.database.database import SerializedField, create_hogql_database, serialize_fields
from posthog.hogql.errors import ExposedHogQLError
from posthog.hogql.metadata import is_valid_view
from posthog.hogql.parser import parse_select
from posthog.hogql.printer import print_ast
from posthog.temporal.common.client import sync_connect
from posthog.temporal.data_modeling.run_workflow import RunWorkflowInputs, Selector
from posthog.warehouse.models import (
    CLICKHOUSE_HOGQL_MAPPING,
    DataWarehouseJoin,
    DataWarehouseModelPath,
    DataWarehouseSavedQuery,
    clean_type,
)
from posthog.warehouse.models.external_data_schema import (
    sync_frequency_to_sync_frequency_interval,
    sync_frequency_interval_to_sync_frequency,
)
from posthog.warehouse.data_load.saved_query_service import (
    saved_query_workflow_exists,
    sync_saved_query_workflow,
    delete_saved_query_schedule,
)
import uuid


logger = structlog.get_logger(__name__)


class DataWarehouseSavedQuerySerializer(serializers.ModelSerializer):
    created_by = UserBasicSerializer(read_only=True)
    columns = serializers.SerializerMethodField(read_only=True)
    sync_frequency = serializers.SerializerMethodField()

    class Meta:
        model = DataWarehouseSavedQuery
        fields = [
            "id",
            "deleted",
            "name",
            "query",
            "created_by",
            "created_at",
            "sync_frequency",
            "columns",
            "status",
            "last_run_at",
        ]
        read_only_fields = ["id", "created_by", "created_at", "columns", "status", "last_run_at"]

    def get_columns(self, view: DataWarehouseSavedQuery) -> list[SerializedField]:
        team_id = self.context["team_id"]
        database = self.context.get("database", None)
        if not database:
            database = create_hogql_database(team_id=team_id)

        context = HogQLContext(team_id=team_id, database=database)

        fields = serialize_fields(view.hogql_definition().fields, context, view.name, table_type="external")
        return [
            SerializedField(
                key=field.name,
                name=field.name,
                type=field.type,
                schema_valid=field.schema_valid,
                fields=field.fields,
                table=field.table,
                chain=field.chain,
            )
            for field in fields
        ]

    def get_sync_frequency(self, schema: DataWarehouseSavedQuery):
        return sync_frequency_interval_to_sync_frequency(schema.sync_frequency_interval)

    def create(self, validated_data):
        validated_data["team_id"] = self.context["team_id"]
        validated_data["created_by"] = self.context["request"].user

        view = DataWarehouseSavedQuery(**validated_data)

        # The columns will be inferred from the query
        try:
            client_types = self.context["request"].data.get("types", [])
            if len(client_types) == 0:
                view.columns = view.get_columns()
            else:
                columns = {
                    str(item[0]): {
                        "hogql": CLICKHOUSE_HOGQL_MAPPING[clean_type(str(item[1]))].__name__,
                        "clickhouse": item[1],
                        "valid": True,
                    }
                    for item in client_types
                }
                view.columns = columns

            view.external_tables = view.s3_tables
        except Exception as err:
            raise serializers.ValidationError(str(err))

        with transaction.atomic():
            view.save()
            try:
                DataWarehouseModelPath.objects.create_from_saved_query(view)
            except Exception:
                # For now, do not fail saved query creation if we cannot model-ize it.
                # Later, after bugs and errors have been ironed out, we may tie these two
                # closer together.
                logger.exception("Failed to create model path when creating view %s", view.name)

        return view

    def update(self, instance: Any, validated_data: Any) -> Any:
        sync_frequency = self.context["request"].data.get("sync_frequency", None)
        was_sync_frequency_updated = False

        with transaction.atomic():
            if sync_frequency == "never":
                delete_saved_query_schedule(str(instance.id))
                instance.sync_frequency_interval = None
                validated_data["sync_frequency_interval"] = None
            elif sync_frequency:
                sync_frequency_interval = sync_frequency_to_sync_frequency_interval(sync_frequency)
                validated_data["sync_frequency_interval"] = sync_frequency_interval
                was_sync_frequency_updated = True
                instance.sync_frequency_interval = sync_frequency_interval

            view: DataWarehouseSavedQuery = super().update(instance, validated_data)

            # Only update columns and status if the query has changed
            if "query" in validated_data:
                try:
                    view.columns = view.get_columns()
                    view.external_tables = view.s3_tables
                    view.status = DataWarehouseSavedQuery.Status.MODIFIED
                except RecursionError:
                    raise serializers.ValidationError("Model contains a cycle")
                except Exception as err:
                    raise serializers.ValidationError(str(err))

                view.save()

            try:
                DataWarehouseModelPath.objects.update_from_saved_query(view)
            except Exception:
                logger.exception("Failed to update model path when updating view %s", view.name)

        if was_sync_frequency_updated:
            schedule_exists = saved_query_workflow_exists(str(instance.id))
            sync_saved_query_workflow(view, create=not schedule_exists)

        return view

    def validate_query(self, query):
        team_id = self.context["team_id"]

        context = HogQLContext(team_id=team_id, enable_select_queries=True)
        select_ast = parse_select(query["query"])
        _is_valid_view = is_valid_view(select_ast)
        if not _is_valid_view:
            raise exceptions.ValidationError(detail="Ensure all fields are aliased")

        try:
            print_ast(
                node=select_ast,
                context=context,
                dialect="clickhouse",
                stack=None,
                settings=None,
            )
        except Exception as err:
            if isinstance(err, ExposedHogQLError):
                error = str(err)
                raise exceptions.ValidationError(detail=f"Invalid query: {error}")
            elif not settings.DEBUG:
                # We don't want to accidentally expose too much data via errors
                raise exceptions.ValidationError(detail=f"Unexpected {err.__class__.__name__}")

        return query


class DataWarehouseSavedQueryViewSet(TeamAndOrgViewSetMixin, viewsets.ModelViewSet):
    """
    Create, Read, Update and Delete Warehouse Tables.
    """

    scope_object = "INTERNAL"
    queryset = DataWarehouseSavedQuery.objects.all()
    serializer_class = DataWarehouseSavedQuerySerializer
    filter_backends = [filters.SearchFilter]
    search_fields = ["name"]
    ordering = "-created_at"

    def get_serializer_context(self) -> dict[str, Any]:
        context = super().get_serializer_context()
        context["database"] = create_hogql_database(team_id=self.team_id)
        return context

    def safely_get_queryset(self, queryset):
        return queryset.prefetch_related("created_by").exclude(deleted=True).order_by(self.ordering)

    def destroy(self, request: request.Request, *args: Any, **kwargs: Any) -> response.Response:
        instance: DataWarehouseSavedQuery = self.get_object()

        delete_saved_query_schedule(str(instance.id))

        for join in DataWarehouseJoin.objects.filter(
            Q(team_id=instance.team_id) & (Q(source_table_name=instance.name) | Q(joining_table_name=instance.name))
        ).exclude(deleted=True):
            join.soft_delete()

        if instance.table is not None:
            instance.table.soft_delete()

        instance.soft_delete()

        return response.Response(status=status.HTTP_204_NO_CONTENT)

    @action(methods=["POST"], detail=True)
    def run(self, request: request.Request, *args, **kwargs) -> response.Response:
        """Run this saved query."""
        ancestors = request.data.get("ancestors", 0)
        descendants = request.data.get("descendants", 0)

        saved_query = self.get_object()

        temporal = sync_connect()

        inputs = RunWorkflowInputs(
            team_id=saved_query.team_id,
            select=[Selector(label=saved_query.id.hex, ancestors=ancestors, descendants=descendants)],
        )
        workflow_id = f"data-modeling-run-{saved_query.id.hex}"
        saved_query.status = DataWarehouseSavedQuery.Status.RUNNING
        saved_query.save()

        async_to_sync(temporal.start_workflow)(  # type: ignore
            "data-modeling-run",  # type: ignore
            inputs,  # type: ignore
            id=workflow_id,
            task_queue=DATA_WAREHOUSE_TASK_QUEUE,
        )

        return response.Response(status=status.HTTP_200_OK)

    @action(methods=["POST"], detail=True)
    def ancestors(self, request: request.Request, *args, **kwargs) -> response.Response:
        """Return the ancestors of this saved query.

        By default, we return the immediate parents. The `level` parameter can be used to
        look further back into the ancestor tree. If `level` overshoots (i.e. points to only
        ancestors beyond the root), we return an empty list.
        """
        up_to_level = request.data.get("level", None)

        saved_query = self.get_object()
        saved_query_id = saved_query.id.hex
        lquery = f"*{{1,}}.{saved_query_id}"

        paths = DataWarehouseModelPath.objects.filter(team=saved_query.team, path__lquery=lquery)

        if not paths:
            return response.Response({"ancestors": []})

        ancestors: set[str | uuid.UUID] = set()
        for model_path in paths:
            if up_to_level is None:
                start = 0
            else:
                start = (int(up_to_level) * -1) - 1

            ancestors = ancestors.union(map(try_convert_to_uuid, model_path.path[start:-1]))

        return response.Response({"ancestors": ancestors})

    @action(methods=["POST"], detail=True)
    def descendants(self, request: request.Request, *args, **kwargs) -> response.Response:
        """Return the descendants of this saved query.

        By default, we return the immediate children. The `level` parameter can be used to
        look further ahead into the descendants tree. If `level` overshoots (i.e. points to only
        descendants further than a leaf), we return an empty list.
        """
        up_to_level = request.data.get("level", None)

        saved_query = self.get_object()
        saved_query_id = saved_query.id.hex

        lquery = f"*.{saved_query_id}.*{{1,}}"
        paths = DataWarehouseModelPath.objects.filter(team=saved_query.team, path__lquery=lquery)

        if not paths:
            return response.Response({"descendants": []})

        descendants: set[str | uuid.UUID] = set()
        for model_path in paths:
            start = model_path.path.index(saved_query_id) + 1
            if up_to_level is None:
                end = len(model_path.path)
            else:
                end = start + up_to_level

            descendants = descendants.union(map(try_convert_to_uuid, model_path.path[start:end]))

        return response.Response({"descendants": descendants})


def try_convert_to_uuid(s: str) -> uuid.UUID | str:
    try:
        return str(uuid.UUID(s))
    except ValueError:
        return s
