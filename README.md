# Linkitylink

A privacy-first link page service. Create beautiful, shareable link pages without tracking or surveillance.

## Overview

Linkitylink creates beautiful SVG-based link pages from your links. Share your page via human-memorable emojicodes or browser-friendly alphanumeric URLs.

## Features

- **Privacy-First** - No tracking, no analytics, no surveillance
- **Beautiful SVG Templates** - Three adaptive layouts based on link count
- **Easy Sharing** - Share via emojicode or alphanumeric URL
- **No Account Required** - Create pages instantly via API
- **Optional Payment Integration** - Stripe support for premium features

## Quick Start

```bash
npm install
npm start
```

Server runs on `http://localhost:3010`

## Usage

### Create a Link Page

```bash
curl -X POST http://localhost:3010/create \
  -H "Content-Type: application/json" \
  -d '{
    "title": "My Links",
    "links": [
      {"title": "GitHub", "url": "https://github.com/user"},
      {"title": "Twitter", "url": "https://twitter.com/user"}
    ]
  }'
```

Response:
```json
{
  "success": true,
  "emojicode": "🔗💎🌟🎨🐉📌🌍🔑",
  "pubKey": "02a1b2c3...",
  "uuid": "abc123..."
}
```

### View a Link Page

Via emojicode (persistent):
```
http://localhost:3010?emojicode=🔗💎🌟🎨🐉📌🌍🔑
```

Via alphanumeric URL (browser-friendly):
```
http://localhost:3010/t/02a1b2c3d4e5f6a7
```

## SVG Templates

Link pages automatically adapt based on link count:

- **Compact Layout** (1-6 links) - Large 600x90px cards, vertical stack
- **Grid Layout** (7-13 links) - 2-column grid, 290x80px cards
- **Dense Layout** (14-20 links) - 3-column grid, 190x65px cards

All templates feature:
- Six gradient color schemes
- Dark mode with glowing effects
- Animated particles
- Mobile-responsive design

## Environment Variables

```bash
PORT=3010                                    # Server port
BDO_BASE_URL=http://localhost:3003           # BDO storage service
FOUNT_BASE_URL=http://localhost:3001         # User data service (optional)
ADDIE_BASE_URL=http://localhost:3009         # Payment service (optional)
NODE_ENV=development                          # Environment mode
ENABLE_APP_PURCHASE=false                     # Show "Buy in App" button (default: false)
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | / | Landing page or view page by emojicode |
| GET | /create | Web interface for creating pages |
| POST | /create | API for creating link pages |
| GET | /t/:id | View page by alphanumeric identifier |
| GET | /my-tapestries | List user's created pages |

## Docker

```bash
# Build and run
docker-compose -f docker-compose.standalone.yml up -d --build

# Verify running
curl http://localhost:3010
```

## Wiki Integration

Linkitylink is designed to work as an optional add-on to federated wiki deployments, providing link aggregation pages without requiring the full Planet Nine ecosystem.

## History

Originally developed as "Glyphenge" within The Advancement project. Extracted as a standalone service in November 2025 for easier deployment and wiki integration. Built with Love by Claude.

## License

MIT
