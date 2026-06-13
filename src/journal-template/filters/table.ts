import { isFilterRecord, isUnknownArray, parseJsonValue, valueToString } from "./types";

export const table = (str: string, params?: string): string => {
	// Handle empty or invalid input
	if (!str || str === 'undefined' || str === 'null') {
		return str;
	}

	try {
		const data = parseJsonValue(str);
		let customHeaders: string[] = [];

		// Parse custom headers from params if provided
		if (params) {
			try {
				// Remove outer parentheses if present and split by comma
				const headerStr = params.replace(/^\((.*)\)$/, '$1');
				customHeaders = headerStr.split(',').map(header => 
					header.trim().replace(/^["'](.*)["']$/, '$1')
				);
			} catch (error) {
				console.error('Error parsing table headers:', error);
			}
		}

		// Function to escape pipe characters in cell content
		const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|');

		// Handle single object
		if (isFilterRecord(data)) {
			const entries = Object.entries(data);
			if (entries.length === 0) return str;

			const [firstEntry, ...restEntries] = entries;
			if (!firstEntry) {
				return str;
			}
			const [firstKey, firstValue] = firstEntry;
			let table = `| ${escapeCell(firstKey)} | ${escapeCell(String(firstValue))} |\n| - | - |\n`;
			
			restEntries.forEach(([key, value]) => {
				table += `| ${escapeCell(key)} | ${escapeCell(String(value))} |\n`;
			});
			return table.trim();
		}

		// Handle array of objects
		if (isNonEmptyRecordArray(data)) {
			const headers = customHeaders.length > 0 ? customHeaders : Object.keys(data[0]);
			let table = `| ${headers.join(' | ')} |\n| ${headers.map(() => '-').join(' | ')} |\n`;
			
			data.forEach(row => {
				table += `| ${headers.map(header => escapeCell(valueToString(row[header]))).join(' | ')} |\n`;
			});

			return table.trim();
		}

		// Handle array of arrays
		if (isNonEmptyArrayOfArrays(data)) {
			const maxColumns = Math.max(...data.map(row => row.length));
			const headers = customHeaders.length > 0 ? customHeaders : new Array<string>(maxColumns).fill('');
			let table = `| ${headers.join(' | ')} |\n| ${headers.map(() => '-').join(' | ')} |\n`;

			data.forEach(row => {
				const padding = new Array<string>(maxColumns - row.length).fill('');
				const paddedRow: unknown[] = [...row, ...padding];
				table += `| ${paddedRow.map(cell => escapeCell(valueToString(cell))).join(' | ')} |\n`;
			});

			return table.trim();
		}

		// Handle simple array with custom headers
		if (isUnknownArray(data)) {
			if (customHeaders.length > 0) {
				const numColumns = customHeaders.length;
				let table = `| ${customHeaders.join(' | ')} |\n| ${customHeaders.map(() => '-').join(' | ')} |\n`;
				
				// Break the array into rows based on the number of columns
				for (let i = 0; i < data.length; i += numColumns) {
					const row = data.slice(i, i + numColumns);
					// Pad the row with empty strings if needed
					const padding = new Array<string>(numColumns - row.length).fill('');
					const paddedRow: unknown[] = [...row, ...padding];
					table += `| ${paddedRow.map(cell => escapeCell(valueToString(cell))).join(' | ')} |\n`;
				}
				return table.trim();
			}

			// Default single column table if no headers provided
			let table = "| Value |\n| - |\n";
			data.forEach(item => {
				table += `| ${escapeCell(String(item))} |\n`;
			});

			return table.trim();
		}

		// If none of the above cases match, return the original string
		return str;
	} catch (error) {
		console.error('Error parsing JSON for table filter:', error);
		return str;
	}
};

function isNonEmptyRecordArray(value: unknown): value is [Record<string, unknown>, ...Record<string, unknown>[]] {
	return Array.isArray(value) && value.length > 0 && value.every(isFilterRecord);
}

function isNonEmptyArrayOfArrays(value: unknown): value is [unknown[], ...unknown[][]] {
	return Array.isArray(value) && value.length > 0 && value.every(Array.isArray);
}
