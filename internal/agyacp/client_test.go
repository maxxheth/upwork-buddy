package agyacp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_ACP_HELPER") != "1" {
		return
	}
	mode := os.Getenv("ACP_HELPER_MODE")
	crashMarker := os.Getenv("ACP_CRASH_MARKER")
	promptLog := os.Getenv("ACP_PROMPT_LOG")

	if mode == "crash_once" && crashMarker != "" {
		if _, err := os.Stat(crashMarker); errors.Is(err, os.ErrNotExist) {
			_ = os.WriteFile(crashMarker, []byte("crashed"), 0o600)
			// Read initialize, respond, then crash on session/new.
		} else {
			mode = "normal"
		}
	}

	reader := bufio.NewReaderSize(os.Stdin, 1024*1024)
	var writeMu sync.Mutex
	writeLine := func(v any) {
		b, _ := json.Marshal(v)
		b = append(b, '\n')
		writeMu.Lock()
		_, _ = os.Stdout.Write(b)
		writeMu.Unlock()
	}

	sessionModels := map[string]string{}
	cancelCh := make(chan string, 16)
	permAckCh := make(chan string, 16)
	var sessCounter int

	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var env struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
				Result json.RawMessage `json:"result"`
			}
			if uErr := json.Unmarshal(line, &env); uErr == nil {
				// Handle response to our session/request_permission.
				if env.Method == "" && len(env.Result) > 0 {
					var res struct {
						Outcome struct {
							Outcome  string `json:"outcome"`
							OptionID string `json:"optionId"`
						} `json:"outcome"`
					}
					if json.Unmarshal(env.Result, &res) == nil {
						permAckCh <- res.Outcome.Outcome + ":" + res.Outcome.OptionID
					}
					continue
				}

				switch env.Method {
				case "initialize":
					if mode == "auth_error" {
						writeLine(map[string]any{
							"jsonrpc": "2.0",
							"id":      env.ID,
							"error": map[string]any{
								"code":    -32001,
								"message": "Antigravity authentication required: not logged in",
							},
						})
						continue
					}
					writeLine(map[string]any{
						"jsonrpc": "2.0",
						"id":      env.ID,
						"result": map[string]any{
							"protocolVersion": 1,
						},
					})

				case "session/new":
					if mode == "crash_once" {
						os.Exit(2)
					}
					sessCounter++
					sid := fmt.Sprintf("sess-%d", sessCounter)
					sessionModels[sid] = "gemini-pro-orchestrator-neon"
					writeLine(map[string]any{
						"jsonrpc": "2.0",
						"id":      env.ID,
						"result": map[string]any{
							"sessionId": sid,
							"models": map[string]any{
								"availableModels": []map[string]string{
									{"modelId": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)"},
									{"modelId": "gemini-4-neon", "name": "Gemini 4 (Neon)"},
								},
							},
							"configOptions": buildConfigOptions("gemini-pro-orchestrator-neon"),
						},
					})

				case "session/set_config_option":
					var p struct {
						SessionID string `json:"sessionId"`
						ConfigID  string `json:"configId"`
						Value     string `json:"value"`
					}
					_ = json.Unmarshal(env.Params, &p)
					if p.ConfigID == "model" {
						sessionModels[p.SessionID] = p.Value
						writeLine(map[string]any{
							"jsonrpc": "2.0",
							"id":      env.ID,
							"result": map[string]any{
								"configOptions": buildConfigOptions(p.Value),
							},
						})
					} else if p.ConfigID == "thought_level" {
						if sessionModels[p.SessionID] == "gemini-pro-orchestrator-neon" {
							writeLine(map[string]any{
								"jsonrpc": "2.0",
								"id":      env.ID,
								"error": map[string]any{
									"code":    -32602,
									"message": "Invalid params: thought_level not supported on orchestrator",
								},
							})
							continue
						}
						writeLine(map[string]any{
							"jsonrpc": "2.0",
							"id":      env.ID,
							"result": map[string]any{
								"configOptions": buildConfigOptions(sessionModels[p.SessionID]),
							},
						})
					}

				case "session/prompt":
					var p struct {
						SessionID string `json:"sessionId"`
						Prompt    []struct {
							Type string `json:"type"`
							Text string `json:"text"`
						} `json:"prompt"`
					}
					_ = json.Unmarshal(env.Params, &p)
					if promptLog != "" && len(p.Prompt) > 0 {
						_ = os.WriteFile(promptLog, []byte(p.Prompt[0].Text), 0o600)
					}

					go func(reqID json.RawMessage, sid string) {
						switch mode {
						case "permission":
							writeLine(map[string]any{
								"jsonrpc": "2.0",
								"id":      999,
								"method":  "session/request_permission",
								"params": map[string]any{
									"sessionId": sid,
									"options": []map[string]string{
										{"optionId": "allow-1", "kind": "allow_once", "name": "Allow"},
										{"optionId": "reject-1", "kind": "reject_once", "name": "Reject"},
									},
								},
							})
							ack := <-permAckCh
							writeLine(map[string]any{
								"jsonrpc": "2.0",
								"method":  "session/update",
								"params": map[string]any{
									"sessionId": sid,
									"update": map[string]any{
										"sessionUpdate": "agent_message_chunk",
										"content":       map[string]string{"type": "text", "text": "perm=" + ack},
									},
								},
							})
						case "large":
							big := strings.Repeat("A", 512*1024)
							writeLine(map[string]any{
								"jsonrpc": "2.0",
								"method":  "session/update",
								"params": map[string]any{
									"sessionId": sid,
									"update": map[string]any{
										"sessionUpdate": "agent_message_chunk",
										"content":       map[string]string{"type": "text", "text": big},
									},
								},
							})
						case "slow_cancel":
							select {
							case <-cancelCh:
								return
							case <-time.After(3 * time.Second):
							}
						case "slow_concurrent":
							time.Sleep(120 * time.Millisecond)
							writeLine(map[string]any{
								"jsonrpc": "2.0",
								"method":  "session/update",
								"params": map[string]any{
									"sessionId": sid,
									"update": map[string]any{
										"sessionUpdate": "agent_message_chunk",
										"content":       map[string]string{"type": "text", "text": "ok"},
									},
								},
							})
						default:
							writeLine(map[string]any{
								"jsonrpc": "2.0",
								"method":  "session/update",
								"params": map[string]any{
									"sessionId": sid,
									"update": map[string]any{
										"sessionUpdate": "agent_thought_chunk",
										"content":       map[string]string{"type": "text", "text": "secret-thought"},
									},
								},
							})
							writeLine(map[string]any{
								"jsonrpc": "2.0",
								"method":  "session/update",
								"params": map[string]any{
									"sessionId": sid,
									"update": map[string]any{
										"sessionUpdate": "usage_update",
										"content":       map[string]string{"type": "text", "text": "ignored"},
									},
								},
							})
							writeLine(map[string]any{
								"jsonrpc": "2.0",
								"method":  "session/update",
								"params": map[string]any{
									"sessionId": sid,
									"update": map[string]any{
										"sessionUpdate": "agent_message_chunk",
										"content":       map[string]string{"type": "text", "text": "Hello "},
									},
								},
							})
							writeLine(map[string]any{
								"jsonrpc": "2.0",
								"method":  "session/update",
								"params": map[string]any{
									"sessionId": sid,
									"update": map[string]any{
										"sessionUpdate": "agent_message_chunk",
										"content":       map[string]string{"type": "text", "text": "world!"},
									},
								},
							})
						}

						writeLine(map[string]any{
							"jsonrpc": "2.0",
							"id":      reqID,
							"result": map[string]any{
								"stopReason": "end_turn",
								"usage": map[string]int{
									"inputTokens":   10,
									"outputTokens":  5,
									"thoughtTokens": 2,
									"totalTokens":   17,
								},
							},
						})
					}(env.ID, p.SessionID)

				case "session/cancel":
					var p struct {
						SessionID string `json:"sessionId"`
					}
					_ = json.Unmarshal(env.Params, &p)
					cancelCh <- p.SessionID

				case "session/close":
					writeLine(map[string]any{
						"jsonrpc": "2.0",
						"id":      env.ID,
						"result":  map[string]any{},
					})
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func buildConfigOptions(modelID string) []map[string]any {
	opts := []map[string]any{
		{
			"id":           "model",
			"name":         "Model",
			"category":     "model",
			"type":         "select",
			"currentValue": modelID,
			"options": []map[string]string{
				{"value": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)"},
				{"value": "gemini-4-neon", "name": "Gemini 4 (Neon)"},
			},
		},
	}
	if modelID == "gemini-4-neon" {
		opts = append(opts, map[string]any{
			"id":           "thought_level",
			"name":         "Thought Level",
			"category":     "reasoning",
			"type":         "select",
			"currentValue": "medium",
			"options": []map[string]string{
				{"value": "low", "name": "Low"},
				{"value": "medium", "name": "Medium"},
				{"value": "high", "name": "High"},
				{"value": "xhigh", "name": "Extra High"},
			},
		})
	}
	return opts
}

func newHelperCommandFactory(extraEnv map[string]string) func(ctx context.Context, bin string, args ...string) *exec.Cmd {
	return func(ctx context.Context, bin string, args ...string) *exec.Cmd {
		cmdArgs := append([]string{"-test.run=TestHelperProcess", "--"}, args...)
		cmd := exec.CommandContext(ctx, os.Args[0], cmdArgs...)
		env := append(os.Environ(), "GO_WANT_ACP_HELPER=1")
		for k, v := range extraEnv {
			env = append(env, k+"="+v)
		}
		cmd.Env = env
		return cmd
	}
}

func TestClientWarmListModelsAndOrchestratorQuirk(t *testing.T) {
	scratch := t.TempDir()
	promptLog := filepath.Join(scratch, "prompt.txt")
	c := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     scratch,
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(map[string]string{
			"ACP_PROMPT_LOG": promptLog,
		}),
	})
	defer c.Close()

	ctx := context.Background()
	if err := c.Warm(ctx); err != nil {
		t.Fatalf("Warm failed: %v", err)
	}
	if !c.Healthy() {
		t.Fatal("expected client to be healthy after Warm")
	}

	models, err := c.ListModels(ctx)
	if err != nil {
		t.Fatalf("ListModels failed: %v", err)
	}
	if len(models) != 2 || models[0].ID != "gemini-pro-orchestrator-neon" {
		t.Fatalf("unexpected models: %+v", models)
	}

	// Orchestrator model does NOT support thought_level; must not error with -32602.
	res, err := c.Chat(ctx, ChatRequest{
		Model:  "gemini-pro-orchestrator-neon",
		Effort: "medium",
		Format: "json",
		Messages: []ChatMessage{
			{Role: "system", Content: "Be concise."},
			{Role: "user", Content: "Say hi"},
		},
	})
	if err != nil {
		t.Fatalf("Chat failed: %v", err)
	}
	if res.Content != "Hello world!" {
		t.Fatalf("expected concatenated agent_message_chunk 'Hello world!', got %q", res.Content)
	}
	if res.EffortApplied {
		t.Fatal("expected EffortApplied=false for gemini-pro-orchestrator-neon")
	}
	if res.Usage.TotalTokens != 17 {
		t.Fatalf("expected totalTokens 17, got %+v", res.Usage)
	}

	logged, err := os.ReadFile(promptLog)
	if err != nil {
		t.Fatalf("read prompt log: %v", err)
	}
	if !strings.Contains(string(logged), "[System]\nBe concise.") || !strings.Contains(string(logged), "Output valid JSON only") {
		t.Fatalf("unexpected formatted prompt: %q", string(logged))
	}
}

