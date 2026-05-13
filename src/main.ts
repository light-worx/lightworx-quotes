import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, TFile } from 'obsidian';

export const VIEW_TYPE_QUOTE_SEARCH = "quote-search-view";

interface QuoteSearchSettings {
    quotesFolder: string;
    authorsFolder: string;
    sermonsFolder: string;
}

const DEFAULT_SETTINGS: QuoteSearchSettings = {
    quotesFolder: 'Quotes',
    authorsFolder: 'Authors',
    sermonsFolder: 'Sermons'
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

class QuoteSearchView extends ItemView {
    plugin: QuoteSearchPlugin;
    private authorSuggestions: string[] = [];
    private tagSuggestions: string[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: QuoteSearchPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_TYPE_QUOTE_SEARCH; }
    getDisplayText() { return "Quote Search"; }
    getIcon() { return "quote-glyph"; }

    refreshMetadataLists() {
        const authorFolder = this.plugin.settings.authorsFolder.trim();
        
        // Find authors using a more robust path check
        this.authorSuggestions = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.toLowerCase().startsWith(authorFolder.toLowerCase()))
            .map(f => `[[${f.basename}]]`);

        // @ts-ignore
        const tagCache = this.app.metadataCache.getTags();
        this.tagSuggestions = Object.keys(tagCache).map(t => t.replace("#", ""));

        console.log("Quote Searcher Debug:", {
            authorsCount: this.authorSuggestions.length,
            tagsCount: this.tagSuggestions.length,
            pathUsed: authorFolder
        });
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass("quote-search-sidebar");

        const header = container.createDiv({ cls: "quote-header" });
        header.createEl("h4", { text: "Quotes" });
        const addBtn = header.createEl("button", { text: "+", cls: "quote-add-btn" });

        const formContainer = container.createDiv({ cls: "quote-form-container hidden" });
        const qInput = formContainer.createEl("textarea", { placeholder: "Quote text...", cls: "quote-form-input" });
        
        const aContainer = formContainer.createDiv({ cls: "suggest-container" });
        const aInput = aContainer.createEl("input", { placeholder: "Author...", cls: "quote-form-input" });
        const aSuggest = aContainer.createDiv({ cls: "suggestion-drop hidden" });

        const tContainer = formContainer.createDiv({ cls: "suggest-container" });
        const tInput = tContainer.createEl("input", { placeholder: "Tags...", cls: "quote-form-input" });
        const tSuggest = tContainer.createDiv({ cls: "suggestion-drop hidden" });

        const saveBtn = formContainer.createEl("button", { text: "Save Quote", cls: "quote-save-btn" });

        const setupSuggest = (input: HTMLInputElement, drop: HTMLDivElement, list: string[], isTags = false) => {
            input.addEventListener("input", () => {
                const val = input.value.split(",").pop()?.trim().toLowerCase() || "";
                if (!val) { drop.addClass("hidden"); return; }
                const matches = list.filter(i => i.toLowerCase().includes(val)).slice(0, 10);
                if (matches.length === 0) { drop.addClass("hidden"); return; }
                drop.empty(); drop.removeClass("hidden");
                matches.forEach(m => {
                    const item = drop.createDiv({ text: m, cls: "suggestion-item" });
                    item.onclick = () => {
                        if (isTags) {
                            const parts = input.value.split(",").map(p => p.trim());
                            parts.pop(); parts.push(m);
                            input.value = parts.join(", ") + ", ";
                        } else { input.value = m; }
                        drop.addClass("hidden"); input.focus();
                    };
                });
            });
        };

        setupSuggest(aInput, aSuggest, this.authorSuggestions);
        setupSuggest(tInput, tSuggest, this.tagSuggestions, true);

        addBtn.onclick = () => {
            this.refreshMetadataLists();
            formContainer.classList.toggle("hidden");
        };

        saveBtn.onclick = async () => {
            if (!qInput.value.trim()) return;
            await this.createNewQuoteFile(qInput.value, aInput.value, tInput.value);
            qInput.value = ""; aInput.value = ""; tInput.value = "";
            formContainer.addClass("hidden");
        };

        const searchInput = container.createEl("input", { type: "text", placeholder: "Search quotes...", cls: "quote-search-input" });
        const resultsContainer = container.createDiv({ cls: "quote-search-results" });
        searchInput.addEventListener("input", () => this.renderResults(searchInput.value, resultsContainer));
        
        this.renderResults("", resultsContainer);
        this.registerEvent(this.app.vault.on("modify", () => this.renderResults(searchInput.value, resultsContainer)));
    }

    async createNewQuoteFile(quote: string, author: string, tags: string) {
        const folder = this.plugin.settings.quotesFolder;
        if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
        const fileName = `${folder}/${Date.now()}.md`;
        const tagList = tags.split(",").map(t => t.trim()).filter(t => t !== "");
        const yamlTags = tagList.length > 0 ? `\ntags:\n  - ${tagList.join("\n  - ")}` : "";
        const fileContent = `---\ntype: quote\nquote: "${quote.replace(/"/g, '\\"')}"\nauthor: "${author}"${yamlTags}\n---\n${quote}`;
        await this.app.vault.create(fileName, fileContent);
    }

    renderResults(query: string, resultsEl: HTMLElement) {
        resultsEl.empty();
        const lowerQuery = query.toLowerCase();
        const { quotesFolder, sermonsFolder } = this.plugin.settings;
        const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(quotesFolder));

        files.forEach(file => {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;
            if (fm && fm.type === 'quote') {
                const text = String(fm.quote || "");
                const authorRaw = Array.isArray(fm.author) ? fm.author.join(", ") : String(fm.author || "");
                const authorClean = authorRaw.replace(/[\[\]]/g, '');
                let tagsArr: string[] = Array.isArray(fm.tags) ? fm.tags : (fm.tags ? String(fm.tags).split(/[\s,]+/) : []);

                if (text.toLowerCase().includes(lowerQuery) || authorClean.toLowerCase().includes(lowerQuery) || tagsArr.some(t => String(t).toLowerCase().includes(lowerQuery))) {
                    const item = resultsEl.createDiv({ cls: "quote-item" });
                    item.createDiv({ text: text, cls: "quote-text" });
                    const metaRow = item.createDiv({ cls: "quote-meta-row" });
                    const tagContainer = metaRow.createDiv({ cls: "quote-tag-container" });
                    tagsArr.forEach(tag => { tagContainer.createDiv({ text: String(tag).replace("#", ""), cls: "quote-tag-badge" }); });
                    metaRow.createDiv({ text: `— ${authorClean}`, cls: "quote-author" });

                    // --- Sermon Logic ---
                    const backlinkData = this.app.metadataCache.getBacklinksForFile(file);
                    if (backlinkData) {
                        const sermonLinks: { date: string, place: string }[] = [];
                        Object.keys(backlinkData.data).forEach(linkPath => {
                            // Check if file is in sermons folder
                            if (linkPath.toLowerCase().includes(sermonsFolder.toLowerCase())) {
                                const fileName = linkPath.split('/').pop()?.replace('.md', '') || "";
                                // Regex: 8 digits followed by 3 letters
                                const match = fileName.match(/(\d{4})(\d{2})(\d{2})([A-Z]{3})/);
                                if (match) {
                                    sermonLinks.push({ date: `${match[1]}-${match[2]}-${match[3]}`, place: match[4] });
                                }
                            }
                        });

                        if (sermonLinks.length > 0) {
                            sermonLinks.sort((a, b) => b.date.localeCompare(a.date));
                            const last = sermonLinks[0];
                            const usage = item.createDiv({ cls: "quote-usage-row" });
                            usage.createSpan({ text: `Last used: ${last.date} (${last.place}) • ${sermonLinks.length}x`, cls: "quote-usage-text" });
                        }
                    }
                    item.onClickEvent(() => this.app.workspace.getLeaf().openFile(file));
                }
            }
        });
    }
}

class QuoteSettingTab extends PluginSettingTab {
    plugin: QuoteSearchPlugin;
    constructor(app: App, plugin: QuoteSearchPlugin) { super(app, plugin); this.plugin = plugin; }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl).setName('Quotes Folder').addText(text => text.setValue(this.plugin.settings.quotesFolder).onChange(async (v) => { this.plugin.settings.quotesFolder = v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Authors Folder').addText(text => text.setValue(this.plugin.settings.authorsFolder).onChange(async (v) => { this.plugin.settings.authorsFolder = v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Sermons Folder').addText(text => text.setValue(this.plugin.settings.sermonsFolder).onChange(async (v) => { this.plugin.settings.sermonsFolder = v; await this.plugin.saveSettings(); }));
    }
}