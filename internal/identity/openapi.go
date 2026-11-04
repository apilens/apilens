package identity

import (
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
)

// ProblemContentType is the media type of every identity error response.
const ProblemContentType = "application/problem+json"

// CodesExtension is the OpenAPI response extension listing the `code` values
// an error response can carry, so generated clients and docs can map them.
const CodesExtension = "x-apilens-codes"

// Operation completes op for the committed OpenAPI spec: it requires an
// OperationID, Summary and at least one tag, and documents one error response
// per HTTP status among codes, each with the Problem schema (the `code` and
// `retry_after` extension members) and the codes it can carry. Identity and
// control-plane operations register through it:
//
//	huma.Register(api, identity.Operation(api, huma.Operation{...},
//		identity.CodeInvalidCode, identity.CodeRateLimited), handler)
//
// It panics on a missing OperationID, Summary or tag, or on a code outside
// the catalogue, so an undocumented operation fails at startup and in tests.
func Operation(api huma.API, op huma.Operation, codes ...ErrCode) huma.Operation {
	if op.OperationID == "" || op.Summary == "" || len(op.Tags) == 0 {
		panic(fmt.Sprintf("identity: operation %s %s needs an OperationID, Summary and Tags", op.Method, op.Path))
	}
	byStatus := map[int][]ErrCode{}
	for _, c := range codes {
		e, ok := catalogue[c]
		if !ok {
			panic(fmt.Sprintf("identity: operation %s uses unknown code %q", op.OperationID, c))
		}
		if !slices.Contains(byStatus[e.status], c) {
			byStatus[e.status] = append(byStatus[e.status], c)
		}
	}
	if len(byStatus) == 0 {
		return op
	}

	registry := api.OpenAPI().Components.Schemas
	t := reflect.TypeFor[Problem]()
	schema := registry.Schema(t, true, "Problem")
	if op.Responses == nil {
		op.Responses = map[string]*huma.Response{}
	}
	for status, cs := range byStatus {
		names := make([]string, len(cs))
		for i, c := range cs {
			names[i] = string(c)
		}
		slices.Sort(names)
		quoted := make([]string, len(names))
		for i, n := range names {
			quoted[i] = "`" + n + "`"
		}
		resp := &huma.Response{
			Description: http.StatusText(status) + ". Codes: " + strings.Join(quoted, ", ") + ".",
			Content: map[string]*huma.MediaType{
				ProblemContentType: {Schema: schema},
			},
			Extensions: map[string]any{CodesExtension: names},
		}
		if status == http.StatusTooManyRequests {
			resp.Headers = map[string]*huma.Param{
				"Retry-After": {
					Description: "Seconds to wait before retrying; mirrors `retry_after`.",
					Schema:      &huma.Schema{Type: huma.TypeInteger, Minimum: new(1.0)},
				},
			}
		}
		op.Responses[strconv.Itoa(status)] = resp
	}
	return op
}
