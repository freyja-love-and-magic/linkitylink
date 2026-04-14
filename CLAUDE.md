# Linkitylink

A privacy-first link page service (formerly Glyphenge). Create beautiful, shareable link pages without tracking or surveillance.

**Part of**: [The Advancement](../third-party/wiki-plugin-linkitylink/THE-ADVANCEMENT.md) - Rebuilding known platforms for communities

## Overview

Linkitylink creates beautiful SVG-based link pages from user-provided links. Users can share their pages via human-memorable emojicodes or browser-friendly alphanumeric URLs.

**Replaces**: Linktree, Beacons, Link-in-bio services
**Cost**: $4.99 one-time (vs $10+/month)
**Port**: 6010 (default, wiki plugin servers use 6000 range)

## Architecture

- **Server-Side SVG Rendering**: All SVG generation happens server-side
- **BDO Storage**: Links stored as public BDOs with emojicode identifiers
- **Three Adaptive Templates**:
  - Compact (1-6 links)
  - Grid (7-13 links)
  - Dense (14-20 links)

## Quick Start

```bash
npm install
npm start
```

Server runs on `http://localhost:6010`

## API Endpoints

### Create Link Page
```bash
POST /create
Content-Type: application/json

{
  "title": "My Links",
  "links": [
    {"title": "GitHub", "url": "https://github.com/user"},
    {"title": "Twitter", "url": "https://twitter.com/user"}
  ]
}

# Response
{
  "success": true,
  "emojicode": "🔗💎🌟🎨🐉📌🌍🔑",
  "pubKey": "02a1b2c3...",
  "uuid": "abc123..."
}
```

### View Link Page

By emojicode (persistent):
```
GET /?emojicode=🔗💎🌟🎨🐉📌🌍🔑
```

By alphanumeric URL (browser-friendly):
```
GET /t/02a1b2c3d4e5f6a7
```

## Environment Variables

```bash
PORT=6010
BDO_BASE_URL=http://localhost:3003
FOUNT_BASE_URL=http://localhost:3001
ADDIE_BASE_URL=http://localhost:3009
NODE_ENV=development
```

## Wiki Integration

Linkitylink is designed to be an optional add-on to federated wiki deployments. It provides link aggregation pages for wiki users without requiring the full Planet Nine ecosystem.

### Fedwiki Plugin: wiki-plugin-linkitylink

The [wiki-plugin-linkitylink](../third-party/wiki-plugin-linkitylink) package demonstrates the **Service-Bundling Plugin Pattern** for fedwiki. This pattern allows a standalone Node.js service (like linkitylink) to be seamlessly integrated into fedwiki as an npm-installable plugin.

**Key Features:**
- **Automatic Service Spawning**: Plugin spawns linkitylink as a child process when wiki starts
- **Transparent Proxying**: Routes `/plugin/linkitylink/*` to the running service
- **Version Management UI**: Traffic light indicator (◉) shows update status, one-click updates
- **Zero Configuration**: Works out of the box with sensible defaults

**For Implementation Details:**
See [wiki-plugin-linkitylink/CLAUDE.md](../third-party/wiki-plugin-linkitylink/CLAUDE.md) for the complete Service-Bundling Plugin Pattern documentation. This pattern is reusable for any fedwiki plugin that needs to integrate an external service.

**Installation:**
```bash
# Via plugmatic (recommended)
# Add "linkitylink" to a plugmatic item in your wiki

# Or via npm
npm install wiki-plugin-linkitylink
```

Once installed, linkitylink becomes available at `https://your-wiki.com/plugin/linkitylink/` with no additional configuration required.

## Development

### Dependencies
- express
- express-session
- bdo-js (for BDO storage)
- sessionless-node (for key generation)
- addie-js (for payments)
- fount-js (for user data)

### File Structure
```
linkitylink/
├── server.js          # Main Express server
├── package.json       # Dependencies
├── public/            # Static files
│   ├── index.html     # Landing page
│   └── create.html    # Create page
└── CLAUDE.md          # This file
```

## Key Features

- Privacy-first: No tracking or surveillance
- Beautiful SVG templates with gradient colors
- Shareable via emojicodes or alphanumeric URLs
- Optional Stripe payment integration
- Session-based user accounts
- Linktree import capability
- **User-Submitted Templates**: Users can submit custom templates and earn revenue when they're used (November 2025)

## User-Submitted Templates (November 2025)

Linkitylink supports a creator economy where users can design and submit custom SVG templates, earning a portion of each linkitylink purchase that uses their design.

### How It Works

1. **Template Submission** (600 MP)
   - Users cast the `submitLinkitylinkTemplate` spell through The Advancement app
   - Submit template with colors, linkColors, and a payee quad emojicode
   - Template is stored as a public BDO with type `linkitylink-template`

