import { resolve } from "path";
import { homedir } from "os";

export type ArgDef = {
	type: "flag" | "boolean" | "int" | "float" | "string" | "file";
	alias?: string;
	default?: any;
	description?: string;
};

export type ArgDefs = Record<string, ArgDef>;

export type ParsedArgs<T extends ArgDefs> = {
	[K in keyof T]: T[K]["type"] extends "flag"
		? boolean
		: T[K]["type"] extends "boolean"
		? boolean
		: T[K]["type"] extends "int"
		? number
		: T[K]["type"] extends "float"
		? number
		: T[K]["type"] extends "string"
		? string
		: T[K]["type"] extends "file"
		? string
		: never;
} & {
	_: string[]; // Positional arguments
};

export function parseArgs<T extends ArgDefs>(defs: T, args: string[]): ParsedArgs<T> {
	const result: any = { _: [] };
	const aliasMap: Record<string, string> = {};

	// Build alias map and set defaults
	for (const [key, def] of Object.entries(defs)) {
		if (def.alias) {
			aliasMap[def.alias] = key;
		}
		if (def.default !== undefined) {
			result[key] = def.default;
		} else if (def.type === "flag" || def.type === "boolean") {
			result[key] = false;
		}
	}

	// Parse arguments
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		// Check if it's a flag
		if (arg.startsWith("--")) {
			const flagName = arg.slice(2);
			const key = aliasMap[flagName] || flagName;
			const def = defs[key];

			if (!def) {
				// Unknown flag, add to positional args
				result._.push(arg);
				continue;
			}

			if (def.type === "flag") {
				// Simple on/off flag
				result[key] = true;
			} else if (i + 1 < args.length) {
				// Flag with value
				const value = args[++i];
				
				switch (def.type) {
					case "boolean":
						result[key] = value === "true" || value === "1" || value === "yes";
						break;
					case "int":
						result[key] = parseInt(value, 10);
						if (isNaN(result[key])) {
							throw new Error(`Invalid integer value for --${key}: ${value}`);
						}
						break;
					case "float":
						result[key] = parseFloat(value);
						if (isNaN(result[key])) {
							throw new Error(`Invalid float value for --${key}: ${value}`);
						}
						break;
					case "string":
						result[key] = value;
						break;
					case "file":
						// Resolve ~ to home directory and make absolute
						let path = value;
						if (path.startsWith("~")) {
							path = path.replace("~", homedir());
						}
						result[key] = resolve(path);
						break;
				}
			} else {
				throw new Error(`Flag --${key} requires a value`);
			}
		} else if (arg.startsWith("-") && arg.length === 2) {
			// Short flag like -h
			const flagChar = arg[1];
			const key = aliasMap[flagChar] || flagChar;
			const def = defs[key];

			if (!def) {
				result._.push(arg);
				continue;
			}

			if (def.type === "flag") {
				result[key] = true;
			} else {
				throw new Error(`Short flag -${flagChar} cannot have a value`);
			}
		} else {
			// Positional argument
			result._.push(arg);
		}
	}

	return result as ParsedArgs<T>;
}

export function printHelp<T extends ArgDefs>(defs: T, usage: string): void {
	console.log(usage);
	console.log("\nOptions:");
	
	for (const [key, def] of Object.entries(defs)) {
		let line = `  --${key}`;
		if (def.alias) {
			line += `, -${def.alias}`;
		}
		
		if (def.type !== "flag") {
			const typeStr = def.type === "file" ? "path" : def.type;
			line += ` <${typeStr}>`;
		}
		
		if (def.description) {
			// Pad to align descriptions
			line = line.padEnd(25) + def.description;
		}
		
		if (def.default !== undefined) {
			line += ` (default: ${def.default})`;
		}
		
		console.log(line);
	}
}