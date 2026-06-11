// @ts-nocheck -- vendored from obsidian-clipper @ 372d420; keep byte-close to upstream.
export const decode_uri = (str: string): string => {
	try {
		return decodeURIComponent(str);
	} catch {
		// If decoding fails (e.g., malformed URI), return the original string
		return str;
	}
};