2. **Revenue Sharing**
   - Template BDO contains the creator's `payeeEmojicode` (pointing to a payee quad BDO)
   - When a linkitylink is purchased using that template, the template emojicode is passed as a `relevantBDO`
   - Payment processing automatically fetches the template BDO and extracts the payee quad
   - Creator receives their share via the existing payment splits system

3. **Template Discovery**
   - `GET /templates` endpoint queries BDO service for all templates with hash `Linkitylink-Template`
   - BDO service maintains Redis SET index of template emojicodes
   - Results cached for 5 minutes to reduce load
   - Templates displayed in create.html carousel alongside built-in templates
   - Users can select any template when creating their linkitylink

### Multi-Instance Architecture

Templates are stored centrally in the BDO service, enabling template sharing across multiple linkitylink instances:

**Problem**: Multiple linkitylink instances (foo.linkityl.ink, bar.linkityl.ink, etc.) need access to the same template pool.

**Solution**: Templates stored as BDOs with centralized indexing:
- Template BDOs created with hash `Linkitylink-Template`
- BDO service maintains Redis SET: `templates:Linkitylink-Template`
- Linkitylink adds templates to index via POST `/templates/Linkitylink-Template/add`
- All linkitylink instances query same BDO service via GET `/templates/Linkitylink-Template`
- 5-minute cache reduces query load

This enables a federated template marketplace where templates submitted to any linkitylink instance are available to all instances sharing the same BDO service.

### Template BDO Structure

```json
{
  "type": "linkitylink-template",
  "name": "Sunset Gradient",
  "colors": ["#ff6b6b", "#ee5a6f", "#feca57"],
  "linkColors": ["#10b981", "#3b82f6", "#8b5cf6", "#ec4899"],
  "payeeEmojicode": "🔗💎🌟🎨🐉📌🌍🔑",
  "creatorPubKey": "02abc123...",
  "submittedAt": "2025-11-30T...",
  "status": "active"
}
```

### MAGIC Spell: `submitLinkitylinkTemplate`

**Cost**: 600 MP

**Payload**:
```json
{
  "paymentMethod": "mp",
  "template": {
    "name": "Sunset Gradient",
    "colors": ["#ff6b6b", "#ee5a6f", "#feca57"],
    "linkColors": ["#10b981", "#3b82f6", "#8b5cf6", "#ec4899"]
  },
  "payeeQuadEmojicode": "🔗💎🌟🎨🐉📌🌍🔑"
}
```

**Response**:
```json
{
  "success": true,
  "uuid": "template_uuid",
  "pubKey": "02...",
  "emojicode": "🎨💎🌟...",
  "templateName": "Sunset Gradient",
  "message": "Template submitted successfully!"
}
```

### Payment Flow with Templates

1. User selects a template on create.html
2. Template's emojicode is added to `relevantBDOs` array
3. When payment intent is created:
   - `relevantBDOsMiddleware` extracts template emojicode
   - `fetchAndExtractPayees()` fetches template BDO
   - Template BDO's `payeeEmojicode` is resolved to get payee quad
   - Payee quad's payees are added to payment split
4. Template creator receives their share automatically

This creates a self-sustaining design marketplace where creators earn from their contributions to the Linkitylink ecosystem.

### iOS App Implementation

**Files**:
- `LinkitylinkTemplateSubmissionViewController.swift` - Main view controller
- `Resources/LinkitylinkTemplateSubmission.html` - UI with color pickers and live preview

**Features**:
- **Color Pickers**: Interactive color selectors for background and link colors
- **Live Preview**: Real-time SVG preview updates as colors change
- **Minimum Validation**: Requires at least 2 background colors and 2 link colors
- **Payee Quad Integration**: Users enter their payee quad emojicode to receive earnings
- **MAGIC Spell Casting**: Direct integration with Fount's spell resolver
- **Success Display**: Shows template emojicode after successful submission

**User Flow**:
1. Open Template Submission view from CarrierBag
2. Enter template name
3. Add/edit background gradient colors (minimum 2)
4. Add/edit link card colors (minimum 2)
5. Preview updates in real-time
6. Enter payee quad emojicode
7. Tap "Submit Template (600 MP)"
8. Spell is cast via Fount
9. Template BDO created and made public
10. Emojicode displayed (tap to copy)

**Navigation**: Accessible from CarrierBag or Enchantment Emporium

## History

Originally named "Glyphenge" as part of The Advancement project. Extracted as standalone service in November 2025 to enable wiki integration without full ecosystem dependencies.

**November 2025**: Added user-submitted template system with revenue sharing to enable a creator economy for link page designs.
