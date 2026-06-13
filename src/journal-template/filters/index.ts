// Filter registry. These filters started from obsidian-clipper
// src/utils/filters @ 372d420 and are kept behavior-compatible while satisfying
// Obsidian plugin review's strict TypeScript lint checks.
import { blockquote } from "./blockquote";
import { calc } from "./calc";
import { callout } from "./callout";
import { camel } from "./camel";
import { capitalize } from "./capitalize";
import { date } from "./date";
import { date_modify } from "./date_modify";
import { decode_uri } from "./decode_uri";
import { duration } from "./duration";
import { first } from "./first";
import { footnote } from "./footnote";
import { image } from "./image";
import { join } from "./join";
import { kebab } from "./kebab";
import { last } from "./last";
import { length } from "./length";
import { link } from "./link";
import { list } from "./list";
import { lower } from "./lower";
import { map } from "./map";
import { merge } from "./merge";
import { nth } from "./nth";
import { number_format } from "./number_format";
import { object } from "./object";
import { pascal } from "./pascal";
import { replace } from "./replace";
import { reverse } from "./reverse";
import { round } from "./round";
import { safe_name } from "./safe_name";
import { slice } from "./slice";
import { snake } from "./snake";
import { split } from "./split";
import { strip_md } from "./strip_md";
import { table } from "./table";
import { template } from "./template";
import { title } from "./title";
import { trim } from "./trim";
import { uncamel } from "./uncamel";
import { unescape } from "./unescape";
import { unique } from "./unique";
import { upper } from "./upper";
import { wikilink } from "./wikilink";
import type { FilterFunction } from "./types";

export type { FilterFunction, ParamValidationResult } from "./types";

export const FILTERS: Record<string, FilterFunction> = {
	blockquote,
	calc,
	callout,
	camel,
	capitalize,
	date,
	date_modify,
	decode_uri,
	duration,
	first,
	footnote,
	image,
	join,
	kebab,
	last,
	length,
	link,
	list,
	lower,
	map,
	merge,
	nth,
	number_format,
	object,
	pascal,
	replace,
	reverse,
	round,
	safe_name,
	slice,
	snake,
	split,
	strip_md,
	table,
	template,
	title,
	trim,
	uncamel,
	unescape,
	unique,
	upper,
	wikilink,
};
