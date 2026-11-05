package query

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Consumer groups: named groups of a project's API consumers. A consumer is
// in at most one group; assigning it to a group moves it out of the one it
// was in. Everyone who can view the project (and its read key) lists the
// groups; project editors (project admins and editors, organization members)
// create, rename and delete them and assign consumers.

// ConsumerGroupsPath is the collection of a project's consumer groups. The
// project is {project}, its slug, as authz.Guard reads it.
const ConsumerGroupsPath = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/consumer-groups"

// ConsumerGroupPath is one consumer group of a project.
const ConsumerGroupPath = ConsumerGroupsPath + "/{id}"

// ConsumerGroupAssignmentPath is the group of one consumer of a project.
const ConsumerGroupAssignmentPath = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/consumers/{consumer_id}/group"

const maxGroupNameLen = 128

// ConsumerGroupStore is the control-plane subset the consumer group
// operations use; *db.Queries satisfies it. The Service's Catalog must
// implement it too, or the operations answer 503.
type ConsumerGroupStore interface {
	ListConsumerGroups(ctx context.Context, projectID uuid.UUID) ([]db.ListConsumerGroupsRow, error)
	GetConsumerGroup(ctx context.Context, arg db.GetConsumerGroupParams) (db.GetConsumerGroupRow, error)
	CreateConsumerGroup(ctx context.Context, arg db.CreateConsumerGroupParams) (db.ConsumerGroup, error)
	RenameConsumerGroup(ctx context.Context, arg db.RenameConsumerGroupParams) (db.ConsumerGroup, error)
	DeleteConsumerGroup(ctx context.Context, arg db.DeleteConsumerGroupParams) (int64, error)
	AssignConsumerGroup(ctx context.Context, arg db.AssignConsumerGroupParams) (db.ConsumerGroupMember, error)
	UnassignConsumerGroup(ctx context.Context, arg db.UnassignConsumerGroupParams) (int64, error)
}

// ConsumerGroup is a named group of a project's consumers.
type ConsumerGroup struct {
	ID        string    `json:"id" format:"uuid"`
	Name      string    `json:"name"`
	Consumers int64     `json:"consumers" doc:"How many consumers are assigned to the group."`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type consumerGroupOutput struct {
	Body ConsumerGroup
}

type consumerGroupsOutput struct {
	Body struct {
		Groups []ConsumerGroup `json:"groups" doc:"The project's consumer groups, by name."`
	}
}

type consumerGroupsInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
}

type consumerGroupInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	ID      string `path:"id" format:"uuid" doc:"The group's id."`
}

type consumerGroupBody struct {
	Name string `json:"name" minLength:"1" maxLength:"128" doc:"Display name, 1 to 128 characters; surrounding spaces are dropped. Unique in the project, ignoring case."`
}

type createConsumerGroupInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	Body    consumerGroupBody
}

type renameConsumerGroupInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	ID      string `path:"id" format:"uuid" doc:"The group's id."`
	Body    consumerGroupBody
}

type consumerAssignmentInput struct {
	Project    string `path:"project" maxLength:"63" doc:"Project slug."`
	ConsumerID string `path:"consumer_id" minLength:"1" maxLength:"256" doc:"The consumer id the SDK reports, URL-encoded as one path segment."`
}

type assignConsumerGroupInput struct {
	Project    string `path:"project" maxLength:"63" doc:"Project slug."`
	ConsumerID string `path:"consumer_id" minLength:"1" maxLength:"256" doc:"The consumer id the SDK reports, URL-encoded as one path segment."`
	Body       struct {
		GroupID string `json:"group_id" format:"uuid" doc:"The group to put the consumer in; it leaves the group it was in."`
	}
}

type consumerAssignmentOutput struct {
	Body struct {
		ConsumerID string           `json:"consumer_id"`
		Group      ConsumerGroupRef `json:"group"`
		AssignedAt time.Time        `json:"assigned_at"`
	}
}

