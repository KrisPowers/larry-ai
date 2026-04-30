export namespace ollama {
	
	export class ChatMessage {
	    role: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new ChatMessage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.role = source["role"];
	        this.content = source["content"];
	    }
	}

}

export namespace replyreview {
	
	export class Issue {
	    code: string;
	    severity: string;
	    message: string;
	    evidence?: string;
	
	    static createFrom(source: any = {}) {
	        return new Issue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.code = source["code"];
	        this.severity = source["severity"];
	        this.message = source["message"];
	        this.evidence = source["evidence"];
	    }
	}
	export class Request {
	    prompt: string;
	    draft: string;
	    referenceDate: string;
	    fetchLiveContext: boolean;
	    verifiedSourceCount: number;
	    preferredSourceCount: number;
	
	    static createFrom(source: any = {}) {
	        return new Request(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.prompt = source["prompt"];
	        this.draft = source["draft"];
	        this.referenceDate = source["referenceDate"];
	        this.fetchLiveContext = source["fetchLiveContext"];
	        this.verifiedSourceCount = source["verifiedSourceCount"];
	        this.preferredSourceCount = source["preferredSourceCount"];
	    }
	}
	export class Result {
	    approved: boolean;
	    requiresRewrite: boolean;
	    sanitizedReply: string;
	    reviewSummary: string;
	    rewritePrompt?: string;
	    issues: Issue[];
	
