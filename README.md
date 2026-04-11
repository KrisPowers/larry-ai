# Larry AI

A local multi-panel chat UI for Ollama, built with React + TypeScript + Vite and packaged for desktop with a Go + Wails backend.

## Requirements

- [Node.js](https://nodejs.org/) v18+
- [Go](https://go.dev/) v1.22+
- [Wails CLI](https://wails.io/docs/gettingstarted/installation)
- [Ollama](https://ollama.com/) running locally

## Browser Development

```bash
# 1. Install dependencies
npm install

# 2. Start Ollama with CORS enabled
OLLAMA_ORIGINS=* ollama serve
# On Windows (PowerShell):
# $env:OLLAMA_ORIGINS="*"; ollama serve

# 3. Start the browser-only dev server
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in your browser.

## Desktop Development

```bash
npm run desktop:dev
```

Desktop mode routes Ollama requests through the Go backend, so it can talk to a local Ollama instance without browser CORS setup.

The Wails backend stores chats, settings, workspaces, and reply memory in a local SQLite database file under your user config directory.

## Build for production

```bash
npm run build
npm run preview
```

## Build the desktop app

```bash
npm run desktop:build
```

## Features

- Up to 3 side-by-side chat panels
- Per-panel model selection (auto-fetched from Ollama and hosted providers)
- Streaming responses token-by-token
- Stop generation mid-stream
- Code block detection with syntax badge, copy, and download buttons
- Inline markdown rendering (headings, bold/italic, lists, blockquotes, tables, inline code)
- Desktop SQL persistence for chats, workspaces, reply memory, and app settings when running under Wails
- Browser fallback persistence so the web-only build still works with IndexedDB and local storage
- History modal with search and delete
- Chat rename (click the title in the panel header)
- Toast notifications

## Roadmap

- Chats can reference other chats
- Safer workspace file editing locked to a Larry AI project directory
