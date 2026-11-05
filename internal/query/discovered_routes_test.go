package query

import (
	"reflect"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

func TestWithDiscovered(t *testing.T) {
	app, other := uuid.New(), uuid.New()
	traffic := []endpoint{{Method: "GET", Path: "/orders/{id}", Requests: 4}}
	routes := []db.ListProjectDiscoveredRoutesRow{
		{AppID: app, Method: "GET", Path: "/health"},      // excluded on app
		{AppID: other, Method: "GET", Path: "/health"},    // same route, other app: listed
		{AppID: app, Method: "GET", Path: "/orders/{id}"}, // has traffic
		{AppID: app, Method: "POST", Path: "/orders"},     // zero traffic
		{AppID: other, Method: "POST", Path: "/orders"},   // duplicate across apps
		{AppID: app, Method: "DELETE", Path: "/orders/{id}"},
	}
	rules := metricRules{excluded: []endpointKey{{app: app, method: "GET", path: "/health"}}}

	got := withDiscovered(append([]endpoint{}, traffic...), routes, rules, 100)
	want := []endpoint{
		{Method: "GET", Path: "/orders/{id}", Requests: 4},
		{Method: "GET", Path: "/health", DiscoveredOnly: true},
		{Method: "POST", Path: "/orders", DiscoveredOnly: true},
		{Method: "DELETE", Path: "/orders/{id}", DiscoveredOnly: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("withDiscovered = %+v, want %+v", got, want)
	}

	if got := withDiscovered(append([]endpoint{}, traffic...), routes, rules, 2); len(got) != 2 || got[1].Path != "/health" {
		t.Fatalf("limit 2 = %+v", got)
	}

	onlyExcluded := metricRules{excluded: []endpointKey{{app: app, method: "POST", path: "/orders"}, {app: other, method: "POST", path: "/orders"}}}
	for _, e := range withDiscovered(nil, routes, onlyExcluded, 100) {
		if e.Method == "POST" && e.Path == "/orders" {
			t.Fatalf("route excluded on every app listed: %+v", e)
		}
	}
}

func TestDiscoveredRoutesWithoutStore(t *testing.T) {
	s := &Service{catalog: nil}
	rows, err := s.discoveredRoutes(t.Context(), uuid.New(), "")
	if err != nil || rows != nil {
		t.Fatalf("discoveredRoutes = %v, %v", rows, err)
	}
}
