export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string };
export function slug(s: string): string;
export function render(body: string): { html: string; toc: { depth: number; id: string; text: string }[] };
export function build(): { name: string; title: string; path: string }[];
