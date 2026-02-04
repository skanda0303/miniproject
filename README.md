# Drive Intelligence Agent

An AI-powered Google Drive organization assistant that automatically analyzes, categorizes, and helps you search through your files.

## Features

- 🤖 **Automatic File Analysis**: Uses Google Gemini AI to analyze and summarize your Drive files
- 📁 **Smart Categorization**: Automatically suggests organizing files into folders (Finance, Legal, Education, Projects, Personal, Tech, Work, Resumes)
- 💬 **AI Chat**: Ask questions about your files using natural language
- 🔄 **Auto-Sync**: Periodic scanning to keep your Drive organized
- 📊 **Dashboard**: Beautiful web interface to view inventory, suggestions, and chat with your Drive

## Tech Stack

- **Frontend**: React + Vite
- **Backend**: Node.js + Express
- **AI**: Google Gemini API (gemini-flash-lite-latest)
- **Database**: SQLite
- **APIs**: Google Drive API, Google OAuth2

## Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/skanda0303/miniproject.git
   cd miniproject
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   - Copy `.env.example` to `.env`
   - Add your Google API credentials and Gemini API key

4. **Run the application**
   ```bash
   npm run dev
   ```

5. **Access the dashboard**
   - Frontend: http://localhost:5173
   - Backend: http://localhost:3001

## Environment Variables

```env
GEMINI_API_KEY=your_gemini_api_key
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URL=http://localhost:3001/auth/callback
PORT=3001
```

## API Endpoints

- `GET /api/status` - Get agent status and file count
- `GET /api/files` - Get all analyzed files
- `GET /api/suggestions` - Get reorganization suggestions
- `POST /api/scan` - Trigger manual Drive scan
- `POST /api/reset` - Clear database and restart analysis
- `POST /api/ask` - Ask questions about your files
- `POST /api/approve` - Approve file reorganization

## License

MIT
