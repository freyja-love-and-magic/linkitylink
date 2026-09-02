const { core, dialog, fs } = window.__TAURI__;

// Keep in sync with MAX_LINKS in src-tauri/src/lib.rs.
const MAX_LINKS = 16;
// Keep in sync with MAX_CARDS in src-tauri/src/lib.rs.
const MAX_CARDS = 4;
// Cap on the canonical profile's field list — keep in sync with
// MAX_PROFILE_FIELDS in src-tauri/src/lib.rs.
const MAX_PROFILE_FIELDS = 20;

// Populated at init from the Rust-side CATEGORIES list (get_categories) —
// shared with idothis's/bizbuz's own taxonomy, see lib.rs. slug -> label.
let categories = [];
let categoryLabels = {};

// Same food-related slugs idothis/bizbuz prompt on — keep in sync with
// lib.rs's CATEGORIES if that list's food entries ever change.
const FOOD_CATEGORY_SLUGS = ['caterer', 'restauranteur', 'chef', 'food_cart', 'baker'];

// localStorage key for the set of card ids already offered the letemcook
// cross-promo prompt, so re-saving a food card never re-nags. Prompted
// once ever per card id, the first time a save lands with category 'food'.
const LETEMCOOK_PROMPTED_KEY = 'linkitylink.letemcookPromptedCardIds';

const cardsView = document.getElementById('cards-view');
const editView = document.getElementById('edit-view');
const cardView = document.getElementById('card-view');
const cardsGrid = document.getElementById('cards-grid');
const form = document.getElementById('card-form');
const statusMsg = document.getElementById('status-msg');
const photoPreview = document.getElementById('photo-preview');
const choosePhotoBtn = document.getElementById('choose-photo-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');
const deleteCardBtn = document.getElementById('delete-card-btn');
const linkEntriesEl = document.getElementById('link-entries');
const newLinkLabel = document.getElementById('new-link-label');
const newLinkUrl = document.getElementById('new-link-url');
const addLinkBtn = document.getElementById('add-link-btn');
const linkLimitHint = document.getElementById('link-limit-hint');
linkLimitHint.textContent = `Up to ${MAX_LINKS} links — remove one to add another.`;
const importUrlInput = document.getElementById('import-url');
const importLinksBtn = document.getElementById('import-links-btn');
const importBizbuzBtn = document.getElementById('import-bizbuz-btn');
const publishBtn = document.getElementById('publish-btn');
const linkRow = document.getElementById('link-row');
const linkText = document.getElementById('link-text');
const copyLinkBtn = document.getElementById('copy-link-btn');
const shareBtn = document.getElementById('share-btn');
const referralShareBtn = document.getElementById('referral-share-btn');
const profileNavBtn = document.getElementById('profile-nav-btn');
const backToCardsBtn = document.getElementById('back-to-cards-btn');
const profileView = document.getElementById('profile-view');
const profileForm = document.getElementById('canonical-profile-form');
const profilePhotoPreview = document.getElementById('profile-photo-preview');
const profileChoosePhotoBtn = document.getElementById('profile-choose-photo-btn');
const profilePullBtn = document.getElementById('profile-pull-btn');
const profileFieldsEl = document.getElementById('profile-fields');
const profileNewFieldName = document.getElementById('profile-new-field-name');
const profileNewFieldValue = document.getElementById('profile-new-field-value');
const profileAddFieldBtn = document.getElementById('profile-add-field-btn');
const profileFieldLimitHint = document.getElementById('profile-field-limit-hint');
const profileCloseBtn = document.getElementById('profile-close-btn');

const PHOTO_SIZE = 480;
const PHOTO_QUALITY = 0.85;

let cards = [];
let activeCard = null; // the card shown in card-view / being edited in edit-view (null = creating new)
let pendingPhoto = null; // base64 JPEG (no data: prefix), staged from the picker until Save
let pendingLinks = []; // working link-entry array while the edit form is open
let deleteArmed = false;
let deleteArmedTimeout = null;

