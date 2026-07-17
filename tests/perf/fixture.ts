/**
 * A synthetic Craft project, big enough to be worth measuring.
 *
 * Generated rather than committed: 500 templates of checked-in noise would be
 * repo weight nobody reads, and a seeded generator says more about what the
 * shapes are than the files would. The shapes are lifted from
 * `tests/grammar/fixtures/real-world.twig` — deep `{% block %}` nesting, filter
 * chains, `craft.*` queries, embedded HTML and CSS — so the parse work is the
 * work a real project asks for, not a `{{ x }}` repeated 2,000 times.
 */

/** Deterministic PRNG: same project every run, so numbers compare run to run. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

const SECTIONS = ['news', 'blog', 'events', 'careers', 'press'];
const FIELDS = ['heroImage', 'body', 'summary', 'author', 'tags', 'relatedEntries'];
const FILTERS = ['upper', 'trim', 'striptags', 'raw', 'length', 'join', 'first'];

export interface GeneratedProject {
	/** Template path (relative, POSIX) → source. */
	readonly templates: ReadonlyMap<string, string>;
}

/** One template: a layout child with blocks, loops, queries and embedded markup. */
function generateTemplate(index: number, random: () => number): string {
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
	const section = pick(SECTIONS);
	const lines: string[] = [
		`{% extends '_layouts/site.twig' %}`,
		`{% import '_macros/forms.twig' as forms %}`,
		``,
		`{% set pageTitle = entry.seoTitle ?? entry.title ?? 'Untitled ${index}' %}`,
		`{% set related = craft.entries.section('${section}').limit(${1 + (index % 9)}).all() %}`,
		``,
		`{% block head %}`,
		`\t{{ parent() }}`,
		`\t<meta property="og:title" content="{{ pageTitle|striptags|trim }}">`,
		`\t<style>.post-${index} { color: #${(index * 7919).toString(16).slice(0, 6)}; }</style>`,
		`{% endblock %}`,
		``,
		`{% block content %}`,
		`\t<article class="post post--${section}" data-id="{{ entry.id }}">`,
		`\t\t<h1>{{ pageTitle|e('html') }}</h1>`,
		`\t\t<time datetime="{{ entry.postDate|date('Y-m-d') }}">{{ entry.postDate|date('F j, Y') }}</time>`,
	];

	for (let block = 0; block < 3; block += 1) {
		const field = pick(FIELDS);
		const filter = pick(FILTERS);
		lines.push(
			`\t\t{% for item in entry.${field}.all() %}`,
			`\t\t\t{% if item.enabled and item.${field} is not empty %}`,
			`\t\t\t\t<div class="item item--{{ loop.index }}">`,
			`\t\t\t\t\t{{ item.title|${filter} }}`,
			`\t\t\t\t\t{% include '_partials/card.twig' with { entry: item } only %}`,
			`\t\t\t\t</div>`,
			`\t\t\t{% else %}`,
			`\t\t\t\t{# nothing to render for ${field} #}`,
			`\t\t\t{% endif %}`,
			`\t\t{% endfor %}`,
		);
	}

	lines.push(
		`\t\t{% cache using key "entry-#{entry.id}" for 1 hour %}`,
		`\t\t\t{{ forms.field('comment', { label: 'Comment'|t('site'), required: true }) }}`,
		`\t\t{% endcache %}`,
		`\t</article>`,
		`{% endblock %}`,
	);

	return lines.join('\n');
}

/** A project of `count` templates plus the layout, macro and partial they reference. */
export function generateProject(count = 500): GeneratedProject {
	const random = seededRandom(0x7716);
	const templates = new Map<string, string>();

	templates.set(
		'_layouts/site.twig',
		[
			`<!DOCTYPE html>`,
			`<html lang="{{ craft.app.language }}">`,
			`<head>`,
			`\t<title>{% block title %}{{ siteName }}{% endblock %}</title>`,
			`\t{% block head %}{% endblock %}`,
			`</head>`,
			`<body>`,
			`\t{% block content %}{% endblock %}`,
			`</body>`,
			`</html>`,
		].join('\n'),
	);
	templates.set(
		'_macros/forms.twig',
		[
			`{% macro field(name, options = {}) %}`,
			`\t<label for="{{ name }}">{{ options.label ?? name|title }}</label>`,
			`\t<input id="{{ name }}" name="{{ name }}"{{ options.required ? ' required' }}>`,
			`{% endmacro %}`,
		].join('\n'),
	);
	templates.set(
		'_partials/card.twig',
		[
			`<a class="card" href="{{ entry.url }}">`,
			`\t<h3>{{ entry.title }}</h3>`,
			`\t{% if entry.summary is defined %}<p>{{ entry.summary|striptags }}</p>{% endif %}`,
			`</a>`,
		].join('\n'),
	);

	for (let index = 0; index < count; index += 1) {
		const section = SECTIONS[index % SECTIONS.length]!;
		templates.set(`${section}/entry-${index}.twig`, generateTemplate(index, random));
	}

	return { templates };
}

/**
 * A single template of at least `lineCount` lines, for the parse budget.
 *
 * Built by repeating the generated shapes rather than one long line, so the
 * parser walks realistically deep nesting rather than a flat token run.
 */
export function generateLargeTemplate(lineCount = 2000): string {
	const random = seededRandom(0x2000);
	const lines: string[] = [`{% extends '_layouts/site.twig' %}`, ``];

	for (let index = 0; lines.length < lineCount; index += 1) {
		lines.push(...generateTemplate(index, random).split('\n'), '');
	}

	return lines.slice(0, lineCount).join('\n');
}
