import { randomBytes } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Simple UUID v4 generator
function uuidv4(): string {
	const bytes = randomBytes(16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SessionConfig {
	model: string;
	baseURL: string;
	isGptOss: boolean;
	apiKey?: string;
	systemPrompt?: string;
}

export interface TokenUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
}

export interface SessionData {
	config: SessionConfig;
	messages: any[];
	totalUsage: TokenUsage;
}

export class SessionManager {
	private sessionId!: string;
	private sessionFile!: string;
	private sessionDir: string;

	constructor(continueSession: boolean = false) {
		this.sessionDir = this.getSessionDirectory();

		if (continueSession) {
			const mostRecent = this.findMostRecentSession();
			if (mostRecent) {
				this.sessionFile = mostRecent;
				// Load session ID from file
				this.loadSessionId();
			} else {
				// No existing session, create new
				this.initNewSession();
			}
		} else {
			this.initNewSession();
		}
	}

	private getSessionDirectory(): string {
		const cwd = process.cwd();
		// Replace slashes with dashes, prepend with --
		const safePath = "--" + cwd.replace(/^\//, "").replace(/\//g, "-");

		const sessionDir = join(homedir(), ".pi", "sessions", safePath);
		mkdirSync(sessionDir, { recursive: true });
		return sessionDir;
	}

	private initNewSession(): void {
		this.sessionId = uuidv4();
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.sessionFile = join(this.sessionDir, `session_${this.sessionId}_${timestamp}.jsonl`);
	}

	private findMostRecentSession(): string | null {
		try {
			const files = readdirSync(this.sessionDir)
				.filter((f) => f.startsWith("session_") && f.endsWith(".jsonl"))
				.map((f) => ({
					name: f,
					path: join(this.sessionDir, f),
					mtime: statSync(join(this.sessionDir, f)).mtime,
				}))
				.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			return files[0]?.path || null;
		} catch {
			return null;
		}
	}

	private loadSessionId(): void {
		if (!existsSync(this.sessionFile)) return;

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session") {
					this.sessionId = entry.id;
					return;
				}
			} catch {
				// Skip malformed lines
			}
		}
		// If no session entry found, create new ID
		this.sessionId = uuidv4();
	}

	logSession(config: SessionConfig): void {
		const entry = {
			type: "session",
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			config: {
				model: config.model,
				baseURL: config.baseURL,
				isGptOss: config.isGptOss,
				systemPrompt: config.systemPrompt,
				// Don't log API key
			},
		};
		appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
	}

	logMessage(message: any): void {
		const entry = {
			type: "message",
			timestamp: new Date().toISOString(),
			data: message,
		};
		appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
	}

	logUsage(usage: TokenUsage): void {
		const entry = {
			type: "usage",
			timestamp: new Date().toISOString(),
			data: usage,
		};
		appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
	}

	loadSession(): SessionData | null {
		if (!existsSync(this.sessionFile)) return null;

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");
		let config: SessionConfig | null = null;
		const messages: any[] = [];
		const totalUsage: TokenUsage = {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		};

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session") {
					config = entry.config;
					this.sessionId = entry.id;
				} else if (entry.type === "message") {
					messages.push(entry.data);
				} else if (entry.type === "usage") {
					// Accumulate usage for session summary
					totalUsage.prompt_tokens += entry.data.prompt_tokens || 0;
					totalUsage.completion_tokens += entry.data.completion_tokens || 0;
					totalUsage.total_tokens += entry.data.total_tokens || 0;
					totalUsage.cache_read_tokens += entry.data.cache_read_tokens || 0;
					totalUsage.cache_write_tokens += entry.data.cache_write_tokens || 0;
				}
			} catch {
				// Skip malformed lines
			}
		}

		return config && messages.length > 0 ? { config, messages, totalUsage } : null;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string {
		return this.sessionFile;
	}
}
