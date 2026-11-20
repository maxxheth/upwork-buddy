package mcp

import (
	"context"
	"net/http"
	"strings"

	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type listConversationsInput struct {
	Sync       *bool `json:"sync,omitempty" jsonschema:"When true, scrapes /ab/messages/rooms via Chrome and syncs threads into Postgres"`
	UnreadOnly *bool `json:"unread_only,omitempty" jsonschema:"When true, returns only rooms with unread_count > 0"`
}

type getConversationInput struct {
	RoomID       string `json:"room_id,omitempty" jsonschema:"Upwork message room ID"`
	UpworkRoomID string `json:"upwork_room_id,omitempty" jsonschema:"Alias for room_id"`
	Sync         *bool  `json:"sync,omitempty" jsonschema:"When true, fetches latest messages from Chrome before reading; when false, reads Postgres only"`
}

type draftMessageInput struct {
	RoomID          string `json:"room_id,omitempty" jsonschema:"Upwork message room ID"`
	UpworkRoomID    string `json:"upwork_room_id,omitempty" jsonschema:"Alias for room_id"`
	Body            string `json:"body" jsonschema:"Draft message text"`
	PrefillComposer *bool  `json:"prefill_composer,omitempty" jsonschema:"When true, prefills the Chrome Upwork message composer without sending"`
}

type sendMessageInput struct {
	RoomID        string `json:"room_id,omitempty" jsonschema:"Upwork message room ID"`
	UpworkRoomID  string `json:"upwork_room_id,omitempty" jsonschema:"Alias for room_id"`
	Body          string `json:"body,omitempty" jsonschema:"Message text (required unless sending an existing draft)"`
	ApprovalToken string `json:"approval_token,omitempty" jsonschema:"Single-use approval token for confirm_in_ui"`
	MessageID     *uint  `json:"message_id,omitempty" jsonschema:"Optional persisted draft message ID"`
}

func (s *Server) registerMessageTools() {
	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_list_conversations",
		Description: "List or sync Upwork client message rooms with unread counts and linked job/proposal metadata.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listConversationsInput) (*mcp.CallToolResult, any, error) {
		unreadOnly := in.UnreadOnly != nil && *in.UnreadOnly
		doSync := in.Sync != nil && *in.Sync

		var res *server.ListThreadsResult
		var err error
		if doSync {
			res, err = s.backend.SyncThreads(ctx, nil)
			if err == nil && unreadOnly {
				filtered := make([]server.ThreadEntry, 0, len(res.Threads))
				totalUnread := 0
				for _, th := range res.Threads {
					if th.UnreadCount > 0 {
						filtered = append(filtered, th)
						totalUnread += th.UnreadCount
					}
				}
				res = &server.ListThreadsResult{
					Threads:     filtered,
					TotalUnread: totalUnread,
				}
			}
		} else {
			res, err = s.backend.ListThreads(ctx, unreadOnly)
		}
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(map[string]any{
			"threads":      res.Threads,
			"total_unread": res.TotalUnread,
			"synced":       doSync,
		})
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_get_conversation",
		Description: "Read full Upwork message history, attachments, and linked job context for a room (optionally syncing live via Chrome).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in getConversationInput) (*mcp.CallToolResult, any, error) {
		roomID := strings.TrimSpace(in.RoomID)
		if roomID == "" {
			roomID = strings.TrimSpace(in.UpworkRoomID)
		}
		if roomID == "" {
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "room_id is required",
			})
		}

		var res *server.ThreadMessagesResult
		var err error
		if in.Sync != nil {
			if *in.Sync {
				res, err = s.backend.SyncThread(ctx, roomID)
			} else {
				res, err = s.backend.GetThread(ctx, roomID)
			}
		} else {
			res, err = s.backend.GetThread(ctx, roomID)
			if (err != nil || len(res.Messages) == 0) &&
				s.backend.BridgeHub() != nil && s.backend.BridgeHub().IsConnected() {
				res, err = s.backend.SyncThread(ctx, roomID)
			}
		}
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_draft_message",
		Description: "Draft a client reply in Postgres (optionally prefilling the Upwork composer in Chrome without sending) and generate a pending_approval token.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in draftMessageInput) (*mcp.CallToolResult, any, error) {
		prefill := in.PrefillComposer != nil && *in.PrefillComposer
		res, err := s.backend.DraftMessage(ctx, server.DraftMessageInput{
			RoomID:          in.RoomID,
			UpworkRoomID:    in.UpworkRoomID,
			Body:            in.Body,
			PrefillComposer: prefill,
		}, "mcp")
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_send_message",
		Description: "Send an approved or policy-eligible client reply in an Upwork message room, enforcing policy mode, room allowlist, and daily message caps.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in sendMessageInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.CommitMessage(ctx, server.CommitMessageInput{
			RoomID:        in.RoomID,
			UpworkRoomID:  in.UpworkRoomID,
			Body:          in.Body,
			ApprovalToken: in.ApprovalToken,
			MessageID:     in.MessageID,
		}, false)
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})
}
