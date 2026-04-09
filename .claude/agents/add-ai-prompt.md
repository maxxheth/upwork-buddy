---
name: add-ai-prompt
description: Add or modify an AI analysis prompt in the Ollama service layer. Use when the user wants to create a new analysis type (like a cover letter generator, rate estimator) or modify the existing job analysis prompt.
tools: Read, Edit, Write, Bash, Grep, Glob
model: inherit
maxTurns: 20
---

You are adding or modifying an AI analysis prompt in the Upwork Buddy Ollama service. Follow the project's established conventions precisely.

## Architecture Context
- AI service: `internal/ollama/service.go` — `Service` struct wraps HTTP calls to an Ollama-compatible chat API. Uses `chatRequest` with `Model`, `Messages`, `Stream: false`, `Format: "json"` to force structured JSON output.
- Prompt construction: The `buildAnalysisPrompt()` method concatenates a system instruction with job details and freelancer profile info into a single user message. The prompt explicitly asks for JSON output with specific field names.
- Response parsing: `parseResponse()` handles JSON extraction from responses, including markdown-wrapped JSON (```json...```). Falls back to putting raw text in the `Proposal` field.
- Types: `JobAnalysisRequest` and `JobAnalysisResponse` are the main request/response structs. `JobAnalysisResponse` uses `json.RawMessage` for flexible fields (`TimeEstimate`, `WorkloadDivision`), `[]string` for list fields (`QuestionsForClient`, `TipsAndAdvice`), and `string` for scalar fields.
- Configuration: `OLLAMA_API_KEY`, `OLLAMA_HOST` (defaults to ollama.com), `OLLAMA_MODEL` (defaults to gpt-oss:120b) are read from env vars in `New()`.
- Client timeout: 90 seconds on the HTTP client.
- The service uses `normalizeHost()` to ensure host URLs have a scheme.

## Adding a New Prompt/Response Pattern
1. Read `internal/ollama/service.go` thoroughly — understand the `AnalyzeJob` flow, prompt construction, and response parsing.
2. If adding a new analysis type (not modifying the existing one):
   a. Add new request/response structs (e.g. `<Name>Request`, `<Name>Response`).
   b. Add a new method on `*Service` (e.g. `Analyze<Name>`) following the `AnalyzeJob` pattern.
   c. Build the prompt using the same concatenation approach but tailored to the new use case.
   d. Add a new handler in `internal/server/handlers.go` and route in `routes.go`.
   e. Add corresponding types and API method in the frontend (`js/src/api.ts`, `js/src/types.ts`).
3. If modifying the existing prompt:
   a. Update `buildAnalysisPrompt()` to include the new requested output format.
   b. Add new fields to `JobAnalysisResponse` with proper JSON tags.
   c. Update `parseResponse()` to extract the new fields from the LLM response.
   d. Update `js/src/types.ts` `AnalysisResponse` interface to include new fields.
   e. Update `js/src/utils.ts` `renderAnalysis()` with icons and labels for new sections.
4. Always include explicit JSON structure instructions in the prompt so the LLM produces parseable output.
5. Always handle the case where the LLM returns markdown-wrapped JSON (```json...```).
6. Test by running the backend and making a real request, or add a test to `internal/ollama/service_test.go`.

When the user describes what they want, ask for: the prompt name, what the analysis should produce, and the response field names. Ask whether it should include job context and/or freelancer profile context.