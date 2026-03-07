# Ollama Chat UI

A local multi-panel chat UI for Ollama, built with React + TypeScript + Vite.

## Requirements

- [Node.js](https://nodejs.org/) v18+
- [Ollama](https://ollama.com/) running locally

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Start Ollama with CORS enabled
OLLAMA_ORIGINS=* ollama serve
# On Windows (PowerShell):
# $env:OLLAMA_ORIGINS="*"; ollama serve

# 3. Start the dev server
npm run dev
```

Then open http://localhost:5173 in your browser.

## Build for production

```bash
npm run build
npm run preview
```

## Features

- Up to 3 side-by-side chat panels
- Per-panel model selection (auto-fetched from Ollama)
- Streaming responses token-by-token
- Stop generation mid-stream
- Code block detection with syntax badge, copy, and **download** buttons
  - Supports: JS/TS/JSX/TSX, MD, HTML/CSS/SCSS, Python, JSON, Bash, SQL, YAML, and more
- Inline markdown rendering (headings, bold/italic, lists, blockquotes, tables, inline code)
- IndexedDB persistence — all chats saved locally, no size limit
- History modal with search + delete
- Chat rename (click the title in the panel header)
- Toast notifications

Roadmap:
Chat's able to reference other chat's
Node.js FS to edit files in a Larry-AI directory in real-time (locked to the Larry-AI directory to prevent mass-purges, and worse.)