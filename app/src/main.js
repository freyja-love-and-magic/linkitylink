const { core, dialog, fs } = window.__TAURI__;

// Keep in sync with MAX_LINKS in src-tauri/src/lib.rs.
const MAX_LINKS = 10;

const editView = document.getElementById('edit-view');
const cardView = document.getElementById('card-view');
const form = document.getElementById('card-form');
const statusMsg = document.getElementById('status-msg');
const photoPreview = document.getElementById('photo-preview');
const choosePhotoBtn = document.getElementById('choose-photo-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');
const linkEntriesEl = document.getElementById('link-entries');
const newLinkLabel = document.getElementById('new-link-label');
const newLinkUrl = document.getElementById('new-link-url');
const addLinkBtn = document.getElementById('add-link-btn');
const linkLimitHint = document.getElementById('link-limit-hint');
const importUrlInput = document.getElementById('import-url');
const importLinksBtn = document.getElementById('import-links-btn');
const publishBtn = document.getElementById('publish-btn');
const linkRow = document.getElementById('link-row');
const linkText = document.getElementById('link-text');
const copyLinkBtn = document.getElementById('copy-link-btn');
const shareBtn = document.getElementById('share-btn');

const PHOTO_SIZE = 480;
const PHOTO_QUALITY = 0.85;

let card = null; // the currently loaded/saved LinkCard, or null if never saved
let pendingPhoto = null; // base64 JPEG (no data: prefix), staged from the picker until Save
let pendingLinks = []; // working link-entry array while the edit form is open

// ── View / status helpers ────────────────────────────────────────────────────

function showView(name) {
    editView.hidden = name !== 'edit';
    cardView.hidden = name !== 'card';
}

let statusTimeout = null;
function setStatus(message) {
    statusMsg.textContent = message;
    statusMsg.classList.add('visible');
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => statusMsg.classList.remove('visible'), 2500);
}

function getInitials(name) {
    if (!name) return '?';
    return name
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
}

function setAvatarContent(el, photo, name) {
    if (photo) {
        el.style.backgroundImage = `url(data:image/jpeg;base64,${photo})`;
        el.textContent = '';
    } else {
        el.style.backgroundImage = '';
        el.textContent = getInitials(name);
    }
}

// ── Photo picker ──────────────────────────────────────────────────────────────

async function resizeImageToJpegBase64(bytes) {
    const blob = new Blob([bytes]);
    const bitmap = await createImageBitmap(blob);

    const scale = Math.min(1, PHOTO_SIZE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
    return dataUrl.split(',')[1];
}

choosePhotoBtn.addEventListener('click', async () => {
    try {
        const path = await dialog.open({
            multiple: false,
            filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'heic'] }],
        });
        if (!path) return;

        const bytes = await fs.readFile(path);
        pendingPhoto = await resizeImageToJpegBase64(bytes);
        setAvatarContent(photoPreview, pendingPhoto, '');
    } catch (err) {
        setStatus(`Couldn't set photo: ${err}`);
    }
});

// ── Link list editor ─────────────────────────────────────────────────────────

// Index of the link entry currently open for inline editing (tapped), or
// null if none — only one row edits at a time.
let editingLinkIndex = null;

