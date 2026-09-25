import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian';

export const VIEW_TYPE_QUOTE_SEARCH = "quote-search-view";

interface QuoteSearchSettings {
    quotesFolder: string;
    authorsFolder: string;
    sermonsFolder: string;
    sourcesFolder: string;
    sermonDateFormat: 'YYYYMMDD' | 'YYYY-MM-DD';
    sermonPlacePosition: 'after' | 'before';
    sermonPlaceSeparator: string;
    quoteType: string;
}

const DEFAULT_SETTINGS: QuoteSearchSettings = {
    quotesFolder: 'Quotes',
    authorsFolder: 'Authors',
    sermonsFolder: 'Sermons',
    sourcesFolder: 'Sources',
    sermonDateFormat: 'YYYYMMDD',
    sermonPlacePosition: 'after',
    sermonPlaceSeparator: '',
    quoteType: ''
}

export default class QuoteSearchPlugin extends Plugin {
    settings: QuoteSearchSettings;

    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE_QUOTE_SEARCH, (leaf) => new QuoteSearchView(leaf, this));
        this.addRibbonIcon("quote-glyph", "Open Quote Search", () => this.activateView());
        this.addSettingTab(new QuoteSettingTab(this.app, this));
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_QUOTE_SEARCH)[0] || workspace.getRightLeaf(false);
        await leaf.setViewState({ type: VIEW_TYPE_QUOTE_SEARCH, active: true });
        workspace.revealLeaf(leaf);
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SermonUsage {
    date: string;       // YYYY-MM-DD
    place: string;      // e.g. "CPT"
    fileName: string;
}

interface QuoteEntry {
    file: TFile;
    text: string;
    authorClean: string;
    sourceClean: string;
    tags: string[];
    lowerBlob: string;      // pre-computed for fast search
    sermons: SermonUsage[]; // pre-computed from sermon index
}

// ─── View ─────────────────────────────────────────────────────────────────────

class QuoteSearchView extends ItemView {
    plugin: QuoteSearchPlugin;

    // Live suggestion lists — mutated in-place so closures always see fresh data
    private authorSuggestions: string[] = [];
    private sourceSuggestions: string[] = [];
    private tagSuggestions: string[] = [];

    // Search cache
    private quoteCache: QuoteEntry[] = [];
    private cacheValid = false;

    // Separate debounce timers: short for search input, long for vault events
    private searchDebounce: ReturnType<typeof setTimeout> | null = null;
    private vaultDebounce: ReturnType<typeof setTimeout> | null = null;