// ── View / status helpers ────────────────────────────────────────────────────

function showView(name) {
    cardsView.hidden = name !== 'cards';
    editView.hidden = name !== 'edit';
    cardView.hidden = name !== 'card';
    profileView.hidden = name !== 'profile';
    profileNavBtn.hidden = name === 'profile';
    backToCardsBtn.hidden = name !== 'card';
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
    importBizbuzBtn.disabled = atLimit;
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

// ── App Group sharing ────────────────────────────────────────────────────────
//
// Import fills name/bio/photo only if currently empty (additive, not
// destructive) and merges links through the same dedupe/cap pattern as the
// URL-import feature above.

importBizbuzBtn.addEventListener('click', async () => {
    if (pendingLinks.length >= MAX_LINKS) return;
    importBizbuzBtn.disabled = true;
    setStatus('Checking for a shared BizBuz profile…');
    try {
        const result = await core.invoke('import_from_bizbuz');
        const nameEl = document.getElementById('field-name');
        const bioEl = document.getElementById('field-bio');
        if (result.name && !nameEl.value.trim()) nameEl.value = result.name;
        if (result.bio && !bioEl.value.trim()) bioEl.value = result.bio;
        if (result.photo && !pendingPhoto) {
            pendingPhoto = result.photo;
            setAvatarContent(photoPreview, pendingPhoto, nameEl.value || '');
        }

        const existingUrls = new Set(pendingLinks.map((l) => normalizeUrl(l.url)));
        const fresh = result.links.filter((l) => {
            const key = normalizeUrl(l.url);
            if (existingUrls.has(key)) return false;
            existingUrls.add(key);
            return true;
        });
        const room = MAX_LINKS - pendingLinks.length;
        const toAdd = fresh.slice(0, room);
        pendingLinks.push(...toAdd.map((l) => ({ id: '', label: l.label, url: l.url })));
        renderLinkEntries();

        const notes = [];
        if (toAdd.length) notes.push(`Imported ${toAdd.length} link${toAdd.length === 1 ? '' : 's'} from BizBuz`);
        if (result.skippedFields.length) notes.push(`${result.skippedFields.length} field${result.skippedFields.length === 1 ? '' : 's'} couldn't be imported (${result.skippedFields.join(', ')} — no equivalent here)`);
        setStatus(notes.length ? notes.join(' — ') : 'Nothing new to import from BizBuz.');
    } catch (err) {
        setStatus(`${err}`); // Rust already returns a complete, user-facing sentence
    } finally {
        importBizbuzBtn.disabled = pendingLinks.length >= MAX_LINKS;
    }
});

// ── Form <-> LinkCard ─────────────────────────────────────────────────────────

function cardFromForm() {
    return {
        id: activeCard?.id || '',
        name: document.getElementById('field-name').value.trim() || undefined,
        bio: document.getElementById('field-bio').value.trim() || undefined,
        category: document.getElementById('field-category').value || undefined,
        photo: pendingPhoto || undefined,
        links: pendingLinks,
    };
}

function fillForm(source) {
    document.getElementById('field-name').value = source?.name || '';
    document.getElementById('field-bio').value = source?.bio || '';
    document.getElementById('field-category').value = source?.category || '';
    pendingPhoto = source?.photo || null;
    pendingLinks = (source?.links || []).map((l) => ({ ...l }));
    editingLinkIndex = null;
    setAvatarContent(photoPreview, source?.photo, source?.name || '');
    renderLinkEntries();
}

// ── Cards grid ────────────────────────────────────────────────────────────────

function renderCardsGrid() {
    cardsGrid.innerHTML = '';

    for (const c of cards) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'card-tile filled';

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        setAvatarContent(avatar, c.photo, c.name || '');
        tile.appendChild(avatar);

        const name = document.createElement('span');
        name.className = 'card-tile-name';
        name.textContent = c.name || 'Untitled';
        tile.appendChild(name);

        tile.addEventListener('click', () => openCard(c));
        cardsGrid.appendChild(tile);
    }

    if (cards.length < MAX_CARDS) {
        const addTile = document.createElement('button');
        addTile.type = 'button';
        addTile.className = 'card-tile empty';
        addTile.textContent = '+';
        addTile.addEventListener('click', openNewCardForm);
        cardsGrid.appendChild(addTile);
    }
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

    const categoryEl = document.getElementById('card-category');
    categoryEl.textContent = categoryLabels[c.category] || '';
    categoryEl.hidden = !c.category;

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

// Upserts a card into the in-memory `cards` list and, if it's the one
// currently on screen, refreshes the link row too — used by both the
// explicit Publish button and the silent background sync below.
function applyCardUpdate(updated) {
    cards = cards.filter((c) => c.id !== updated.id);
    cards.push(updated);
    if (activeCard?.id === updated.id) {
        activeCard = updated;
        renderPublishLink(updated);
    }
}

// The shareable link (shareUrl, a pre-signed savage URL) is available the
// instant publish_card returns — the signature never expires, so it's
// computed once and doesn't need to be refreshed on later shares. Publishing
// proactively in the background (on boot and after every edit, not only when
// the user taps the button) keeps the published card in sync with the latest
// edits without requiring an explicit re-publish tap first.
async function backgroundPublishCard(cardId) {
    try {
        const updated = await core.invoke('publish_card', { cardId });
        applyCardUpdate(updated);
    } catch {
        // Best-effort — network hiccups etc. shouldn't surface to the user
        // for a sync they didn't explicitly ask for.
    }
}

function backgroundPublishAllCards() {
    for (const c of cards) backgroundPublishCard(c.id);
}

// Keeps BizBuz's "Import from Linkitylink" button in sync with whichever
// card was most recently saved — the App Group only has room for one
// Linkitylink card, so there's no explicit "Share to App Group" button
// anymore, just an automatic sync on every save.
async function backgroundShareToAppGroup(cardId) {
    try {
        await core.invoke('share_card_to_app_group', { cardId });
    } catch {
        // Best-effort — shouldn't surface to the user for a sync they
        // didn't explicitly ask for.
    }
}

function openCard(c) {
    activeCard = c;
    renderCardView(c);
    renderPublishLink(c);
    showView('card');
}

function openNewCardForm() {
    activeCard = null;
    pendingPhoto = null;
    pendingLinks = [];
    editingLinkIndex = null;
    disarmDelete();
    form.reset();
    setAvatarContent(photoPreview, null, '');
    renderLinkEntries();
    cancelEditBtn.hidden = cards.length === 0;
    deleteCardBtn.hidden = true;
    showView('edit');
}

async function loadCards() {
    cards = await core.invoke('load_cards');
    if (cards.length === 0) {
        openNewCardForm();
    } else {
        renderCardsGrid();
        showView('cards');
    }
}

function getLetemcookPromptedIds() {
    try {
        return new Set(JSON.parse(localStorage.getItem(LETEMCOOK_PROMPTED_KEY) || '[]'));
    } catch {
        return new Set();
    }
}

function markLetemcookPrompted(cardId) {
    const ids = getLetemcookPromptedIds();
    ids.add(cardId);
    try {
        localStorage.setItem(LETEMCOOK_PROMPTED_KEY, JSON.stringify([...ids]));
    } catch {
        // localStorage unavailable — worst case this prompt reappears later.
    }
}

// Offers to cross-list a freshly-saved Food & Drink card on letemcook, a
// sibling food-ordering app. Fires at most once ever per card id.
async function maybePromptLetemcook(saved) {
    if (!saved.category || !FOOD_CATEGORY_SLUGS.includes(saved.category)) return;
    if (getLetemcookPromptedIds().has(saved.id)) return;
    markLetemcookPrompted(saved.id);

    const wantsToJoin = confirm(
        `Also list "${saved.name || 'this business'}" on letemcook, our food-ordering app?`
    );
    if (!wantsToJoin) return;

    const params = new URLSearchParams();
    if (saved.name) params.set('name', saved.name);
    if (saved.bio) params.set('bio', saved.bio);

    try {
        await core.invoke('plugin:shell|open', {
            path: `letemcook://add-location?${params.toString()}`,
        });
    } catch (err) {
        setStatus(`Couldn't open letemcook: ${err}`);
    }
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        const saved = await core.invoke('save_card', { card: cardFromForm() });
        cards = cards.filter((c) => c.id !== saved.id);
        cards.push(saved);
        activeCard = saved;
        renderCardsGrid();
        renderCardView(saved);
        renderPublishLink(saved);
        showView('card');
        backgroundPublishCard(saved.id);
        backgroundShareToAppGroup(saved.id);
        maybePromptLetemcook(saved);
    } catch (err) {
        setStatus(`Couldn't save: ${err}`);
    }
});

