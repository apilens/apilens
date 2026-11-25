-- name: UpsertAppInstance :exec
-- Records a heartbeat of one SDK process: the latest report replaces the
-- instance's previous one, first_seen_at is kept. Identity and the resources
-- snapshot are the latest heartbeat's (null resources: this beat had none).
-- A final heartbeat ends the instance gracefully; any other heartbeat means
-- it is alive, which clears an end inferred earlier.
INSERT INTO app_instances (
    app_id, environment, instance_id, project_id, sdk_name, sdk_version,
    runtime, release, commit, pid, stats, first_seen_at, last_seen_at,
    hostname, hostname_guess, container_id, pod_name, pod_uid, namespace, node_name,
    platform, region, process_start_time, uptime_s, resources, ended_at, ended_reason
)
VALUES (
    @app_id, @environment, @instance_id, @project_id, @sdk_name, @sdk_version,
    @runtime, @release, @commit, sqlc.narg(pid)::bigint, @stats, @seen_at, @seen_at,
    @hostname, @hostname_guess, @container_id, @pod_name, @pod_uid, @namespace, @node_name,
    @platform, @region, sqlc.narg(process_start_time)::timestamptz, sqlc.narg(uptime_s)::double precision,
    sqlc.narg(resources)::jsonb,
    CASE WHEN @final::boolean THEN @seen_at::timestamptz END,
    CASE WHEN @final::boolean THEN 'graceful' ELSE '' END
)
ON CONFLICT (app_id, environment, instance_id) DO UPDATE SET
    project_id         = EXCLUDED.project_id,
    sdk_name           = EXCLUDED.sdk_name,
    sdk_version        = EXCLUDED.sdk_version,
    runtime            = EXCLUDED.runtime,
    release            = EXCLUDED.release,
    commit             = EXCLUDED.commit,
    pid                = EXCLUDED.pid,
    stats              = EXCLUDED.stats,
    last_seen_at       = GREATEST(app_instances.last_seen_at, EXCLUDED.last_seen_at),
    hostname           = EXCLUDED.hostname,
    hostname_guess     = EXCLUDED.hostname_guess,
    container_id       = EXCLUDED.container_id,
    pod_name           = EXCLUDED.pod_name,
    pod_uid            = EXCLUDED.pod_uid,
    namespace          = EXCLUDED.namespace,
    node_name          = EXCLUDED.node_name,
    platform           = EXCLUDED.platform,
    region             = EXCLUDED.region,
    process_start_time = EXCLUDED.process_start_time,
    uptime_s           = EXCLUDED.uptime_s,
    resources          = EXCLUDED.resources,
    ended_at           = EXCLUDED.ended_at,
    ended_reason       = EXCLUDED.ended_reason;

-- name: GetProjectApp :one
-- An active app of a project; no row when the app is unknown, deleted or in
-- another project.
SELECT a.id, a.slug
FROM apps a
WHERE a.id = @id AND a.project_id = @project_id AND a.deleted_at IS NULL;

-- name: ListAppEnvironmentsLastSeen :many
-- The last heartbeat of an app per environment, and how many of its
-- instances were seen since @since.
SELECT environment, max(last_seen_at)::timestamptz AS last_seen_at,
       count(*) FILTER (WHERE last_seen_at >= @since)::int AS live_instances
FROM app_instances
WHERE app_id = @app_id
GROUP BY environment
ORDER BY environment;

-- name: ListRecentAppInstances :many
-- The most recently seen instances of an app.
SELECT environment, instance_id, sdk_name, sdk_version, runtime, release, commit, pid,
       stats, first_seen_at, last_seen_at
FROM app_instances
WHERE app_id = @app_id
ORDER BY last_seen_at DESC, environment, instance_id
LIMIT @max_rows;

