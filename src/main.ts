import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, TFile } from 'obsidian';

export const VIEW_TYPE_QUOTE_SEARCH = "quote-search-view";

interface QuoteSearchSettings {
    quotesFolder: string;
    authorsFolder: string;
    sermonsFolder: string;
    sourcesFolder: string;
}

const DEFAULT_SETTINGS: QuoteSearchSettings = {
    quotesFolder: 'Quotes',
    authorsFolder: 'Authors',
    sermonsFolder: 'Sermons',
    sourcesFolder: 'Sources'
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

        // Exact prefix match (setting is a full path like "03-Content/Services/Sermons")
        if (p.startsWith(folder + '/') || p === folder) return true;

        // Partial name match (setting is just "Sermons" — match as a path segment
        // anywhere in the file path, to support deep vault structures)
        if (!folder.includes('/')) {
            return p.startsWith(folder + '/') || p.includes('/' + folder + '/');
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

        for (const sermon of sermonFiles) {
            const m = sermon.basename.match(/^(\d{4})(\d{2})(\d{2})([A-Za-z]{2,5})/);
            if (!m) continue;

            const usage: SermonUsage = {
                date: `${m[1]}-${m[2]}-${m[3]}`,
                place: m[4].toUpperCase(),
                fileName: sermon.basename,
            };

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

        // Debug: open the developer console (Ctrl+Shift+I) to inspect these
        console.log(`[QuoteSearch] Sermon index built from ${sermonFiles.length} sermon files`);
        console.log(`[QuoteSearch] Index keys:`, [...index.keys()]);

        return index;
    }

    // ── Cache ─────────────────────────────────────────────────────────────────

    private rebuildCache() {
        const { quotesFolder } = this.plugin.settings;

        // Build sermon → quote index once, shared across all entries
        const sermonIndex = this.buildSermonIndex();

        const entries = this.app.vault.getMarkdownFiles()
            .filter(f => this.inFolder(f.path, quotesFolder))
            .reduce<QuoteEntry[]>((acc, file) => {
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;
                if (!fm || fm.type !== 'quote') return acc;

                const text = String(fm.quote || '');
                const authorRaw = Array.isArray(fm.author)
                    ? fm.author.join(', ')
                    : String(fm.author || '');
                const authorClean = authorRaw.replace(/[\[\]]/g, '');
                const tags: string[] = Array.isArray(fm.tags)
                    ? fm.tags.map(String)
                    : fm.tags
                        ? String(fm.tags).split(/[\s,]+/).filter(Boolean)
                        : [];

                const sourceRaw = Array.isArray(fm.source)
                    ? fm.source.join(', ')
                    : String(fm.source || '');
                const sourceClean = sourceRaw.replace(/[\[\]]/g, '');

                const sermons = sermonIndex.get(file.basename.toLowerCase()) ?? [];

                acc.push({ file, text, authorClean, sourceClean, tags, sermons,
                    lowerBlob: [text, authorClean, sourceClean, tags.join(' ')].join(' ').toLowerCase() });
                return acc;
            }, []);

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

    private renderResults(query: string) {
        if (!this.resultsEl) return;
        if (!this.cacheValid) this.rebuildCache();
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
            tags.forEach(tag => tagWrap.createSpan({ text: tag.replace(/^#/, ''), cls: 'qs-tag' }));
            const attribution = item.createDiv({ cls: 'qs-attribution' });
            if (authorClean) attribution.createSpan({ text: `— ${authorClean}`, cls: 'qs-author' });
            if (sourceClean) attribution.createSpan({ text: sourceClean, cls: 'qs-source' });

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
        this.searchDebounce = setTimeout(() => this.renderResults(query), 120);
    }

    // Only react to changes in the quotes or sermons folders — ignores all
    // edits to other documents, which was the main cause of lag.
    private onVaultChange(file: TFile) {
        const { quotesFolder, sermonsFolder } = this.plugin.settings;
        if (!this.inFolder(file.path, quotesFolder) && !this.inFolder(file.path, sermonsFolder)) return;
        this.invalidateCache();
        if (this.vaultDebounce) clearTimeout(this.vaultDebounce);
        this.vaultDebounce = setTimeout(() => this.renderResults(this.currentQuery), 800);
    }

    // ── File creation ─────────────────────────────────────────────────────────

    private async createNewQuoteFile(quote: string, author: string, source: string, tags: string) {
        const folder = this.plugin.settings.quotesFolder;
        if (!(await this.app.vault.adapter.exists(folder))) {
            await this.app.vault.createFolder(folder);
        }
        const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
        const yamlTags = tagList.length > 0 ? `\ntags:\n  - ${tagList.join('\n  - ')}` : '';
        const yamlSource = source ? `\nsource: "${source}"` : '';
        const content = `---\ntype: quote\nquote: "${quote.replace(/"/g, '\\"')}"\nauthor: "${author}"${yamlSource}${yamlTags}\n---\n${quote}\n\n{{author}} {{source}}`;
        await this.app.vault.create(`${folder}/${Date.now()}.md`, content);
        this.invalidateCache();
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
            await this.createNewQuoteFile(qInput.value.trim(), aInput.value.trim(), sInput.value.trim(), tInput.value.trim());
            qInput.value = ''; aInput.value = ''; sInput.value = ''; tInput.value = '';
            form.addClass('qs-hidden');
            addBtn.setText('+');
            this.renderResults(this.currentQuery);
        };

        // Search input + results container
        const searchInput = container.createEl('input', {
            type: 'text', placeholder: '🔍  Search quotes…', cls: 'qs-search'
        });
        this.resultsEl = container.createDiv({ cls: 'qs-results' });

        searchInput.addEventListener('input', () => this.scheduleSearchRender(searchInput.value));

        // Initial render
        this.rebuildCache();
        this.renderResults('');

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
        this.quoteCache = [];
    }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class QuoteSettingTab extends PluginSettingTab {
    plugin: QuoteSearchPlugin;
    constructor(app: App, plugin: QuoteSearchPlugin) { super(app, plugin); this.plugin = plugin; }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Quote Search Settings' });

        new Setting(containerEl)
            .setName('Quotes folder')
            .setDesc('Folder where quote notes are stored.')
            .addText(text => text
                .setPlaceholder('Quotes')
                .setValue(this.plugin.settings.quotesFolder)
                .onChange(async (v) => { this.plugin.settings.quotesFolder = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Authors folder')
            .setDesc('Folder containing author notes (used for autocomplete).')
            .addText(text => text
                .setPlaceholder('Authors')
                .setValue(this.plugin.settings.authorsFolder)
                .onChange(async (v) => { this.plugin.settings.authorsFolder = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Sermons folder')
            .setDesc('Folder containing sermon notes (used for usage tracking).')
            .addText(text => text
                .setPlaceholder('Sermons')
                .setValue(this.plugin.settings.sermonsFolder)
                .onChange(async (v) => { this.plugin.settings.sermonsFolder = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Sources folder')
            .setDesc('Folder containing source notes — books, articles, etc. (used for autocomplete).')
            .addText(text => text
                .setPlaceholder('Sources')
                .setValue(this.plugin.settings.sourcesFolder)
                .onChange(async (v) => { this.plugin.settings.sourcesFolder = v; await this.plugin.saveSettings(); }));
    }
}