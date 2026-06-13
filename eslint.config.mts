import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

type FlatConfig = Parameters<typeof tseslint.config>[number];
const obsidianRecommended = Array.from(
	(obsidianmd.configs?.recommended ?? []) as Iterable<FlatConfig>
);

export default tseslint.config(
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"package.json",
		"package-lock.json",
		"scripts/*.mjs",
		// Vendored copies of obsidian-clipper filters; kept byte-close to
		// upstream instead of restyled to this repo's lint rules.
		"src/journal-template/filters/*",
		"!src/journal-template/filters/index.ts",
		"!src/journal-template/filters/types.ts",
		"!src/journal-template/filters/string-utils.ts",
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'manifest.json',
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianRecommended,
);