cancelEditBtn.addEventListener('click', () => {
    showView(activeCard ? 'card' : 'cards');
});

function disarmDelete() {
    deleteArmed = false;
    clearTimeout(deleteArmedTimeout);
    deleteCardBtn.textContent = 'Delete Card';
}

deleteCardBtn.addEventListener('click', async () => {
    if (!activeCard) return;

    if (!deleteArmed) {
        deleteArmed = true;
        deleteCardBtn.textContent = 'Tap again to confirm';
        deleteArmedTimeout = setTimeout(disarmDelete, 3000);
        return;
    }

    disarmDelete();
    try {
        await core.invoke('delete_card', { id: activeCard.id });
        cards = cards.filter((c) => c.id !== activeCard.id);
        activeCard = null;
        if (cards.length === 0) {
            openNewCardForm();
        } else {
            renderCardsGrid();
            showView('cards');
        }
    } catch (err) {
        setStatus(`Couldn't delete: ${err}`);
    }
});

document.getElementById('edit-btn').addEventListener('click', () => {
    if (activeCard) fillForm(activeCard);
    disarmDelete();
    cancelEditBtn.hidden = false;
    deleteCardBtn.hidden = false;
    showView('edit');
});

backToCardsBtn.addEventListener('click', () => {
    activeCard = null;
    renderCardsGrid();
    showView('cards');
});

