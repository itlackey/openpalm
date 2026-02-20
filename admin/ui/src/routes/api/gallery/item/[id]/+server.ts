import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGalleryItem, getRiskBadge } from '$lib/server/gallery';

export const GET: RequestHandler = async ({ params }) => {
  const item = getGalleryItem(params.id);
  if (!item) {
    return json({ error: "item not found" }, { status: 404 });
  }
  return json({ item, riskBadge: getRiskBadge(item.risk) });
};
