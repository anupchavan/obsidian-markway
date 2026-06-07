export function parseFilterExpression(expression: string): { name: string; param?: string } {
	const index = expression.indexOf(":");
	if (index === -1) {
		return { name: expression.trim() };
	}
	return {
		name: expression.slice(0, index).trim(),
		param: expression.slice(index + 1).trim(),
	};
}

export function splitPipeline(expression: string): string[] {
	return splitTopLevel(expression, "|");
}

export function splitTopLevel(value: string, delimiter: string): string[] {
	const result: string[] = [];
	let current = "";
	let quote: string | null = null;
	let escaped = false;
	let parenDepth = 0;

	for (const character of value) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			current += character;
			escaped = true;
			continue;
		}
		if (quote) {
			current += character;
			if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === "\"" || character === "'") {
			current += character;
			quote = character;
			continue;
		}
		if (character === "(") {
			parenDepth += 1;
		} else if (character === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
		}
		if (character === delimiter && parenDepth === 0) {
			result.push(current.trim());
			current = "";
		} else {
			current += character;
		}
	}

	result.push(current.trim());
	return result.filter((part) => part.length > 0);
}

export function stripParamWrapper(param = ""): string {
	return param
		.replace(/^\(([\s\S]*)\)$/, "$1")
		.trim();
}

export function stripQuotes(value: string): string {
	return value.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
}