publishBtn.addEventListener('click', async () => {
    if (!activeCard) return;
    publishBtn.disabled = true;
    setStatus('Publishing…');
    try {
        const updated = await core.invoke('publish_card', { cardId: activeCard.id });
        applyCardUpdate(updated);
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
    if (!activeCard) return;
    shareBtn.disabled = true;
    try {
        const url = activeCard.shareUrl || (await core.invoke('publish_card', { cardId: activeCard.id })).shareUrl;
        await core.invoke('plugin:share-sheet|share_text', { text: url });
    } catch (err) {
        setStatus(`Couldn't share: ${err}`);
    } finally {
        shareBtn.disabled = false;
    }
});

// ── Referral link ─────────────────────────────────────────────────────────────
//
// No preview/copy row, just a button. Tapping it asks Rust for this
// install's referral link (registering one with BDO/savage on first launch,
// reusing the cached one after that) and hands it straight to the native
// share sheet as a real URL.
referralShareBtn.addEventListener('click', async () => {
    referralShareBtn.disabled = true;
    try {
        const url = await core.invoke('get_or_create_referral_link');
        await core.invoke('plugin:share-sheet|share_text', { text: url });
    } catch (err) {
        setStatus(`Couldn't share: ${err}`);
    } finally {
        referralShareBtn.disabled = false;
    }
});

// ── Canonical profile ────────────────────────────────────────────────────────
//
// A separate, App-Group-shared record — independent of `cards`/`activeCard`
// above. Its own photo/field-list state is kept apart from the card editor's
// so editing this screen can never bleed into whichever card is currently
// being edited. Every field (built-in or pulled-in) is a {slug, name, value}
// tuple — the slug is the stable machine identity used for dedup, `name` is
// a human label, `value` is the content. Mirrors slugify() in
// src-tauri/src/lib.rs.

let preProfileView = 'cards'; // the view to return to on Close/Save
let pendingProfilePhoto = null;
let pendingProfileFields = [];
let editingProfileFieldIndex = null;

function slugify(s) {
    return s
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function renderProfileFields() {
    profileFieldsEl.innerHTML = '';

    pendingProfileFields.forEach((entry, index) => {
        const li = document.createElement('li');
        li.className = 'link-entry';

        if (index === editingProfileFieldIndex) {
            const fields = document.createElement('div');
            fields.className = 'link-entry-edit-fields';

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.placeholder = 'Field';
            nameInput.maxLength = 40;
            nameInput.value = entry.name;

            const valueInput = document.createElement('input');
            valueInput.type = 'text';
            valueInput.placeholder = 'Value';
            valueInput.value = entry.value;

            const commit = () => {
                entry.name = nameInput.value.trim();
                entry.value = valueInput.value.trim();
                entry.slug = slugify(entry.name);
                editingProfileFieldIndex = null;
                renderProfileFields();
            };
            const onEnter = (e) => { if (e.key === 'Enter') commit(); };
            nameInput.addEventListener('keydown', onEnter);
            valueInput.addEventListener('keydown', onEnter);

            fields.append(nameInput, valueInput);
            li.appendChild(fields);

            const doneBtn = document.createElement('button');
            doneBtn.type = 'button';
            doneBtn.textContent = '✓';
            doneBtn.addEventListener('click', commit);

            const actions = document.createElement('div');
            actions.className = 'link-entry-actions';
            actions.appendChild(doneBtn);
            li.appendChild(actions);

            profileFieldsEl.appendChild(li);
            nameInput.focus();
            return;
        }

        const text = document.createElement('div');
        text.className = 'link-entry-text';
        text.innerHTML = '<div class="link-entry-label"></div><div class="link-entry-url"></div>';
        text.querySelector('.link-entry-label').textContent = entry.name || entry.slug;
        text.querySelector('.link-entry-url').textContent = entry.value;
        text.addEventListener('click', () => {
            editingProfileFieldIndex = index;
            renderProfileFields();
        });
        li.appendChild(text);

        const actions = document.createElement('div');
        actions.className = 'link-entry-actions';

        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.textContent = '↑';
        upBtn.disabled = index === 0;
        upBtn.addEventListener('click', () => {
            [pendingProfileFields[index - 1], pendingProfileFields[index]] = [pendingProfileFields[index], pendingProfileFields[index - 1]];
            renderProfileFields();
        });

        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.textContent = '↓';
        downBtn.disabled = index === pendingProfileFields.length - 1;
        downBtn.addEventListener('click', () => {
            [pendingProfileFields[index], pendingProfileFields[index + 1]] = [pendingProfileFields[index + 1], pendingProfileFields[index]];
            renderProfileFields();
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
            pendingProfileFields.splice(index, 1);
            if (editingProfileFieldIndex === index) editingProfileFieldIndex = null;
            renderProfileFields();
        });

        actions.append(upBtn, downBtn, removeBtn);
        li.appendChild(actions);
        profileFieldsEl.appendChild(li);
    });

    const atLimit = pendingProfileFields.length >= MAX_PROFILE_FIELDS;
    profileAddFieldBtn.disabled = atLimit;
    profileFieldLimitHint.hidden = !atLimit;
}

profileAddFieldBtn.addEventListener('click', () => {
    const name = profileNewFieldName.value.trim();
    const value = profileNewFieldValue.value.trim();
    if (!name || !value || pendingProfileFields.length >= MAX_PROFILE_FIELDS) return;

    pendingProfileFields.push({ slug: slugify(name), name, value });
    profileNewFieldName.value = '';
    profileNewFieldValue.value = '';
    renderProfileFields();
});

profileChoosePhotoBtn.addEventListener('click', async () => {
    try {
        const path = await dialog.open({
            multiple: false,
            filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'heic'] }],
        });
        if (!path) return;

        const bytes = await fs.readFile(path);
        pendingProfilePhoto = await resizeImageToJpegBase64(bytes);
        setAvatarContent(profilePhotoPreview, pendingProfilePhoto, '');
    } catch (err) {
        setStatus(`Couldn't set photo: ${err}`);
    }
});

