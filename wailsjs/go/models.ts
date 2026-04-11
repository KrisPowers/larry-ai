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

export namespace storage {
	
	export class AppSettings {
	    defaultModel: string;
	    defaultChatPreset: string;
	    defaultReasoningEffort: string;
	    developerToolsEnabled: boolean;
	    advancedUseEnabled: boolean;
	    ollamaEndpoint: string;
	    openAIApiKey: string;
	    anthropicApiKey: string;
	
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
	        this.ollamaEndpoint = source["ollamaEndpoint"];
	        this.openAIApiKey = source["openAIApiKey"];
	        this.anthropicApiKey = source["anthropicApiKey"];
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

