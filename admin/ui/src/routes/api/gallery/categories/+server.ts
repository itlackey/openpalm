import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listGalleryCategories } from '$lib/server/gallery';

export const GET: RequestHandler = async () => {
  return json({ categories: listGalleryCategories() });
};
