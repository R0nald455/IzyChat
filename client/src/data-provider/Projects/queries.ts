import { useContext } from 'react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  ProjectAvailableFilesParams,
  ProjectAvailableFilesResponse,
  ProjectListParams,
  ProjectListResponse,
  TChatProject,
  TChatProjectFile,
} from 'librechat-data-provider';
import type {
  UseInfiniteQueryOptions,
  QueryObserverResult,
  UseQueryOptions,
} from '@tanstack/react-query';
import { useIzyOrganizationQueryScope } from '~/store/izyOrganization';
import { ProjectNamesContext } from '~/Providers/ProjectNamesContext';

export const useProjectsInfiniteQuery = (
  params: ProjectListParams = {},
  config?: UseInfiniteQueryOptions<ProjectListResponse, unknown>,
) => {
  const { sortBy, sortDirection, search, limit } = params;
  const izyOrganizationId = useIzyOrganizationQueryScope();

  return useInfiniteQuery<ProjectListResponse>({
    queryKey: [QueryKeys.projects, { sortBy, sortDirection, search, limit, izyOrganizationId }],
    queryFn: ({ pageParam }) =>
      dataService.listProjects({
        sortBy,
        sortDirection,
        search,
        limit,
        cursor: pageParam?.toString(),
      }),
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    keepPreviousData: !izyOrganizationId,
    staleTime: 5 * 60 * 1000,
    cacheTime: 30 * 60 * 1000,
    ...config,
  });
};

export const useProjectQuery = (
  projectId?: string | null,
  config?: UseQueryOptions<TChatProject>,
): QueryObserverResult<TChatProject, unknown> => {
  const izyOrganizationId = useIzyOrganizationQueryScope();

  return useQuery<TChatProject>(
    [QueryKeys.project, projectId, izyOrganizationId],
    () => dataService.getProjectById(projectId ?? ''),
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: izyOrganizationId ? true : false,
      ...config,
    },
  );
};
/**
 * A project's name for a row that only carries its id. The sidebar already holds the
 * recent projects, so a name found there costs no request; only a project past that
 * list is fetched, once per id. A record written by id (a rename) still wins.
 */
export const useProjectName = (projectId?: string | null): string | undefined => {
  const listed = useContext(ProjectNamesContext);
  const listedName = projectId ? listed?.names.get(projectId) : undefined;
  const { data: project } = useProjectQuery(projectId, {
    enabled: Boolean(projectId) && !listed?.isPending && listedName == null,
  });
  return project?.name ?? listedName;
};
export const useProjectFilesQuery = (
  projectId?: string | null,
  config?: UseQueryOptions<TChatProjectFile[]>,
): QueryObserverResult<TChatProjectFile[], unknown> => {
  const izyOrganizationId = useIzyOrganizationQueryScope();

  return useQuery<TChatProjectFile[]>(
    [QueryKeys.projectFiles, projectId, izyOrganizationId],
    () => dataService.getProjectFiles(projectId ?? ''),
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
      ...config,
    },
  );
};
export const useProjectAvailableFilesInfiniteQuery = (
  projectId?: string | null,
  params: ProjectAvailableFilesParams = {},
  config?: UseInfiniteQueryOptions<ProjectAvailableFilesResponse, unknown>,
) => {
  const queryParams = { limit: params.limit, search: params.search };
  const izyOrganizationId = useIzyOrganizationQueryScope();

  return useInfiniteQuery<ProjectAvailableFilesResponse>({
    queryKey: [QueryKeys.projectAvailableFiles, projectId, queryParams, izyOrganizationId],
    queryFn: ({ pageParam }) =>
      dataService.getAvailableProjectFiles(projectId ?? '', {
        ...queryParams,
        cursor: pageParam?.toString(),
      }),
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    enabled: Boolean(projectId),
    refetchOnWindowFocus: false,
    ...config,
  });
};