// Local-only: reads the `cards` array already loaded in memory (all of
// this app's own saved cards, not just the active one). First-non-empty-
// per-slug wins; never overwrites a field already present in the profile.
profilePullBtn.addEventListener('click', () => {
    if (cards.length === 0) {
        setStatus('No Linkitylink cards saved yet.');
        return;
    }
    const existingSlugs = new Set(pendingProfileFields.map((f) => f.slug));
    for (const c of cards) {
        if (c.name && !existingSlugs.has('name')) {
            pendingProfileFields.push({ slug: 'name', name: 'Name', value: c.name });
            existingSlugs.add('name');
        }
        if (c.bio && !existingSlugs.has('bio')) {
            pendingProfileFields.push({ slug: 'bio', name: 'Bio', value: c.bio });
            existingSlugs.add('bio');
        }
        for (const link of c.links || []) {
            const name = link.label || link.url;
            const slug = slugify(name);
            if (slug && !existingSlugs.has(slug)) {
                pendingProfileFields.push({ slug, name, value: link.url });
                existingSlugs.add(slug);
            }
        }
        if (c.photo && !pendingProfilePhoto) {
            pendingProfilePhoto = c.photo;
            setAvatarContent(profilePhotoPreview, pendingProfilePhoto, '');
        }
    }
    renderProfileFields();
    setStatus('Pulled in fields from your link cards.');
});