func registerConsumerGroups(api huma.API, s *Service, guard *authz.Guard) {
	view := huma.Middlewares{guard.RequireProject(api, authz.ProjectView)}
	edit := huma.Middlewares{guard.RequireProject(api, authz.ProjectEdit)}
	session := []map[string][]string{{authn.SchemeSession: {}}}
	readers := []map[string][]string{{authn.SchemeSession: {}}, {SchemeReadKey: {}}}
	guarded := []identity.ErrCode{identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable}
	editors := "Needs a user session that can edit the project (project admins and editors, organization members); 403 for viewers."
	writeGuarded := append([]identity.ErrCode{identity.CodeForbidden}, guarded...)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-consumer-groups",
		Method:      http.MethodGet,
		Path:        ConsumerGroupsPath,
		Summary:     "List the consumer groups of a project",
		Description: "The project's consumer groups by name, with how many consumers each holds. " +
			"Open to a session that can view the project or to the project's read key.",
		Tags:        []string{server.TagProjects},
		Security:    readers,
		Middlewares: view,
	}, guarded...), s.listConsumerGroups)
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "create-consumer-group",
		Method:        http.MethodPost,
		Path:          ConsumerGroupsPath,
		Summary:       "Create a consumer group",
		Description:   "Creates an empty consumer group. " + editors + " A name the project already uses answers 409.",
		Tags:          []string{server.TagProjects},
		Security:      session,
		Middlewares:   edit,
		DefaultStatus: http.StatusCreated,
	}, writeGuarded...), s.createConsumerGroup)
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "rename-consumer-group",
		Method:      http.MethodPut,
		Path:        ConsumerGroupPath,
		Summary:     "Rename a consumer group",
		Description: "Renames a group; its consumers stay. " + editors + " A name the project already uses answers 409.",
		Tags:        []string{server.TagProjects},
		Security:    session,
		Middlewares: edit,
	}, writeGuarded...), s.renameConsumerGroup)
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "delete-consumer-group",
		Method:        http.MethodDelete,
		Path:          ConsumerGroupPath,
		Summary:       "Delete a consumer group",
		Description:   "Deletes a group; its consumers become ungrouped. " + editors,
		Tags:          []string{server.TagProjects},
		Security:      session,
		Middlewares:   edit,
		DefaultStatus: http.StatusNoContent,
	}, writeGuarded...), s.deleteConsumerGroup)
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "assign-consumer-group",
		Method:      http.MethodPut,
		Path:        ConsumerGroupAssignmentPath,
		Summary:     "Put a consumer in a group",
		Description: "Assigns a consumer to a group of the project, moving it out of the group it was in (a consumer is in at most one group). " +
			editors + " A group that is not one of the project's answers 404.",
		Tags:        []string{server.TagProjects},
		Security:    session,
		Middlewares: edit,
	}, writeGuarded...), s.assignConsumerGroup)
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "unassign-consumer-group",
		Method:        http.MethodDelete,
		Path:          ConsumerGroupAssignmentPath,
		Summary:       "Take a consumer out of its group",
		Description:   "Leaves the consumer ungrouped. " + editors + " A consumer without a group answers 404.",
		Tags:          []string{server.TagProjects},
		Security:      session,
		Middlewares:   edit,
		DefaultStatus: http.StatusNoContent,
	}, writeGuarded...), s.unassignConsumerGroup)
}

func (s *Service) groupStore(ctx context.Context) (ConsumerGroupStore, uuid.UUID, error) {
	t, ok := authz.TargetFromContext(ctx)
	if !ok {
		return nil, uuid.Nil, identity.Err(identity.CodeUnauthenticated)
	}
	store, ok := s.catalog.(ConsumerGroupStore)
	if !ok {
		return nil, uuid.Nil, huma.Error503ServiceUnavailable("consumer groups unavailable")
	}
	return store, t.ProjectID, nil
}

func (s *Service) listConsumerGroups(ctx context.Context, _ *consumerGroupsInput) (*consumerGroupsOutput, error) {
	store, project, err := s.groupStore(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := store.ListConsumerGroups(ctx, project)
	if err != nil {
		return nil, internalError("list consumer groups", err)
	}
	out := &consumerGroupsOutput{}
	out.Body.Groups = make([]ConsumerGroup, 0, len(rows))
	for _, r := range rows {
		out.Body.Groups = append(out.Body.Groups, ConsumerGroup{
			ID: r.ID.String(), Name: r.Name, Consumers: r.Consumers, CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(),
		})
	}
	return out, nil
}

func (s *Service) createConsumerGroup(ctx context.Context, in *createConsumerGroupInput) (*consumerGroupOutput, error) {
	store, project, err := s.groupStore(ctx)
	if err != nil {
		return nil, err
	}
	name, err := groupName(in.Body.Name)
	if err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, internalError("group id", err)
	}
	row, err := store.CreateConsumerGroup(ctx, db.CreateConsumerGroupParams{ID: id, ProjectID: project, Name: name})
	if isUniqueViolation(err) {
		return nil, huma.Error409Conflict("the project already has a consumer group with this name")
	}
	if err != nil {
		return nil, internalError("create consumer group", err)
	}
	return &consumerGroupOutput{Body: ConsumerGroup{
		ID: row.ID.String(), Name: row.Name, CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
	}}, nil
}

