import { atom, useAtomValue } from 'jotai';

export type IzyActiveOrganization = {
  organizationId: string | null;
  organizationName: string | null;
};

export const izyActiveOrganizationAtom = atom<IzyActiveOrganization>({
  organizationId: null,
  organizationName: null,
});

/** When set, conversation and project queries include this in their React Query key. */
export function useIzyOrganizationQueryScope(): string | undefined {
  const { organizationId } = useAtomValue(izyActiveOrganizationAtom);
  if (typeof organizationId !== 'string' || organizationId.trim() === '') {
    return undefined;
  }
  return organizationId.trim();
}
