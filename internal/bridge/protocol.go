package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/coder/websocket"
)

const (
	JSONRPCVersion = "2.0"

	WSCloseUnauthorized websocket.StatusCode = 4001

	ErrCodeExtensionDisconnected = "EXTENSION_DISCONNECTED"
	ErrCodeHumanActionRequired   = "HUMAN_ACTION_REQUIRED"
	ErrCodeApprovalRequired      = "APPROVAL_REQUIRED"
	ErrCodeDailyCapExceeded      = "DAILY_CAP_EXCEEDED"
	ErrCodePolicyBlocked         = "POLICY_BLOCKED"
	ErrCodeTimeout               = "EXTENSION_TIMEOUT"
	ErrCodeRPC                   = "EXTENSION_RPC_ERROR"

	JSONRPCParseError     = -32700
	JSONRPCInvalidRequest = -32600
	JSONRPCMethodNotFound = -32601
	JSONRPCInvalidParams  = -32602
	JSONRPCInternalError  = -32603
)

// BridgeError represents a typed operational error returned by the extension WebSocket bridge.
type BridgeError struct {
	Code    string          `json:"code"`
	Message string          `json:"message"`
	RPCCode int             `json:"rpc_code,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *BridgeError) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Message == "" {
		return e.Code
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Is supports errors.Is comparisons against sentinel *BridgeError values by Code.
func (e *BridgeError) Is(target error) bool {
	if e == nil {
		return false
	}
	var te *BridgeError
	if !errors.As(target, &te) || te == nil {
		return false
	}
	return e.Code == te.Code
}

var (
	ErrExtensionDisconnected = &BridgeError{
		Code:    ErrCodeExtensionDisconnected,
		Message: "extension WebSocket is not connected",
	}
	ErrHumanActionRequired = &BridgeError{
		Code:    ErrCodeHumanActionRequired,
		Message: "human action required in Chrome (login, 2FA, or verification challenge)",
	}
	ErrApprovalRequired = &BridgeError{
		Code:    ErrCodeApprovalRequired,
		Message: "human approval required in UI",
	}
	ErrDailyCapExceeded = &BridgeError{
		Code:    ErrCodeDailyCapExceeded,
		Message: "daily policy cap exceeded",
	}
	ErrPolicyBlocked = &BridgeError{
		Code:    ErrCodePolicyBlocked,
		Message: "action blocked by policy",
	}
)

// Envelope represents a JSON-RPC 2.0 request, response, or notification frame.
type Envelope struct {
	JSONRPC   string          `json:"jsonrpc"`
	ID        json.RawMessage `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *WireRPCError   `json:"error,omitempty"`
	TimeoutMS int             `json:"timeout_ms,omitempty"`
}