    private currentQuery = '';
    private resultsEl: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;
    private searchEl: HTMLInputElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: QuoteSearchPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_TYPE_QUOTE_SEARCH; }
    getDisplayText() { return "Quote Search"; }
    getIcon() { return "quote-glyph"; }

    // ── Folder helper ─────────────────────────────────────────────────────────

    /**
     * Returns true if filePath is inside folderSetting at any depth.
     *
     * The setting may be:
     *   - A full vault-relative path: "03-Content/Services/Sermons"
     *   - Just a folder name:         "Sermons"
     *
     * In the second case we match any path that contains "/Sermons/" or
     * starts with "Sermons/" — so files in subfolders like
     * "03-Content/Services/Sermons/Westville/file.md" are correctly included.
     */
    private inFolder(filePath: string, folderSetting: string): boolean {
        const folder = folderSetting.trim().replace(/\\/g, '/').replace(/\/$/, '');
        const p = filePath.replace(/\\/g, '/');
        // Compare case-insensitively so 'quotes' matches 'Quotes' etc.
        const folderLower = folder.toLowerCase();
        const pLower = p.toLowerCase();

        // Exact prefix match (setting is a full path like "03-Content/Services/Sermons")
        if (pLower.startsWith(folderLower + '/') || pLower === folderLower) return true;

        // Partial name match (setting is just "Sermons" — match as a path segment
        // anywhere in the file path, to support deep vault structures)
        if (!folder.includes('/')) {
            return pLower.startsWith(folderLower + '/') || pLower.includes('/' + folderLower + '/');
        }

        return false;
    }

    // ── Metadata helpers ──────────────────────────────────────────────────────

    private refreshMetadataLists() {
        const authors = this.app.vault.getMarkdownFiles()
            .filter(f => this.inFolder(f.path, this.plugin.settings.authorsFolder))
            .map(f => `[[${f.basename}]]`);
        this.authorSuggestions.length = 0;
        this.authorSuggestions.push(...authors);

        const sources = this.app.vault.getMarkdownFiles()
            .filter(f => this.inFolder(f.path, this.plugin.settings.sourcesFolder))
            .map(f => `[[${f.basename}]]`);
        this.sourceSuggestions.length = 0;
        this.sourceSuggestions.push(...sources);

        // @ts-ignore — internal Obsidian API
        const tagCache = this.app.metadataCache.getTags() as Record<string, number>;
        const tags = Object.keys(tagCache).map(t => t.replace(/^#/, ''));
        this.tagSuggestions.length = 0;
        this.tagSuggestions.push(...tags);
    }

    // ── Sermon index ──────────────────────────────────────────────────────────

    /**
     * Builds an inverted index: quoteBasename (lowercase) → SermonUsage[]
     *
     * Rather than calling getBacklinksForFile() — whose internal CustomArrayDict
     * is not safely iterable — we scan every sermon file's metadataCache.links[].
     * Obsidian populates cache.links with every [[wikilink]] found in the file,
     * giving us a reliable, public-ish API surface.
     *
     * Sermon filename format expected: YYYYMMDDXXX (e.g. 20240318CPT)
     */
    private buildSermonIndex(): Map<string, SermonUsage[]> {
        const index = new Map<string, SermonUsage[]>();

        const sermonFiles = this.app.vault.getMarkdownFiles()
            .filter(f => this.inFolder(f.path, this.plugin.settings.sermonsFolder));

        const sermonDateFormat    = this.plugin.settings.sermonDateFormat    ?? 'YYYYMMDD';
        const sermonPlacePosition  = this.plugin.settings.sermonPlacePosition  ?? 'after';
        const sermonPlaceSeparator = this.plugin.settings.sermonPlaceSeparator ?? '';
        const sep = sermonPlaceSeparator.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); // escape for regex

        // Place name: must start with a letter to avoid matching date digits,
        // then allows letters, digits, spaces and hyphens for multi-word names
        // like "Central", "Central Baptist" or "North-West".
        // When place comes after the date we anchor with $ so it captures to end.
        const placeAfter  = '([A-Za-z][A-Za-z0-9 \\-]*)$';
        const placeBefore = '([A-Za-z][A-Za-z0-9 \\-]*)';

        // Build date capture groups based on selected format
        let dateCaptures: string;
        if (sermonDateFormat === 'YYYY-MM-DD') {
            dateCaptures = '(\\d{4})-(\\d{2})-(\\d{2})';
        } else {
            dateCaptures = '(\\d{4})(\\d{2})(\\d{2})';
        }

        const pattern = sermonPlacePosition === 'before'
            ? `^${placeBefore}${sep}${dateCaptures}`
            : `^${dateCaptures}${sep}${placeAfter}`;
        const filenameRe = new RegExp(pattern);

        for (const sermon of sermonFiles) {
            const m = sermon.basename.match(filenameRe);
            if (!m || m.length < 5) continue;

            // Group order differs depending on place position
            const usage: SermonUsage = sermonPlacePosition === 'before'
                ? { date: `${m[2]}-${m[3]}-${m[4]}`, place: m[1].toUpperCase(), fileName: sermon.basename }
                : { date: `${m[1]}-${m[2]}-${m[3]}`, place: m[4].toUpperCase(), fileName: sermon.basename };

            const cache = this.app.metadataCache.getFileCache(sermon);
            if (!cache) continue;

            // Obsidian stores [[wikilinks]] in cache.links and ![[embeds]] in
            // cache.embeds — we need both to catch all quote references.
            const refs = [
                ...(cache.links ?? []),
                ...(cache.embeds ?? []),
            ];

            for (const ref of refs) {
                // ref.link is the raw target, e.g. "2405240949" or "Folder/Note"
                const target = ref.link.split('/').pop() ?? ref.link;
                const key = target.toLowerCase();
                if (!index.has(key)) index.set(key, []);
                index.get(key)!.push(usage);
            }
        }

        // Sort each bucket newest-first
        for (const usages of index.values()) {
            usages.sort((a, b) => b.date.localeCompare(a.date));
        }

        return index;
    }

    // ── Cache ─────────────────────────────────────────────────────────────────

    private async rebuildCache() {
        const { quotesFolder } = this.plugin.settings;

        const sermonIndex = this.buildSermonIndex();

        const files = this.app.vault.getMarkdownFiles()
            .filter(f => this.inFolder(f.path, quotesFolder));

        const entries: QuoteEntry[] = [];

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;

            // If a quoteType is configured, skip files that have a "type"
            // property set to something else (e.g. type: sermon). Files with
            // no "type" property at all are always included — being in the
            // quotes folder is enough.
            // Skip database/plugin config files (e.g. DB Folder) that
            // live in the quotes folder but are not quotes.
            if (fm && ('columns' in fm || 'accessorKey' in fm || 'csvCandidate' in fm)) continue;

            const quoteType = this.plugin.settings.quoteType.trim();
            const fileType = fm?.type ?? null;
            if (quoteType && fileType && String(fileType) !== quoteType) continue;

            // Read the file body (everything after the frontmatter closing ---)
            // Normalise line endings first so the regex works on Windows too.
            let text = '';
            let skipFile = false;
            try {
                const raw = (await this.app.vault.read(file)).replace(/\r\n/g, '\n');

                // Skip files that have no frontmatter (no --- delimiters) but
                // whose first several non-empty lines all look like YAML key:value
                // pairs — these are plugin config files, not quotes.
                const hasFrontmatter = raw.trimStart().startsWith('---');
                if (!hasFrontmatter) {
                    const nonEmptyLines = raw.split('\n')
                        .map(l => l.trim())
                        .filter(l => l.length > 0)
                        .slice(0, 5);
                    const yamlLineCount = nonEmptyLines
                        .filter(l => /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(l)).length;
                    if (yamlLineCount >= 3) skipFile = true;
                }

                if (!skipFile) {
                    const FM_BODY_RE = new RegExp('^---[\\s\\S]*?---\\n([\\s\\S]*)$');
                    const bodyMatch = raw.match(FM_BODY_RE);
                    const body = bodyMatch ? bodyMatch[1].trim() : '';
                    // Strip the attribution line (starts with —)
                    text = body.split('\n')
                        .filter(l => !l.trimStart().startsWith('\u2014'))
                        .join('\n')
                        .trim();
                }
            } catch { /* file unreadable */ }

            if (skipFile) continue;

            // Guard against null fm (files with no frontmatter).
            // stripYaml: removes surrounding quotes added by some YAML writers.
            // display: also removes [[ ]] brackets for human-readable display.
            const stripYaml = (v: unknown) =>
                String(v || '').replace(/^["']|["']$/g, '').trim();
            const display = (v: unknown) => {
                const s = stripYaml(v).replace(/^\[\[|\]\]$/g, '').trim();
                // [[Folder/Name|Alias]] → Alias
                // [[Folder/Name]]       → Name (last path segment)
                if (s.includes('|')) return s.split('|').pop()?.trim() ?? s;
                if (s.includes('/')) return s.split('/').pop()?.trim() ?? s;
                return s;
            };

            // authorClean is used for display — brackets removed.
            // authorRaw preserves wikilinks for the search blob so
            // searching "C.S. Lewis" still matches "[[C.S. Lewis]]".
            const authorClean = Array.isArray(fm?.author)
                ? fm.author.map(display).join(', ')
                : display(fm?.author);
            const authorSearch = Array.isArray(fm?.author)
                ? fm.author.map(stripYaml).join(', ')
                : stripYaml(fm?.author);

            const tags: string[] = Array.isArray(fm?.tags)
                ? fm.tags.map((t: unknown) => display(t)).filter(Boolean)
                : fm?.tags
                    ? display(fm.tags).split(/[\s,]+/).filter(Boolean)
                    : [];

            const sourceClean = Array.isArray(fm?.source)
                ? fm.source.map(display).join(', ')
                : display(fm?.source);
            const sourceSearch = Array.isArray(fm?.source)
                ? fm.source.map(stripYaml).join(', ')
                : stripYaml(fm?.source);

            // Skip only if there is genuinely nothing to show at all
            if (!text && !authorClean && !sourceClean && tags.length === 0) continue;

            const sermons = sermonIndex.get(file.basename.toLowerCase()) ?? [];

            entries.push({ file, text, authorClean, sourceClean, tags, sermons,
                lowerBlob: [text, authorSearch, sourceSearch, tags.join(' ')].join(' ').toLowerCase() });
        }

        // Sort by author (no-author → end), shuffle within same-author groups
        entries.sort((a, b) => {
            if (!a.authorClean && !b.authorClean) return 0;
            if (!a.authorClean) return 1;
            if (!b.authorClean) return -1;
            return a.authorClean.localeCompare(b.authorClean);
        });
        this.shuffleWithinGroups(entries);

        this.quoteCache = entries;
        this.cacheValid = true;
    }

    private shuffleWithinGroups(entries: QuoteEntry[]) {
        let i = 0;
        while (i < entries.length) {
            const author = entries[i].authorClean;
            let j = i;
            while (j < entries.length && entries[j].authorClean === author) j++;
            for (let k = j - 1; k > i; k--) {
                const r = i + Math.floor(Math.random() * (k - i + 1));
                [entries[k], entries[r]] = [entries[r], entries[k]];
            }
            i = j;
        }
    }

    private invalidateCache() { this.cacheValid = false; }

    // ── Rendering ─────────────────────────────────────────────────────────────

    private async renderResults(query: string) {
        if (!this.resultsEl) return;
        if (!this.cacheValid) await this.rebuildCache();
        if (this.countEl) this.countEl.setText(`${this.quoteCache.length}`);

        const resultsEl = this.resultsEl;
        resultsEl.empty();
        const lowerQuery = query.toLowerCase().trim();

        const matches = lowerQuery
            ? this.quoteCache.filter(e => e.lowerBlob.includes(lowerQuery))
            : this.quoteCache;

        if (matches.length === 0) {
            resultsEl.createDiv({
                cls: 'qs-empty',
                text: query ? 'No quotes match your search.' : 'No quotes found.',
            });
            return;
        }

        matches.forEach(entry => {
            const { file, text, authorClean, sourceClean, tags, sermons } = entry;

            const item = resultsEl.createDiv({ cls: 'qs-item' });
            item.createDiv({ text, cls: 'qs-text' });

            const meta = item.createDiv({ cls: 'qs-meta' });
            const tagWrap = meta.createDiv({ cls: 'qs-tags' });
            tags.forEach(tag => {
                const label = tag.replace(/^#/, '');
                const badge = tagWrap.createSpan({ text: label, cls: 'qs-tag qs-tag-clickable' });
                badge.addEventListener('click', (e) => {
                    e.stopPropagation(); // prevent item copy handler firing
                    if (this.searchEl) {
                        this.searchEl.value = label;
                        this.searchEl.focus();
                        // Keep clear button visibility in sync
                        this.searchEl.dispatchEvent(new Event('input'));
                    } else {
                        this.scheduleSearchRender(label);
                    }
                });
            });
            const attribution = item.createDiv({ cls: 'qs-attribution' });
            if (authorClean) {
                const authorEl = attribution.createSpan({ text: `— ${authorClean}`, cls: 'qs-author qs-clickable' });
                authorEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.searchEl) {
                        this.searchEl.value = authorClean;
                        this.searchEl.dispatchEvent(new Event('input'));
                    }
                });
            }
            if (sourceClean) {
                const sourceEl = attribution.createSpan({ text: sourceClean, cls: 'qs-source qs-clickable' });
                sourceEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.searchEl) {
                        this.searchEl.value = sourceClean;
                        this.searchEl.dispatchEvent(new Event('input'));
                    }
                });
            }

            if (sermons.length > 0) {
                const last = sermons[0];
                item.createDiv({ cls: 'qs-usage' }).createSpan({
                    text: `Last used: ${last.date} · ${last.place} · ${sermons.length}×`,
                    cls: 'qs-usage-text',
                });
            }

            // Single click: copy embed link to clipboard and show brief toast
            item.addEventListener('click', async (e) => {
                // Ignore double-click — handled separately below
                if (e.detail === 2) return;
                const embedCode = `![[${file.basename}]]`;
                await navigator.clipboard.writeText(embedCode);
                this.showCopyToast(item, embedCode);
            });

            // Double-click: open the quote file for editing
            item.addEventListener('dblclick', () => {
                this.app.workspace.getLeaf().openFile(file);
            });
        });
    }

    /** Briefly flash a confirmation message inside the quote card. */
    private showCopyToast(item: HTMLElement, embedCode: string) {
        // Remove any existing toast first
        item.querySelectorAll('.qs-toast').forEach(el => el.remove());
        const toast = item.createDiv({ cls: 'qs-toast', text: `Copied ${embedCode}` });
        setTimeout(() => toast.remove(), 1800);
    }

    private scheduleSearchRender(query: string) {
        this.currentQuery = query;
        if (this.searchDebounce) clearTimeout(this.searchDebounce);
        this.searchDebounce = setTimeout(async () => { await this.renderResults(query); }, 120);
    }

    // Only react to changes in the quotes or sermons folders — ignores all
    // edits to other documents, which was the main cause of lag.
    private onVaultChange(file: TFile) {
        const { quotesFolder, sermonsFolder } = this.plugin.settings;
        if (!this.inFolder(file.path, quotesFolder) && !this.inFolder(file.path, sermonsFolder)) return;
        this.invalidateCache();
        if (this.vaultDebounce) clearTimeout(this.vaultDebounce);
        this.vaultDebounce = setTimeout(async () => { await this.renderResults(this.currentQuery); }, 800);
    }

    // ── File creation ─────────────────────────────────────────────────────────

    /**
     * Wrap a value in a wikilink. If a folder is supplied, the link includes
     * the full path so Obsidian creates the note in the right place if it
     * doesn't exist yet: [[Folder/Name|Name]]
     * If the value already contains [[ it is returned as-is.
     */
    private wikilink(value: string, folder?: string): string {
        // Strip any existing [[ ]] brackets so we always control the full link
        const v = value.trim().replace(/^\[\[|\]\]$/g, '').trim();
        if (!v) return '';
        if (folder) {
            const f = folder.trim().replace(/\/$/, '');
            // Use [[Folder/Name|Name]] format so the display text is clean
            // and Obsidian knows exactly where to create the file if it doesn't exist
            return `[[${f}/${v}|${v}]]`;
        }
        return `[[${v}]]`;
    }

    private async createNewQuoteFile(quote: string, author: string, source: string, tags: string) {
        const folder = this.plugin.settings.quotesFolder;
        if (!(await this.app.vault.adapter.exists(folder))) {
            await this.app.vault.createFolder(folder);
        }

        // Wrap author and source in path-aware wikilinks so that clicking a
        // non-existent author/source page creates it in the correct folder.
        const authorLinked = this.wikilink(author, this.plugin.settings.authorsFolder);
        const sourceLinked = this.wikilink(source, this.plugin.settings.sourcesFolder);

        const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
        const yamlTags = tagList.length > 0 ? `\ntags:\n  - ${tagList.join('\n  - ')}` : '';
        const yamlSource = sourceLinked ? `\nsource: "${sourceLinked}"` : '';

        // Attribution line in the body keeps the [[...]] brackets so
        // Obsidian renders them as clickable links when the note is embedded.
        const attribution = [authorLinked, sourceLinked].filter(Boolean).join(' · ');
        const attributionLine = attribution ? `\n\n— ${attribution}` : '';

        const quoteType = this.plugin.settings.quoteType;
        const content = `---\ntype: ${quoteType}\nauthor: "${authorLinked}"${yamlSource}${yamlTags}\n---\n${quote}${attributionLine}`;
        const fileName = `${Date.now()}`;
        await this.app.vault.create(`${folder}/${fileName}.md`, content);
        this.invalidateCache();
        return fileName;
    }

    // ── Autocomplete ──────────────────────────────────────────────────────────

    private setupSuggest(
        input: HTMLInputElement,
        drop: HTMLDivElement,
        getList: () => string[],
        isTags = false
    ) {
        const close = () => drop.addClass('qs-hidden');

        input.addEventListener('input', () => {
            const raw = isTags ? (input.value.split(',').pop() ?? '') : input.value;
            const val = raw.trim().toLowerCase();
            if (!val) { close(); return; }

            const matches = getList().filter(i => i.toLowerCase().includes(val)).slice(0, 10);
            if (matches.length === 0) { close(); return; }

            drop.empty();
            drop.removeClass('qs-hidden');
            matches.forEach(m => {
                const item = drop.createDiv({ text: m, cls: 'qs-suggest-item' });
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault(); // prevent blur firing before click
                    if (isTags) {
                        const parts = input.value.split(',').map(p => p.trim());
                        parts.pop();
                        parts.push(m);
                        input.value = parts.join(', ') + ', ';
                    } else {
                        input.value = m;
                    }
                    close();
                    input.focus();
                });
            });
        });

        input.addEventListener('blur', () => setTimeout(close, 150));
    }

    // ── onOpen ────────────────────────────────────────────────────────────────

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('qs-sidebar');

        // Header
        const header = container.createDiv({ cls: 'qs-header' });
        const titleWrap = header.createDiv({ cls: 'qs-title-wrap' });
        titleWrap.createEl('h4', { text: 'Quotes' });
        const countEl = titleWrap.createSpan({ cls: 'qs-count', text: '' });
        this.countEl = countEl;
        const addBtn = header.createEl('button', { text: '+', cls: 'qs-add-btn', attr: { 'aria-label': 'Add quote' } });

        // Add form (hidden by default)
        const form = container.createDiv({ cls: 'qs-form qs-hidden' });
        const qInput = form.createEl('textarea', { placeholder: 'Quote text…', cls: 'qs-input qs-textarea' });

        const aWrap = form.createDiv({ cls: 'qs-field' });
        const aInput = aWrap.createEl('input', { placeholder: 'Author…', cls: 'qs-input' });
        const aDrop = aWrap.createDiv({ cls: 'qs-suggest-drop qs-hidden' });

        const sWrap = form.createDiv({ cls: 'qs-field' });
        const sInput = sWrap.createEl('input', { placeholder: 'Source (book/article)…', cls: 'qs-input' });
        const sDrop = sWrap.createDiv({ cls: 'qs-suggest-drop qs-hidden' });

        const tWrap = form.createDiv({ cls: 'qs-field' });
        const tInput = tWrap.createEl('input', { placeholder: 'Tags (comma separated)…', cls: 'qs-input' });
        const tDrop = tWrap.createDiv({ cls: 'qs-suggest-drop qs-hidden' });

        const saveBtn = form.createEl('button', { text: 'Save Quote', cls: 'qs-save-btn' });

        this.setupSuggest(aInput, aDrop, () => this.authorSuggestions);
        this.setupSuggest(sInput, sDrop, () => this.sourceSuggestions);
        this.setupSuggest(tInput, tDrop, () => this.tagSuggestions, true);

        addBtn.onclick = () => {
            this.refreshMetadataLists();
            const opening = form.hasClass('qs-hidden');
            form.toggleClass('qs-hidden', !opening);
            addBtn.setText(opening ? '×' : '+');
            if (opening) qInput.focus();
        };

        saveBtn.onclick = async () => {
            if (!qInput.value.trim()) return;
            const fileName = await this.createNewQuoteFile(qInput.value.trim(), aInput.value.trim(), sInput.value.trim(), tInput.value.trim());
            qInput.value = ''; aInput.value = ''; sInput.value = ''; tInput.value = '';
            form.addClass('qs-hidden');
            addBtn.setText('+');
            // Wait for Obsidian's metadata cache to index the new file before
            // rebuilding — otherwise author/source won't appear until next refresh.
            await new Promise<void>(resolve => {
                const handler = this.app.metadataCache.on('changed', (changedFile) => {
                    if (changedFile.basename === fileName) {
                        this.app.metadataCache.offref(handler);
                        resolve();
                    }
                });
                // Fallback: resolve after 2s even if the event never fires
                setTimeout(resolve, 2000);
            });
            this.invalidateCache();
            await this.renderResults(this.currentQuery);
            const embedCode = `![[${fileName}]]`;
            await navigator.clipboard.writeText(embedCode);
            new Notice(`Copied ${embedCode}`);
        };

        // Search input + clear button
        const searchWrap = container.createDiv({ cls: 'qs-search-wrap' });
        const searchInput = searchWrap.createEl('input', {
            type: 'text', placeholder: '🔍  Search quotes…', cls: 'qs-search'
        });
        const clearBtn = searchWrap.createEl('button', { cls: 'qs-search-clear qs-hidden', attr: { 'aria-label': 'Clear search' } });
        clearBtn.innerHTML = '&#x2715;'; // ✕

        this.searchEl = searchInput;
        this.resultsEl = container.createDiv({ cls: 'qs-results' });

        searchInput.addEventListener('input', () => {
            clearBtn.toggleClass('qs-hidden', searchInput.value === '');
            this.scheduleSearchRender(searchInput.value);
        });

        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearBtn.addClass('qs-hidden');
            searchInput.focus();
            this.scheduleSearchRender('');
        });

        // Initial render
        await this.rebuildCache();
        await this.renderResults('');

        // Vault listeners — filtered to quotes/sermons folders only
        this.registerEvent(this.app.vault.on('modify', (f) => this.onVaultChange(f as TFile)));
        this.registerEvent(this.app.vault.on('create', (f) => this.onVaultChange(f as TFile)));
        this.registerEvent(this.app.vault.on('delete', (f) => this.onVaultChange(f as TFile)));
    }

    async onClose() {
        if (this.searchDebounce) clearTimeout(this.searchDebounce);
        if (this.vaultDebounce) clearTimeout(this.vaultDebounce);
        this.resultsEl = null;
        this.countEl = null;
        this.searchEl = null;
        this.quoteCache = [];
    }
}