func TestClientModelAliasAndThoughtLevel(t *testing.T) {
	c := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     t.TempDir(),
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(nil),
	})
	defer c.Close()

	res, err := c.Chat(context.Background(), ChatRequest{
		Model: "gemini-4-neon-high",
		Messages: []ChatMessage{
			{Role: "user", Content: "test"},
		},
	})
	if err != nil {
		t.Fatalf("Chat failed: %v", err)
	}
	if res.AppliedModel != "gemini-4-neon" {
		t.Fatalf("expected AppliedModel=gemini-4-neon, got %q", res.AppliedModel)
	}
	if !res.EffortApplied || res.AppliedEffort != "high" {
		t.Fatalf("expected EffortApplied=true, AppliedEffort=high, got %v %q", res.EffortApplied, res.AppliedEffort)
	}
}

func TestClientPermissionRejectionAndLargePayload(t *testing.T) {
	c := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     t.TempDir(),
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(map[string]string{
			"ACP_HELPER_MODE": "permission",
		}),
	})
	defer c.Close()

	res, err := c.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{Role: "user", Content: "run tool"}},
	})
	if err != nil {
		t.Fatalf("Chat failed: %v", err)
	}
	if res.Content != "perm=selected:reject-1" {
		t.Fatalf("expected permission rejection outcome, got %q", res.Content)
	}

	cLarge := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     t.TempDir(),
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(map[string]string{
			"ACP_HELPER_MODE": "large",
		}),
	})
	defer cLarge.Close()

	resLarge, err := cLarge.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{Role: "user", Content: "big"}},
	})
	if err != nil {
		t.Fatalf("large Chat failed: %v", err)
	}
	if len(resLarge.Content) != 512*1024 {
		t.Fatalf("expected 512KB content, got %d bytes", len(resLarge.Content))
	}
}

