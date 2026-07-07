import type { PageServerLoad } from './$types';
import { resolveClientAppUrl } from '@openpalm/lib';

export const load: PageServerLoad = async () => {
  return {
    localClientAppUrl: resolveClientAppUrl(),
  };
};