function renderLinkEntries() {
    linkEntriesEl.innerHTML = '';

    pendingLinks.forEach((entry, index) => {
        const li = document.createElement('li');
        li.className = 'link-entry';

        if (index === editingLinkIndex) {
            const fields = document.createElement('div');
            fields.className = 'link-entry-edit-fields';

            const labelInput = document.createElement('input');
            labelInput.type = 'text';
            labelInput.placeholder = 'Label';
            labelInput.maxLength = 40;
            labelInput.value = entry.label;

            const urlInput = document.createElement('input');
            urlInput.type = 'text';
            urlInput.placeholder = 'URL';
            urlInput.value = entry.url;

            const commit = () => {
                entry.label = labelInput.value.trim();
                entry.url = urlInput.value.trim();
                editingLinkIndex = null;
                renderLinkEntries();
            };
            const onEnter = (e) => { if (e.key === 'Enter') commit(); };
            labelInput.addEventListener('keydown', onEnter);
            urlInput.addEventListener('keydown', onEnter);

            fields.append(labelInput, urlInput);
            li.appendChild(fields);

            const doneBtn = document.createElement('button');
            doneBtn.type = 'button';
            doneBtn.textContent = '✓';
            doneBtn.addEventListener('click', commit);

            const actions = document.createElement('div');
            actions.className = 'link-entry-actions';
            actions.appendChild(doneBtn);
            li.appendChild(actions);

            linkEntriesEl.appendChild(li);
            labelInput.focus();
            return;
        }

        const text = document.createElement('div');
        text.className = 'link-entry-text';
        text.innerHTML = '<div class="link-entry-label"></div><div class="link-entry-url"></div>';
        text.querySelector('.link-entry-label').textContent = entry.label || entry.url;
        text.querySelector('.link-entry-url').textContent = entry.url;
        text.addEventListener('click', () => {
            editingLinkIndex = index;
            renderLinkEntries();
        });
        li.appendChild(text);

        const actions = document.createElement('div');
        actions.className = 'link-entry-actions';

        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.textContent = '↑';
        upBtn.disabled = index === 0;
        upBtn.addEventListener('click', () => {
            [pendingLinks[index - 1], pendingLinks[index]] = [pendingLinks[index], pendingLinks[index - 1]];
            renderLinkEntries();
        });

        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.textContent = '↓';
        downBtn.disabled = index === pendingLinks.length - 1;
        downBtn.addEventListener('click', () => {
            [pendingLinks[index], pendingLinks[index + 1]] = [pendingLinks[index + 1], pendingLinks[index]];
            renderLinkEntries();
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
            pendingLinks.splice(index, 1);
            if (editingLinkIndex === index) editingLinkIndex = null;
            renderLinkEntries();
        });

        actions.append(upBtn, downBtn, removeBtn);
        li.appendChild(actions);
        linkEntriesEl.appendChild(li);
    });

    const atLimit = pendingLinks.length >= MAX_LINKS;
    addLinkBtn.disabled = atLimit;
    importLinksBtn.disabled = atLimit;
    linkLimitHint.hidden = !atLimit;
}

addLinkBtn.addEventListener('click', () => {
    const url = newLinkUrl.value.trim();
    if (!url || pendingLinks.length >= MAX_LINKS) return;

    pendingLinks.push({ id: '', label: newLinkLabel.value.trim(), url });
    newLinkLabel.value = '';
    newLinkUrl.value = '';
    renderLinkEntries();
});

importLinksBtn.addEventListener('click', async () => {
    const url = importUrlInput.value.trim();
    if (!url || pendingLinks.length >= MAX_LINKS) return;

    importLinksBtn.disabled = true;
    setStatus('Importing links…');
    try {
        const imported = await core.invoke('import_links', { url });

        const existingUrls = new Set(pendingLinks.map((l) => normalizeUrl(l.url)));
        const fresh = imported.filter((l) => {
            const key = normalizeUrl(l.url);
            if (existingUrls.has(key)) return false;
            existingUrls.add(key);
            return true;
        });

        const room = MAX_LINKS - pendingLinks.length;
        const toAdd = fresh.slice(0, room);
        pendingLinks.push(...toAdd.map((l) => ({ id: '', label: l.label, url: l.url })));
        renderLinkEntries();
        importUrlInput.value = '';

        if (fresh.length === 0) {
            setStatus('Those links are already on your card.');
        } else if (toAdd.length < fresh.length) {
            setStatus(`Imported ${toAdd.length} of ${fresh.length} new links — the rest were skipped to stay under the ${MAX_LINKS}-link limit.`);
        } else {
            setStatus(`Imported ${toAdd.length} link${toAdd.length === 1 ? '' : 's'}!`);
        }
    } catch (err) {
        setStatus(`Couldn't import: ${err}`);
    } finally {
        // Re-derive from current pendingLinks length (not a hardcoded false) —
        // a successful import may have just filled the list to MAX_LINKS.
        importLinksBtn.disabled = pendingLinks.length >= MAX_LINKS;
    }
});

// ── Form <-> LinkCard ─────────────────────────────────────────────────────────

function cardFromForm() {
    return {
        name: document.getElementById('field-name').value.trim() || undefined,
        bio: document.getElementById('field-bio').value.trim() || undefined,
        photo: pendingPhoto || undefined,
        links: pendingLinks,
    };
}

function fillForm(source) {
    document.getElementById('field-name').value = source?.name || '';
    document.getElementById('field-bio').value = source?.bio || '';
    pendingPhoto = source?.photo || null;
    pendingLinks = (source?.links || []).map((l) => ({ ...l }));
    editingLinkIndex = null;
    setAvatarContent(photoPreview, source?.photo, source?.name || '');
    renderLinkEntries();
}

