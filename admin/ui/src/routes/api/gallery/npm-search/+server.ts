import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchNpm } from '$lib/server/gallery';

export const GET: RequestHandler = async ({ url }) => {
  const query = url.searchParams.get("q") ?? "";
  if (!query) return json({ error: "query required" }, { status: 400 });
  const results = await searchNpm(query);
  return json({ results });
};