// WireRPCError handles both integer JSON-RPC codes (-32000) and string error codes ("HUMAN_ACTION_REQUIRED").
type WireRPCError struct {
	Code    json.RawMessage `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type AuthParams struct {
	Token            string `json:"token"`
	ExtensionVersion string `json:"extension_version,omitempty"`
	Browser          string `json:"browser,omitempty"`
}

type AuthResult struct {
	OK        bool   `json:"ok"`
	SessionID string `json:"session_id"`
}

type PingParams struct {
	UpworkLoggedIn *bool `json:"upwork_logged_in,omitempty"`
}

type ProgressEvent struct {
	RequestID string `json:"request_id"`
	Stage     string `json:"stage"`
	Current   int    `json:"current"`
	Total     int    `json:"total"`
	Message   string `json:"message,omitempty"`
}

// SearchObservedPagination carries optional GraphQL pagination metadata from a live search capture.
type SearchObservedPagination struct {
	TotalCount  *int   `json:"total_count,omitempty"`
	Offset      *int   `json:"offset,omitempty"`
	Count       *int   `json:"count,omitempty"`
	Page        *int   `json:"page,omitempty"`
	PerPage     *int   `json:"per_page,omitempty"`
	HasNextPage *bool  `json:"has_next_page,omitempty"`
	NextCursor  string `json:"next_cursor,omitempty"`
}

// SearchObservedEvent represents a live/SPA search batch pushed by the extension.
type SearchObservedEvent struct {
	TabID         int                       `json:"tab_id,omitempty"`
	PageURL       string                    `json:"page_url"`
	SourceFeed    string                    `json:"source_feed"`
	Query         string                    `json:"query,omitempty"`
	OperationName string                    `json:"operation_name,omitempty"`
	CaptureKind   string                    `json:"capture_kind,omitempty"`
	Paging        *SearchObservedPagination `json:"paging,omitempty"`
	Jobs          []json.RawMessage         `json:"jobs"`
	CapturedAt    string                    `json:"captured_at,omitempty"`
}

type BridgeStatus struct {
	ExtensionConnected bool   `json:"extension_connected"`
	SessionID          string `json:"session_id,omitempty"`
	Browser            string `json:"browser,omitempty"`
	ExtensionVersion   string `json:"extension_version,omitempty"`
	UpworkLoggedIn     *bool  `json:"upwork_logged_in,omitempty"`
	PolicyMode         string `json:"policy_mode,omitempty"`
	ConnectedAt        string `json:"connected_at,omitempty"`
	LastHeartbeatAt    string `json:"last_heartbeat_at,omitempty"`
}

func mapKnownBridgeCode(raw string) (string, bool) {
	upper := strings.ToUpper(strings.TrimSpace(raw))
	switch upper {
	case ErrCodeExtensionDisconnected:
		return ErrCodeExtensionDisconnected, true
	case ErrCodeHumanActionRequired:
		return ErrCodeHumanActionRequired, true
	case ErrCodeApprovalRequired:
		return ErrCodeApprovalRequired, true
	case ErrCodeDailyCapExceeded:
		return ErrCodeDailyCapExceeded, true
	case ErrCodePolicyBlocked:
		return ErrCodePolicyBlocked, true
	case ErrCodeTimeout, "TIMEOUT":
		return ErrCodeTimeout, true
	default:
		return "", false
	}
}

// ClassifyWireError converts a JSON-RPC WireRPCError into a typed *BridgeError.
func ClassifyWireError(we *WireRPCError) *BridgeError {
	if we == nil {
		return nil
	}

	var rpcCode int
	var rawCodeStr string
	trimmedCode := bytes.TrimSpace(we.Code)
	if len(trimmedCode) > 0 {
		if trimmedCode[0] == '"' {
			_ = json.Unmarshal(trimmedCode, &rawCodeStr)
		} else {
			_ = json.Unmarshal(trimmedCode, &rpcCode)
		}
	}

	var dataEnvelope struct {
		Code      string `json:"code"`
		ErrorCode string `json:"error_code"`
	}
	if len(bytes.TrimSpace(we.Data)) > 0 {
		_ = json.Unmarshal(we.Data, &dataEnvelope)
	}

	candidates := []string{
		rawCodeStr,
		dataEnvelope.ErrorCode,
		dataEnvelope.Code,
	}
	for _, c := range candidates {
		if mapped, ok := mapKnownBridgeCode(c); ok {
			msg := strings.TrimSpace(we.Message)
			if msg == "" {
				msg = mapped
			}
			return &BridgeError{
				Code:    mapped,
				Message: msg,
				RPCCode: rpcCode,
				Data:    we.Data,
			}
		}
	}

	msg := strings.TrimSpace(we.Message)
	upperMsg := strings.ToUpper(msg)
	for _, known := range []string{
		ErrCodeHumanActionRequired,
		ErrCodeExtensionDisconnected,
		ErrCodeApprovalRequired,
		ErrCodeDailyCapExceeded,
		ErrCodePolicyBlocked,
	} {
		if strings.Contains(upperMsg, known) {
			return &BridgeError{
				Code:    known,
				Message: msg,
				RPCCode: rpcCode,
				Data:    we.Data,
			}
		}
	}

	code := ErrCodeRPC
	if rawCodeStr != "" {
		code = strings.ToUpper(strings.TrimSpace(rawCodeStr))
	} else if promoted := strings.TrimSpace(dataEnvelope.ErrorCode); promoted != "" {
		code = strings.ToUpper(promoted)
	} else if promoted := strings.TrimSpace(dataEnvelope.Code); promoted != "" {
		code = strings.ToUpper(promoted)
	}
	if msg == "" {
		msg = "extension RPC failed"
	}
	return &BridgeError{
		Code:    code,
		Message: msg,
		RPCCode: rpcCode,
		Data:    we.Data,
	}
}

// CheckResultForError inspects a JSON-RPC result payload for error/halt statuses
// such as {"status":"HUMAN_ACTION_REQUIRED"} or {"error_code":"..."}.
func CheckResultForError(result json.RawMessage) *BridgeError {
	trimmed := bytes.TrimSpace(result)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}

	var probe struct {
		Status    string `json:"status"`
		ErrorCode string `json:"error_code"`
		Code      string `json:"code"`
		Message   string `json:"message"`
		Reason    string `json:"reason"`
	}
	if err := json.Unmarshal(trimmed, &probe); err != nil {
		return nil
	}

	for _, candidate := range []string{probe.Status, probe.ErrorCode, probe.Code} {
		if mapped, ok := mapKnownBridgeCode(candidate); ok {
			msg := strings.TrimSpace(probe.Reason)
			if msg == "" {
				msg = strings.TrimSpace(probe.Message)
			}
			if msg == "" {
				msg = mapped
			}
			return &BridgeError{
				Code:    mapped,
				Message: msg,
				Data:    trimmed,
			}
		}
	}
	return nil
}

// NormalizeIDKey normalizes a JSON-RPC id (string or number) into a stable map key.
func NormalizeIDKey(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", false
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil || s == "" {
			return "", false
		}
		return "s:" + s, true
	}
	var num json.Number
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.UseNumber()
	if err := dec.Decode(&num); err != nil {
		return "", false
	}
	return "n:" + num.String(), true
}
