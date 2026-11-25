// Package purge removes a deleted project's data everywhere once its grace
// period has passed (D8 in #753, #796): ClickHouse telemetry, Valkey keys,
// request export files, Postgres rows and SpiceDB relationships, then moves
// the project's slug to the 30-day reservation.
package purge

// ClickHouseTables are the ClickHouse tables that hold rows keyed by
// project_id, the one list the purge deletes from. A new telemetry table
// with a project_id column must be added here: TestClickHouseTablesCoverEveryProjectTable
// fails until it is.
var ClickHouseTables = []string{
	"api_requests",    // requests
	"api_logs",        // logs
	"api_spans",       // spans
	"api_deploys",     // deploy markers
	"api_requests_1m", // per-minute rollups
	"api_requests_1h", // per-hour rollups
	"api_consumers",   // consumers seen
	// runtime resources (M7)
	"app_instance_resources",    // per-heartbeat CPU, memory and runtime
	"app_instance_resources_1h", // their hourly rollup
	"api_requests_instance_1m",  // per-instance request rollups
}