func TestClientCrashRecoveryAndAuthError(t *testing.T) {
	crashMarker := filepath.Join(t.TempDir(), "crashed")
	c := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     t.TempDir(),
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(map[string]string{
			"ACP_HELPER_MODE":  "crash_once",
			"ACP_CRASH_MARKER": crashMarker,
		}),
	})
	defer c.Close()

	res, err := c.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{Role: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatalf("expected transparent retry after pre-prompt crash, got %v", err)
	}
	if res.Content != "Hello world!" {
		t.Fatalf("unexpected content after retry: %q", res.Content)
	}

	cAuth := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     t.TempDir(),
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(map[string]string{
			"ACP_HELPER_MODE": "auth_error",
		}),
	})
	defer cAuth.Close()

	_, err = cAuth.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{Role: "user", Content: "hello"}},
	})
	if !errors.Is(err, ErrAuthRequired) {
		t.Fatalf("expected ErrAuthRequired, got %v", err)
	}
}

func TestClientCancelAndConcurrencyLimit(t *testing.T) {
	cCancel := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     t.TempDir(),
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(map[string]string{
			"ACP_HELPER_MODE": "slow_cancel",
		}),
	})
	defer cCancel.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_, err := cCancel.Chat(ctx, ChatRequest{
		Messages: []ChatMessage{{Role: "user", Content: "wait"}},
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}

	cSem := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     t.TempDir(),
		MaxConcurrent:  2,
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(map[string]string{
			"ACP_HELPER_MODE": "slow_concurrent",
		}),
	})
	defer cSem.Close()

	var wg sync.WaitGroup
	var okCount atomic.Int32
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := cSem.Chat(context.Background(), ChatRequest{
				Messages: []ChatMessage{{Role: "user", Content: "hi"}},
			}); err == nil {
				okCount.Add(1)
			}
		}()
	}
	wg.Wait()
	if okCount.Load() != 3 {
		t.Fatalf("expected all 3 bounded concurrent chats to succeed, got %d", okCount.Load())
	}
}
