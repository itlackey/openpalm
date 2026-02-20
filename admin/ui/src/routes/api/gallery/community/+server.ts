import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchPublicRegistry } from '$lib/server/gallery';
import type { GalleryCategory } from '$lib/server/gallery';

export const GET: RequestHandler = async ({ url }) => {
  const query = url.searchParams.get("q") ?? "";
  const category = url.searchParams.get("category") as GalleryCategory | null;
  const items = await searchPublicRegistry(query, category ?? undefined);
  return json({ items, total: items.length, source: "community-registry" });
};