func (s *Service) renameConsumerGroup(ctx context.Context, in *renameConsumerGroupInput) (*consumerGroupOutput, error) {
	store, project, err := s.groupStore(ctx)
	if err != nil {
		return nil, err
	}
	name, err := groupName(in.Body.Name)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("consumer group not found")
	}
	_, err = store.RenameConsumerGroup(ctx, db.RenameConsumerGroupParams{ID: id, ProjectID: project, Name: name})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, huma.Error404NotFound("consumer group not found")
	case isUniqueViolation(err):
		return nil, huma.Error409Conflict("the project already has a consumer group with this name")
	case err != nil:
		return nil, internalError("rename consumer group", err)
	}
	row, err := store.GetConsumerGroup(ctx, db.GetConsumerGroupParams{ID: id, ProjectID: project})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("consumer group not found")
	}
	if err != nil {
		return nil, internalError("consumer group", err)
	}
	return &consumerGroupOutput{Body: ConsumerGroup{
		ID: row.ID.String(), Name: row.Name, Consumers: row.Consumers, CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
	}}, nil
}

func (s *Service) deleteConsumerGroup(ctx context.Context, in *consumerGroupInput) (*struct{}, error) {
	store, project, err := s.groupStore(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("consumer group not found")
	}
	n, err := store.DeleteConsumerGroup(ctx, db.DeleteConsumerGroupParams{ID: id, ProjectID: project})
	if err != nil {
		return nil, internalError("delete consumer group", err)
	}
	if n == 0 {
		return nil, huma.Error404NotFound("consumer group not found")
	}
	return nil, nil
}

func (s *Service) assignConsumerGroup(ctx context.Context, in *assignConsumerGroupInput) (*consumerAssignmentOutput, error) {
	store, project, err := s.groupStore(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.Body.GroupID)
	if err != nil {
		return nil, huma.Error404NotFound("consumer group not found")
	}
	m, err := store.AssignConsumerGroup(ctx, db.AssignConsumerGroupParams{ProjectID: project, ConsumerID: in.ConsumerID, GroupID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("consumer group not found")
	}
	if err != nil {
		return nil, internalError("assign consumer group", err)
	}
	g, err := store.GetConsumerGroup(ctx, db.GetConsumerGroupParams{ID: m.GroupID, ProjectID: project})
	if errors.Is(err, pgx.ErrNoRows) {
		// Deleted between the two statements.
		return nil, huma.Error404NotFound("consumer group not found")
	}
	if err != nil {
		return nil, internalError("consumer group", err)
	}
	out := &consumerAssignmentOutput{}
	out.Body.ConsumerID = m.ConsumerID
	out.Body.Group = ConsumerGroupRef{ID: g.ID.String(), Name: g.Name}
	out.Body.AssignedAt = m.AssignedAt.UTC()
	return out, nil
}

func (s *Service) unassignConsumerGroup(ctx context.Context, in *consumerAssignmentInput) (*struct{}, error) {
	store, project, err := s.groupStore(ctx)
	if err != nil {
		return nil, err
	}
	n, err := store.UnassignConsumerGroup(ctx, db.UnassignConsumerGroupParams{ProjectID: project, ConsumerID: in.ConsumerID})
	if err != nil {
		return nil, internalError("unassign consumer group", err)
	}
	if n == 0 {
		return nil, huma.Error404NotFound("the consumer is not in a group")
	}
	return nil, nil
}

// groupName trims and checks a consumer group's name.
func groupName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxGroupNameLen {
		return "", huma.Error422UnprocessableEntity("name must be 1 to 128 characters")
	}
	return name, nil
}