-- name: RecordOOMKill :exec
-- A live process reported OOM kills in its container during the window.
INSERT INTO app_instance_events (project_id, app_id, environment, instance_id, container_id, pod_name, kind, at, details)
VALUES (@project_id, @app_id, @environment, @instance_id, @container_id, @pod_name, 'oom_kill', @at,
        jsonb_build_object('count', @count::double precision));

-- name: EndReplacedInstances :many
-- Ends the open instances a heartbeat shows are gone (ADR 0010 D10):
--   * a container restart: same pod (pod_uid), another container;
--   * a dead worker: same container, silent for 2.5 heartbeat windows
--     (at least 150 s), while a sibling still reports.
-- The reason is oom when the container recorded an OOM kill around the
-- instance's last heartbeat, suspected_oom when its last working set was at
-- least 90 % of the memory limit, restart otherwise. A later heartbeat of an
-- ended instance clears the end again (UpsertAppInstance).
WITH p AS (
    SELECT @now::timestamptz AS now, @pod_uid::text AS pod_uid, @container_id::text AS container_id
)
UPDATE app_instances ai
SET ended_at = p.now,
    ended_reason = CASE
        WHEN EXISTS (
            SELECT 1 FROM app_instance_events ev
            WHERE ev.app_id = ai.app_id AND ev.environment = ai.environment AND ev.kind = 'oom_kill'
              AND ev.container_id = ai.container_id AND ev.at >= ai.last_seen_at - interval '90 seconds'
        ) THEN 'oom'
        WHEN (ai.resources -> 'metrics' ->> 'container.memory.limit')::double precision > 0
         AND coalesce((ai.resources -> 'metrics' ->> 'container.memory.working_set.max')::double precision,
                      (ai.resources -> 'metrics' ->> 'container.memory.current.max')::double precision, 0)
             >= 0.9 * (ai.resources -> 'metrics' ->> 'container.memory.limit')::double precision
        THEN 'suspected_oom'
        ELSE 'restart'
    END
FROM p
WHERE ai.app_id = @app_id
  AND ai.environment = @environment
  AND ai.ended_at IS NULL
  AND ai.instance_id <> @instance_id
  AND ai.container_id <> ''
  AND (
      (p.pod_uid <> '' AND ai.pod_uid = p.pod_uid AND ai.container_id <> p.container_id)
      OR (
          p.container_id <> '' AND ai.container_id = p.container_id
          AND ai.last_seen_at < p.now - interval '1 second'
              * greatest(150, 2.5 * coalesce((ai.resources ->> 'window_s')::double precision, 60))
      )
  )
RETURNING ai.project_id, ai.instance_id, ai.container_id, ai.pod_name, ai.ended_reason, ai.last_seen_at;

-- name: RecordInstanceEnded :exec
INSERT INTO app_instance_events (project_id, app_id, environment, instance_id, container_id, pod_name, kind, at, details)
VALUES (@project_id, @app_id, @environment, @instance_id, @container_id, @pod_name, @kind, @at,
        jsonb_build_object('replaced_by', @replaced_by::text, 'last_seen_at', @last_seen_at::timestamptz));

-- name: ListAppInstanceEvents :many
-- Restarts and OOM kills of an app in a window, newest first.
SELECT environment, instance_id, container_id, pod_name, kind, at, details
FROM app_instance_events
WHERE app_id = @app_id
  AND (@environment::text = '' OR environment = @environment::text)
  AND at >= @since AND at < @until
ORDER BY at DESC, id DESC
LIMIT @max_rows;

-- name: CountAppInstanceRestarts :one
-- The restarts of an app in a window, for the restarts alert metric:
-- restart, oom and suspected_oom events, with the workers of one container
-- ended by the same heartbeat (same container_id and at) counted once.
SELECT count(DISTINCT (container_id, at))::bigint
FROM app_instance_events
WHERE app_id = @app_id
  AND environment = @environment
  AND kind IN ('restart', 'oom', 'suspected_oom')
  AND at >= @since AND at < @until;