	    static createFrom(source: any = {}) {
	        return new Result(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.approved = source["approved"];
	        this.requiresRewrite = source["requiresRewrite"];
	        this.sanitizedReply = source["sanitizedReply"];
	        this.reviewSummary = source["reviewSummary"];
	        this.rewritePrompt = source["rewritePrompt"];
	        this.issues = this.convertValues(source["issues"], Issue);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace searchengine {
	
	export class CrawlRequest {
	    maxPages: number;
	    maxDepth: number;
	
	    static createFrom(source: any = {}) {
	        return new CrawlRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.maxPages = source["maxPages"];
	        this.maxDepth = source["maxDepth"];
	    }
	}
	export class CrawlSummary {
	    startedAt: number;
	    completedAt: number;
	    seedCount: number;
	    scheduledCount: number;
	    crawledCount: number;
	    indexedCount: number;
	    discoveredCount: number;
	    skippedCount: number;
	    errorCount: number;
	    lastError?: string;
	
	    static createFrom(source: any = {}) {
	        return new CrawlSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.startedAt = source["startedAt"];
	        this.completedAt = source["completedAt"];
	        this.seedCount = source["seedCount"];
	        this.scheduledCount = source["scheduledCount"];
	        this.crawledCount = source["crawledCount"];
	        this.indexedCount = source["indexedCount"];
	        this.discoveredCount = source["discoveredCount"];
	        this.skippedCount = source["skippedCount"];
	        this.errorCount = source["errorCount"];
	        this.lastError = source["lastError"];
	    }
	}
	export class IndexDocument {
	    url: string;
	    title: string;
	    snippet: string;
	    content: string;
	    source: string;
	    lastCrawledAt: number;
	
	    static createFrom(source: any = {}) {
	        return new IndexDocument(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.url = source["url"];
	        this.title = source["title"];
	        this.snippet = source["snippet"];
	        this.content = source["content"];
	        this.source = source["source"];
	        this.lastCrawledAt = source["lastCrawledAt"];
	    }
	}
	export class IndexSummary {
	    received: number;
	    indexed: number;
	    skipped: number;
	    completedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new IndexSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.received = source["received"];
	        this.indexed = source["indexed"];
	        this.skipped = source["skipped"];
	        this.completedAt = source["completedAt"];
	    }
	}
	export class SearchResult {
	    url: string;
	    title: string;
	    snippet: string;
	    content: string;
	    host: string;
	    source: string;
	    lastCrawledAt: number;
	    score: number;
	
	    static createFrom(source: any = {}) {
	        return new SearchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.url = source["url"];
	        this.title = source["title"];
	        this.snippet = source["snippet"];
	        this.content = source["content"];
	        this.host = source["host"];
	        this.source = source["source"];
	        this.lastCrawledAt = source["lastCrawledAt"];
	        this.score = source["score"];
	    }
	}
	export class SearchResponse {
	    query: string;
	    tookMs: number;
	    total: number;
	    results: SearchResult[];
	
	    static createFrom(source: any = {}) {
	        return new SearchResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.query = source["query"];
	        this.tookMs = source["tookMs"];
	        this.total = source["total"];
	        this.results = this.convertValues(source["results"], SearchResult);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Seed {
	    id: string;
	    url: string;
	    label: string;
	    host: string;
	    createdAt: number;
	    updatedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new Seed(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.url = source["url"];
	        this.label = source["label"];
	        this.host = source["host"];
	        this.createdAt = source["createdAt"];
	        this.updatedAt = source["updatedAt"];
	    }
	}
	export class Status {
	    databasePath: string;
	    seedCount: number;
	    documentCount: number;
	    lastIndexedAt: number;
	    lastCrawl?: CrawlSummary;
	    defaultMaxPages: number;
	    defaultMaxDepth: number;
	    fetchConcurrency: number;
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.databasePath = source["databasePath"];
	        this.seedCount = source["seedCount"];
	        this.documentCount = source["documentCount"];
	        this.lastIndexedAt = source["lastIndexedAt"];
	        this.lastCrawl = this.convertValues(source["lastCrawl"], CrawlSummary);
	        this.defaultMaxPages = source["defaultMaxPages"];
	        this.defaultMaxDepth = source["defaultMaxDepth"];
	        this.fetchConcurrency = source["fetchConcurrency"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace storage {
	
	export class ProviderConnectionSettings {
	    selectedModels: string[];
	    autoUpdate: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ProviderConnectionSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.selectedModels = source["selectedModels"];
	        this.autoUpdate = source["autoUpdate"];
	    }
	}
	export class ProviderSettingsMap {
	    ollama: ProviderConnectionSettings;
	    openai: ProviderConnectionSettings;
	    anthropic: ProviderConnectionSettings;
	
	    static createFrom(source: any = {}) {
	        return new ProviderSettingsMap(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ollama = this.convertValues(source["ollama"], ProviderConnectionSettings);
	        this.openai = this.convertValues(source["openai"], ProviderConnectionSettings);
	        this.anthropic = this.convertValues(source["anthropic"], ProviderConnectionSettings);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AppSettings {
	    defaultModel: string;
	    defaultChatPreset: string;
	    defaultReasoningEffort: string;
	    developerToolsEnabled: boolean;
	    advancedUseEnabled: boolean;
	    codeEditorAutoSaveEnabled: boolean;
	    codeEditorIndentGuidesEnabled: boolean;
	    codeEditorSetupGuideEnabled: boolean;
	    codeEditorDependencyInstallEnabled: boolean;
	    ollamaEndpoint: string;
	    openAIApiKey: string;
	    anthropicApiKey: string;
	    providerSettings: ProviderSettingsMap;
	
	    static createFrom(source: any = {}) {
	        return new AppSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.defaultModel = source["defaultModel"];
	        this.defaultChatPreset = source["defaultChatPreset"];
	        this.defaultReasoningEffort = source["defaultReasoningEffort"];
	        this.developerToolsEnabled = source["developerToolsEnabled"];
	        this.advancedUseEnabled = source["advancedUseEnabled"];
	        this.codeEditorAutoSaveEnabled = source["codeEditorAutoSaveEnabled"];
	        this.codeEditorIndentGuidesEnabled = source["codeEditorIndentGuidesEnabled"];
	        this.codeEditorSetupGuideEnabled = source["codeEditorSetupGuideEnabled"];
	        this.codeEditorDependencyInstallEnabled = source["codeEditorDependencyInstallEnabled"];
	        this.ollamaEndpoint = source["ollamaEndpoint"];
	        this.openAIApiKey = source["openAIApiKey"];
	        this.anthropicApiKey = source["anthropicApiKey"];
	        this.providerSettings = this.convertValues(source["providerSettings"], ProviderSettingsMap);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class Snapshot {
	    settings: AppSettings;
	    workspaces: any[];
	    chats: any[];
	    replyPreferences: any[];
	
	    static createFrom(source: any = {}) {
	        return new Snapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.settings = this.convertValues(source["settings"], AppSettings);
	        this.workspaces = source["workspaces"];
	        this.chats = source["chats"];
	        this.replyPreferences = source["replyPreferences"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace workspace {
	
	export class BackupSummary {
	    id: string;
	    label: string;
	    createdAt: number;
	    archivePath: string;
	
	    static createFrom(source: any = {}) {
	        return new BackupSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.createdAt = source["createdAt"];
	        this.archivePath = source["archivePath"];
	    }
	}
	export class CommandResult {
	    command: string;
	    exitCode: number;
	    stdout: string;
	    stderr: string;
	    combinedOutput: string;
	    durationMs: number;
	    timedOut: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CommandResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.command = source["command"];
	        this.exitCode = source["exitCode"];
	        this.stdout = source["stdout"];
	        this.stderr = source["stderr"];
	        this.combinedOutput = source["combinedOutput"];
	        this.durationMs = source["durationMs"];
	        this.timedOut = source["timedOut"];
	    }
	}
	export class Document {
	    path: string;
	    content: string;
	    lang: string;
	    sizeBytes: number;
	    modifiedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new Document(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.lang = source["lang"];
	        this.sizeBytes = source["sizeBytes"];
	        this.modifiedAt = source["modifiedAt"];
	    }
	}
	export class FileEntry {
	    path: string;
	    content: string;
	    lang: string;
	    updatedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new FileEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.lang = source["lang"];
	        this.updatedAt = source["updatedAt"];
	    }
	}
	export class FileNode {
	    name: string;
	    path: string;
	    kind: string;
	    extension?: string;
	    children?: FileNode[];
	
	    static createFrom(source: any = {}) {
	        return new FileNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.kind = source["kind"];
	        this.extension = source["extension"];
	        this.children = this.convertValues(source["children"], FileNode);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RuntimeCommand {
	    kind: string;
	    label: string;
	    command: string;
	
	    static createFrom(source: any = {}) {
	        return new RuntimeCommand(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.label = source["label"];
	        this.command = source["command"];
	    }
	}
	export class RuntimeProfile {
	    ecosystem: string;
	    label: string;
	    detectedFiles: string[];
	    commands: RuntimeCommand[];
	
	    static createFrom(source: any = {}) {
	        return new RuntimeProfile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ecosystem = source["ecosystem"];
	        this.label = source["label"];
	        this.detectedFiles = source["detectedFiles"];
	        this.commands = this.convertValues(source["commands"], RuntimeCommand);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Snapshot {
	    rootPath: string;
	    fileTree: FileNode[];
	    fileEntries: FileEntry[];
	    fileCount: number;
	    directoryCount: number;
	    syncedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new Snapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rootPath = source["rootPath"];
	        this.fileTree = this.convertValues(source["fileTree"], FileNode);
	        this.fileEntries = this.convertValues(source["fileEntries"], FileEntry);
	        this.fileCount = source["fileCount"];
	        this.directoryCount = source["directoryCount"];
	        this.syncedAt = source["syncedAt"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Selection {
	    label: string;
	    rootPath: string;
	    snapshot: Snapshot;
	
	    static createFrom(source: any = {}) {
	        return new Selection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.label = source["label"];
	        this.rootPath = source["rootPath"];
	        this.snapshot = this.convertValues(source["snapshot"], Snapshot);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