// ─── Folder Suggest ──────────────────────────────────────────────────────────

function getFolderList(app: App): string[] {
    const folders = new Set<string>();
    app.vault.getMarkdownFiles().forEach(f => {
        const parts = f.path.split('/');
        parts.pop();
        let acc = '';
        for (const part of parts) {
            acc = acc ? `${acc}/${part}` : part;
            folders.add(acc);
        }
    });
    app.vault.getAllLoadedFiles().forEach((f: any) => {
        if (f.children !== undefined && f.path !== '/') {
            folders.add(f.path.replace(/\/$/, ''));
        }
    });
    return [...folders].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class QuoteSettingTab extends PluginSettingTab {
    plugin: QuoteSearchPlugin;
    constructor(app: App, plugin: QuoteSearchPlugin) { super(app, plugin); this.plugin = plugin; }

    private addFolderSetting(
        containerEl: HTMLElement,
        name: string,
        desc: string,
        getValue: () => string,
        onChange: (v: string) => Promise<void>
    ) {
        const setting = new Setting(containerEl).setName(name).setDesc(desc);
        setting.addText(text => {
            text.setPlaceholder('Folder path').setValue(getValue());
            text.onChange(onChange);

            const input = text.inputEl;

            // Wrap the input in a relative-positioned container so the
            // dropdown can use position:absolute and stay in normal DOM flow —
            // no fixed positioning, no modal hunting, no z-index fights.
            const wrapper = input.parentElement!;
            wrapper.style.position = 'relative';
            wrapper.style.overflow = 'visible';

            const drop = wrapper.createDiv();
            drop.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;z-index:9999;background:var(--background-primary-alt);border:1px solid var(--background-modifier-border-focus);border-radius:4px;max-height:200px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.2)';

            const hide = () => { drop.style.display = 'none'; };

            const show = (matches: string[]) => {
                drop.style.display = 'block';
                drop.empty();
                matches.forEach(folder => {
                    const item = drop.createDiv({ text: folder });
                    item.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:0.85em';
                    item.onmouseover = () => item.style.background = 'var(--background-modifier-hover)';
                    item.onmouseout  = () => item.style.background = '';
                    item.onpointerdown = (e) => {
                        e.preventDefault();
                        input.value = folder;
                        hide();
                        onChange(folder);
                    };
                });
            };

            const refresh = () => {
                const val = input.value.trim().toLowerCase();
                if (!val) { hide(); return; }
                const matches = getFolderList(this.app)
                    .filter(f => f.toLowerCase().includes(val))
                    .slice(0, 15);
                matches.length ? show(matches) : hide();
            };

            input.addEventListener('input',  refresh);
            input.addEventListener('keyup',  refresh);
            input.addEventListener('blur', () => setTimeout(hide, 200));
            setting.settingEl.addEventListener('remove', () => drop.remove());
        });
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Quote Search Settings' });

        this.addFolderSetting(containerEl, 'Quotes folder', 'Folder where quote notes are stored.',
            () => this.plugin.settings.quotesFolder,
            async (v) => { this.plugin.settings.quotesFolder = v; await this.plugin.saveSettings(); });

        this.addFolderSetting(containerEl, 'Authors folder', 'Folder containing author notes (used for autocomplete).',
            () => this.plugin.settings.authorsFolder,
            async (v) => { this.plugin.settings.authorsFolder = v; await this.plugin.saveSettings(); });

        this.addFolderSetting(containerEl, 'Sermons folder', 'Folder containing sermon notes (used for usage tracking).',
            () => this.plugin.settings.sermonsFolder,
            async (v) => { this.plugin.settings.sermonsFolder = v; await this.plugin.saveSettings(); });

        this.addFolderSetting(containerEl, 'Sources folder', 'Folder containing source notes — books, articles, etc. (used for autocomplete).',
            () => this.plugin.settings.sourcesFolder,
            async (v) => { this.plugin.settings.sourcesFolder = v; await this.plugin.saveSettings(); });

        containerEl.createEl('h3', { text: 'Quote format' });

        new Setting(containerEl)
            .setName('Frontmatter type filter (optional)')
            .setDesc('If set, only notes in the Quotes folder whose "type" frontmatter property matches this value will be shown. Leave blank to include all notes in the Quotes folder regardless of frontmatter. Useful if your Quotes folder contains mixed content.')
            .addText(text => text
                .setPlaceholder('Leave blank to include all notes')
                .setValue(this.plugin.settings.quoteType)
                .onChange(async (v) => {
                    this.plugin.settings.quoteType = v.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sermon filename date format')
            .setDesc('The date format used in your sermon filenames.')
            .addDropdown(drop => drop
                .addOption('YYYYMMDD', 'YYYYMMDD  (e.g. 20240318CPT)')
                .addOption('YYYY-MM-DD', 'YYYY-MM-DD  (e.g. 2024-03-18-CPT)')
                .setValue(this.plugin.settings.sermonDateFormat)
                .onChange(async (v: 'YYYYMMDD' | 'YYYY-MM-DD') => {
                    this.plugin.settings.sermonDateFormat = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Place code position')
            .setDesc('Whether the place code comes before or after the date in the filename.')
            .addDropdown(drop => drop
                .addOption('after', 'After the date  (e.g. 20240318CPT)')
                .addOption('before', 'Before the date  (e.g. CPT20240318)')
                .setValue(this.plugin.settings.sermonPlacePosition)
                .onChange(async (v: 'after' | 'before') => {
                    this.plugin.settings.sermonPlacePosition = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Separator between date and place code')
            .setDesc('Any character between the date and place code. Leave blank if there is none (e.g. 20240318CPT). Use a hyphen for 2024-03-18-CPT.')
            .addText(text => text
                .setPlaceholder('none')
                .setValue(this.plugin.settings.sermonPlaceSeparator)
                .onChange(async (v) => {
                    this.plugin.settings.sermonPlaceSeparator = v;
                    await this.plugin.saveSettings();
                }));
    }
}