# Upwork Buddy - AI Proposal Assistant

An intelligent Chrome extension (currently a JavaScript snippet) that analyzes Upwork job postings and generates comprehensive proposals using Google's Gemini AI.

## Features

🤖 **AI-Powered Proposal Generation**
- Analyzes job descriptions and generates compelling, tailored proposals
- Matches your profile and skills to the job requirements
- Uses semantic analysis to match the right tone

📋 **Spec Sheet Generation**
- Creates detailed prompts for AI coding agents (GitHub Copilot, Jules)
- Generates technical specifications and implementation plans

⏱️ **Time Estimation**
- Provides realistic project timelines
- Breaks down work by phases

🤝 **Workload Division**
- Suggests optimal division between AI agents and human work
- Identifies tasks suitable for automation vs. those requiring human judgment

❓ **Client Questions**
- Generates strategic questions to ask clients
- Helps clarify requirements and set expectations

💡 **Tips & Advice**
- Provides best practices for client communication
- Offers guidance on deliverables, QA, and handoff

## Setup

### 1. Get a Gemini API Key

1. Visit [Google AI Studio](https://aistudio.google.com/)
2. Create an API key
3. Add it to your `.env` file:

```bash
GEMINI_API_KEY=your_actual_api_key_here
```

### 2. Start the API Server

```bash
# Make sure PostgreSQL is running
make docker-run

# Start the API server
PORT=9090 go run cmd/api/main.go
```

### 3. Test the Snippet

Open `js/test-page.html` in your browser:

```bash
cd /var/www/upwork-buddy/js
open test-page.html  # macOS
# or
xdg-open test-page.html  # Linux
# or just open it in your browser
```

Click "Activate AI Assistant" and then "Analyze This Job" on any job card.

## Usage

### As a JavaScript Snippet (Current)

1. Open the Upwork job search page
2. Open browser console (F12)
3. Copy and paste the contents of `js/upwork-buddy-snippet.js`
4. Press Enter
5. AI Assistant panels will appear on each job card

### As a Bookmarklet

Create a bookmark with this URL (minified version of the snippet):

```javascript
javascript:(function(){/* paste minified upwork-buddy-snippet.js here */})();
```

### As a Chrome Extension (Future)

Coming soon! The architecture is already set up for easy transition to a Chrome extension.

## API Endpoints

### POST `/api/analyze-job`

Analyzes a job posting and generates a comprehensive response.

**Request Body:**
```json
{
  "job_title": "Full-Stack Developer for SaaS Platform",
  "job_description": "We're building a modern SaaS platform...",
  "budget": "$5,000 - $10,000",
  "skills": "Go, React, PostgreSQL, Docker",
  "user_profile": "Experienced full-stack developer...",
  "user_skills": "Go, JavaScript, TypeScript, React..."
}
```

**Response:**
```json
{
  "proposal": "Compelling proposal text...",
  "spec_sheet_prompt": "Detailed prompt for AI agents...",
  "time_estimate": "Timeline breakdown...",
  "workload_division": "AI vs Human work distribution...",
  "questions_for_client": ["Question 1", "Question 2"...],
  "tips_and_advice": ["Tip 1", "Tip 2"...],
  "tone_analysis": "Analysis of job posting tone..."
}
```

## Architecture

```
Browser/Extension → Go API Server → Google Gemini AI
```

**Why this architecture?**
- ✅ API keys stay secure (server-side only)
- ✅ Request logging and analytics
- ✅ Rate limiting and caching
- ✅ Easy to add database storage for proposals
- ✅ Works with any frontend (snippet, extension, mobile app)

## Customization

Edit `js/upwork-buddy-snippet.js` to customize:

- `API_BASE_URL` - Your API server URL
- `USER_PROFILE` - Your professional profile
- `USER_SKILLS` - Your skill set

The AI will use these to tailor proposals to your background.

## Next Steps

- [ ] Add database models to store proposals and analyses
- [ ] Implement caching to avoid re-analyzing the same jobs
- [ ] Add user authentication and profiles
- [ ] Build Chrome extension manifest and packaging
- [ ] Add ability to export proposals to clipboard/file
- [ ] Implement proposal editing and refinement
- [ ] Add usage analytics and rate limiting

## Development

```bash
# Run with hot reload
make watch

# Test the API directly
curl -X POST http://localhost:9090/api/analyze-job \
  -H "Content-Type: application/json" \
  -d '{
    "job_title": "Test Job",
    "job_description": "Test description",
    "user_profile": "Test profile",
    "user_skills": "Test skills"
  }'
```

## Troubleshooting

**API Error: Service unavailable**
- Make sure `GEMINI_API_KEY` is set in `.env`
- Verify your API key is valid at [Google AI Studio](https://aistudio.google.com/)

**CORS Error**
- The API has CORS enabled for all origins during development
- For production, configure specific allowed origins

**No job cards found**
- The script looks for common Upwork selectors
- Upwork may have updated their HTML structure
- Check browser console for detailed logs

## Contributing

This is a work in progress! Feel free to:
- Report bugs
- Suggest features
- Submit pull requests
- Share your experience

## License

MIT