// ── Card view ─────────────────────────────────────────────────────────────────

// Mirrors normalize_url in src-tauri/src/lib.rs — recognizes a malformed
// scheme (missing colon, single slash) and replaces it with a clean one,
// rather than blindly prepending "https://" in front of it.
function normalizeUrl(url) {
    const trimmed = url.trim();
    const lower = trimmed.toLowerCase();

    let len = null;
    let scheme = null;
    if (lower.startsWith('https')) {
        len = 5;
        scheme = 'https://';
    } else if (lower.startsWith('http')) {
        len = 4;
        scheme = 'http://';
    }

    if (len !== null) {
        const rest = trimmed.slice(len);
        if (rest.startsWith(':') || rest.startsWith('/')) {
            return scheme + rest.replace(/^[:/]+/, '');
        }
    }

    return `https://${trimmed}`;
}

function renderCardView(c) {
    setAvatarContent(document.getElementById('card-avatar'), c.photo, c.name || '');
    document.getElementById('card-name').textContent = c.name || 'Untitled';

    const bioEl = document.getElementById('card-bio');
    bioEl.textContent = c.bio ? `"${c.bio}"` : '';
    bioEl.hidden = !c.bio;

    const linksEl = document.getElementById('card-links');
    linksEl.innerHTML = '';
    for (const entry of c.links || []) {
        if (!entry.url) continue;
        const href = normalizeUrl(entry.url);
        const a = document.createElement('a');
        a.className = 'link-list-item';
        a.href = href;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.innerHTML = '<span></span><span class="arrow">→</span>';
        a.querySelector('span').textContent = entry.label || entry.url;
        linksEl.appendChild(a);
    }
}

function renderPublishLink(c) {
    if (c.shareUrl) {
        linkText.textContent = c.shareUrl;
        linkRow.hidden = false;
        publishBtn.textContent = 'Update Shareable Link';
    } else {
        linkRow.hidden = true;
        publishBtn.textContent = 'Get Shareable Link';
    }
}

function showCard(c) {
    card = c;
    renderCardView(c);
    renderPublishLink(c);
    showView('card');
}

function openEditForm() {
    fillForm(card);
    cancelEditBtn.hidden = !card;
    showView('edit');
}

async function loadCard() {
    card = await core.invoke('load_card');
    if (card) {
        showCard(card);
    } else {
        openEditForm();
    }
}

// The shareable link (a pre-signed savage URL) is available the instant
// publish_card returns — the signature never expires, so it's computed once
// and doesn't need to be refreshed on later shares. Publishing proactively
// in the background after every save keeps the published card in sync with
// the latest edits without requiring an explicit re-publish tap first.
async function backgroundPublish() {
    try {
        const updated = await core.invoke('publish_card');
        card = updated;
        if (!cardView.hidden) renderPublishLink(updated);
    } catch {
        // Best-effort — network hiccups shouldn't surface for a sync the
        // user didn't explicitly ask for.
    }
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        const saved = await core.invoke('save_card', { card: cardFromForm() });
        showCard(saved);
        backgroundPublish();
    } catch (err) {
        setStatus(`Couldn't save: ${err}`);
    }
});

cancelEditBtn.addEventListener('click', () => {
    if (card) showView('card');
});

document.getElementById('edit-btn').addEventListener('click', openEditForm);

publishBtn.addEventListener('click', async () => {
    publishBtn.disabled = true;
    setStatus('Publishing…');
    try {
        const updated = await core.invoke('publish_card');
        card = updated;
        renderPublishLink(updated);
        setStatus('Link ready!');
    } catch (err) {
        setStatus(`Couldn't publish: ${err}`);
    } finally {
        publishBtn.disabled = false;
    }
});

copyLinkBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(linkText.textContent);
        setStatus('Copied!');
    } catch (err) {
        setStatus(`Couldn't copy: ${err}`);
    }
});

shareBtn.addEventListener('click', async () => {
    shareBtn.disabled = true;
    try {
        const url = card?.shareUrl || (await core.invoke('publish_card')).shareUrl;
        await core.invoke('plugin:share-sheet|share_text', { text: url });
    } catch (err) {
        setStatus(`Couldn't share: ${err}`);
    } finally {
        shareBtn.disabled = false;
    }
});

loadCard();