function fillProfileForm(profile) {
    pendingProfilePhoto = profile?.photo || null;
    pendingProfileFields = (profile?.fields || []).map((f) => ({ ...f }));
    editingProfileFieldIndex = null;
    setAvatarContent(profilePhotoPreview, profile?.photo, '');
    renderProfileFields();
}

function canonicalProfileFromForm() {
    return {
        photo: pendingProfilePhoto || undefined,
        fields: pendingProfileFields,
    };
}

function currentViewName() {
    if (!cardsView.hidden) return 'cards';
    if (!editView.hidden) return 'edit';
    if (!cardView.hidden) return 'card';
    return 'cards';
}

profileNavBtn.addEventListener('click', async () => {
    preProfileView = currentViewName();
    try {
        const profile = await core.invoke('load_canonical_profile');
        fillProfileForm(profile);
        showView('profile');
    } catch (err) {
        setStatus(`Couldn't load profile: ${err}`);
    }
});

profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await core.invoke('save_canonical_profile', { profile: canonicalProfileFromForm() });
        setStatus('Profile saved — shared across your apps.');
        showView(preProfileView);
    } catch (err) {
        setStatus(`Couldn't save: ${err}`);
    }
});

profileCloseBtn.addEventListener('click', () => showView(preProfileView));

function populateCategorySelect() {
    const select = document.getElementById('field-category');
    for (const c of categories) {
        const opt = document.createElement('option');
        opt.value = c.slug;
        opt.textContent = c.label;
        select.appendChild(opt);
    }
}

async function init() {
    try {
        categories = await core.invoke('get_categories');
    } catch {
        categories = [];
    }
    categoryLabels = Object.fromEntries(categories.map((c) => [c.slug, c.label]));
    populateCategorySelect();
    await loadCards();
    backgroundPublishAllCards();
}

init();
