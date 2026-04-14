# Linkitylink

> **🎉 This is the code for wiki-based federated distribution of software apps.**
>
> Linkitylink serves as the reference implementation for distributable applications via Federated Wiki, demonstrating how standalone services can be packaged, installed, updated, and forked through wiki infrastructure.

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

Server runs on `http://localhost:6010`

## Usage

### Create a Link Page

```bash
curl -X POST http://localhost:6010/create \
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
http://localhost:6010?emojicode=🔗💎🌟🎨🐉📌🌍🔑
```

Via alphanumeric URL (browser-friendly):
```
http://localhost:6010/t/02a1b2c3d4e5f6a7
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
PORT=6010                                    # Server port
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
curl http://localhost:6010
```

## Wiki Integration - Federated App Distribution

Linkitylink demonstrates **wiki-based federated distribution of software applications** through the [wiki-plugin-linkitylink](../third-party/wiki-plugin-linkitylink) package.

### What This Means

Traditional software distribution requires:
- ❌ Centralized app stores
- ❌ Manual installation and configuration
- ❌ Command-line expertise for updates
- ❌ Separate hosting for each app instance

**Wiki-based federated distribution enables:**
- ✅ **Peer-to-peer app distribution** - Apps spread through wiki federation
- ✅ **One-click installation** - Install via wiki's built-in plugin manager (plugmatic)
- ✅ **Automatic updates** - Traffic light UI shows update status, one-click to upgrade
- ✅ **True forking** - Fork a wiki page, get an independent app instance
- ✅ **Zero configuration** - Apps configure themselves from wiki context
- ✅ **Decentralized hosting** - Each wiki runs its own app instances

### How It Works

1. **Package as npm module** - Linkitylink published to npm registry
2. **Create fedwiki plugin** - [wiki-plugin-linkitylink](../third-party/wiki-plugin-linkitylink) bundles linkitylink as dependency
3. **Automatic spawning** - Plugin spawns linkitylink as child process when wiki starts
4. **Transparent proxying** - `/plugin/linkitylink/*` routes to the running service
5. **Version management** - Built-in UI for checking and updating linkitylink version
6. **Fork propagation** - When users fork wiki pages, they get independent linkitylink instances

### Installation via Fedwiki

```bash
# Users install via plugmatic (fedwiki's plugin manager)
# 1. Add "linkitylink" to a plugmatic item in your wiki
# 2. Click the status indicator to install
# 3. Done! Linkitylink runs at https://your-wiki.com/plugin/linkitylink/
```

No separate hosting, no configuration files, no manual service management.

### For Developers

See the [Service-Bundling Plugin Pattern](../third-party/wiki-plugin-linkitylink/CLAUDE.md) documentation for a complete guide to packaging your own applications for federated wiki distribution.

This pattern is reusable for **any** standalone service or application you want to distribute through fedwiki infrastructure.

## History

Originally developed as "Glyphenge" within The Advancement project. Extracted as a standalone service in November 2025 for easier deployment and wiki integration. Built with Love by Claude.

## License

MIT
