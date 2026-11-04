//go:build integration

package spicedb_test

import (
	"context"
	"strings"
	"testing"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/testutil"
)

func TestApplySchemaIsIdempotent(t *testing.T) {
	ctx := context.Background()
	cfg := testutil.SpiceDB(t)
	client, err := spicedb.Connect(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })

	for i := range 2 {
		if err := spicedb.ApplySchema(ctx, client, authz.Schema, testutil.Logger(t)); err != nil {
			t.Fatalf("apply #%d: %v", i+1, err)
		}
	}
	got, err := client.ReadSchema(ctx, &v1.ReadSchemaRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, def := range []string{"definition user", "definition organization", "definition project"} {
		if !strings.Contains(got.GetSchemaText(), def) {
			t.Errorf("stored schema missing %q", def)
		}
	}
}

func TestApplySchemaWrongKeyFailsFast(t *testing.T) {
	cfg := testutil.SpiceDB(t)
	cfg.PresharedKey = "wrong"
	client, err := spicedb.Connect(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	err = spicedb.ApplySchema(context.Background(), client, authz.Schema, testutil.Logger(t))
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("err = %v, want PermissionDenied", err)
	}
}
