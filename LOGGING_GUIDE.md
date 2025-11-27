# Upwork Buddy - Logging Guide

## Log File Locations

- **Backend (Go):** `/tmp/upwork-buddy.log` 
  - Monitor in real-time: `tail -f /tmp/upwork-buddy.log`
  - View recent entries: `tail -50 /tmp/upwork-buddy.log`
  
- **Frontend (TypeScript):** Browser DevTools Console (F12 → Console tab)

## Overview
Comprehensive logging has been added throughout the application to help diagnose issues, especially JSON parsing problems from the Gemini API.

## Backend Logging (Go)

### Location: `internal/gemini/service.go`

**AnalyzeJob Method:**
- Logs job analysis requests with title, budget, and skills
- Logs prompt length sent to Gemini
- Logs response status and result lengths

**parseResponse Method (Enhanced):**
- **Raw Response Logging**: First 500 characters of raw Gemini response
- **Markdown Stripping**: Shows before/after lengths when code blocks are removed
- **Stripped JSON**: First 300 characters after markdown removal
- **Parse Success**: Logs field lengths when successful
- **Parse Failure**: Logs detailed error information including:
  - Error type and message
  - Byte offset of syntax errors
  - Context around the error (200 chars)
  - First 500 chars of failed content
- **Nested JSON Detection**: Logs when proposal field contains nested JSON

Example log output:
```
parseResponse: RAW RESPONSE START
```json
{
  "proposal": "Hello...",
...
parseResponse: RAW RESPONSE END
parseResponse: stripped markdown wrapper (before=1234, after=1200)
parseResponse: ✅ json.Unmarshal succeeded
parseResponse: proposal length=456, spec_sheet length=789, questions=5, tips=6
```

### Location: `internal/server/handlers.go`

**analyzeJobHandler (Enhanced):**
- Request start/end markers: `=== ANALYZE JOB REQUEST START/END ===`
- Request details: title, budget, skills, profile/skills lengths
- Service creation status
- Analysis completion with result lengths
- Response encoding status

Example log output:
```
=== ANALYZE JOB REQUEST START ===
📥 Received request: title="Full Stack Developer", budget="$500-$1000", skills="Go, React", profile_length=245, user_skills_length=89
✅ Analysis complete: proposal_length=456, spec_sheet_length=789, questions=5, tips=6
📤 Response sent successfully
=== ANALYZE JOB REQUEST END ===
```

## Frontend Logging (TypeScript)

### Location: `js/src/api.ts`

**analyzeJob Method (Enhanced):**
- Request details: title, description length, budget, skills, profile lengths
- Response status code
- Received data with field lengths
- Error details on failure

Example console output:
```
🚀 API: Sending analyze request {title: "...", descriptionLength: 1234, ...}
📡 API: Response status 200 OK
✅ API: Received response {proposalLength: 456, specSheetLength: 789, ...}
```

### Location: `js/src/utils.ts`

**renderValue Function (Enhanced):**
- Logs type, depth, and array status for each value
- For strings: logs length and first 50 characters
- For JSON parse attempts:
  - Success: logs parsed type and whether it's object/array
  - Decision: whether treating as nested JSON or plain text
  - Failure: logs "not valid JSON"
- For arrays: logs item count
- For objects: logs all keys

Example console output:
```
🔍 renderValue: type=string, depth=0, isArray=false stringLength=1234
🔍 renderValue: processing string, length=1234, first50="This is a professional proposal..."
⚠️ renderValue: not valid JSON, rendering as plain text
```

**renderAnalysis Function (Enhanced):**
- Logs all response keys
- Logs length of each field:
  - proposal, spec_sheet_prompt, time_estimate, workload_division
  - questions_for_client (array length), tips_and_advice (array length)
  - tone_analysis

Example console output:
```
🎨 renderAnalysis: Starting render with keys: ["proposal", "spec_sheet_prompt", ...]
🎨 renderAnalysis: Field lengths: {proposal: 456, spec_sheet_prompt: 789, ...}
📄 Rendering section: proposal
```

## How to Use These Logs

### Diagnosing JSON Parse Errors

1. **Check Backend Logs** (`make run` output):
   ```bash
   # Look for these patterns:
   parseResponse: RAW RESPONSE START
   parseResponse: ❌ json.Unmarshal FAILED
   parseResponse: JSON syntax error at byte offset
   ```

2. **Check Browser Console** (F12 → Console tab):
   ```javascript
   // Look for these patterns:
   🚀 API: Sending analyze request
   📡 API: Response status
   ✅ API: Received response
   🔍 renderValue: processing string
   ```

### Common Issues to Look For

**Issue: "Failed to parse response. Please check the API server logs."**
- Backend logs will show the raw Gemini response
- Look for `parseResponse: ❌ json.Unmarshal FAILED`
- Check the error context for invalid JSON characters

**Issue: JSON dump in UI**
- Frontend logs will show `renderValue: type=string, stringLength=...`
- Should see decision: "treating as nested JSON" vs "rendering as plain text"
- If plain text is being rendered as JSON, check the type guard logic

**Issue: Missing sections**
- Check `renderAnalysis: Field lengths` - are fields empty?
- Backend should show `Analysis complete: proposal_length=0` if field is missing
- Gemini may not be returning complete JSON structure

## Restart After Changes

After modifying logging code:

```bash
# Backend changes
make build
make run

# Frontend changes
cd js
npm run build
# Then refresh bookmarklet in browser
```

## Log Verbosity

Current logging is comprehensive for debugging. Once issues are resolved, you can:
- Remove console.log statements from TypeScript (they're compiled out in production builds with console purging)
- Keep Go logs as they're server-side and won't affect client performance
- Or add log level configuration (DEBUG, INFO, WARN, ERROR)

## Emoji Guide

- 🚀 Starting request
- 📥 Receiving data
- 📤 Sending data
- ✅ Success
- ❌ Error/failure
- ⚠️ Warning/fallback behavior
- 🔍 Inspection/debugging
- 🎨 Rendering/UI
- 📄 Processing section
- 📋 Lists/collections
- 🤖 AI/automation related
