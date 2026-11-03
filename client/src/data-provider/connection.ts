import { useCallback, useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, Time, dataService } from 'librechat-data-provider';
import { izyActiveOrganizationAtom } from '~/store/izyOrganization';
import { izyDiag, logger } from '~/utils';

export const useHealthCheck = (isAuthenticated = false) => {
  const queryClient = useQueryClient();
  const isInitialized = useRef(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const focusHandlerRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    // Only start health check if authenticated
    if (!isAuthenticated) {
      return;
    }

    // Prevent multiple initializations
    if (isInitialized.current) {
      return;
    }
    isInitialized.current = true;

    // Use a longer delay to ensure all rendering is complete
    const initTimer = setTimeout(() => {
      const performHealthCheck = async () => {
        try {
          await queryClient.fetchQuery([QueryKeys.health], () => dataService.healthCheck(), {
            retry: false,
            cacheTime: 0,
            staleTime: 0,
          });
        } catch (error) {
          console.error('Health check failed:', error);
        }
      };

      // Initial check
      performHealthCheck();

      // Set up interval for recurring checks
      intervalRef.current = setInterval(performHealthCheck, Time.TEN_MINUTES);

      // Set up window focus handler
      const handleWindowFocus = async () => {
        const queryState = queryClient.getQueryState([QueryKeys.health]);

        if (!queryState?.dataUpdatedAt) {
          await performHealthCheck();
          return;
        }

        const lastUpdated = new Date(queryState.dataUpdatedAt);
        const tenMinutesAgo = new Date(Date.now() - Time.TEN_MINUTES);

        logger.log(`Last health check: ${lastUpdated.toISOString()}`);
        logger.log(`Ten minutes ago: ${tenMinutesAgo.toISOString()}`);

        if (lastUpdated < tenMinutesAgo) {
          await performHealthCheck();
        }
      };

      // Store handler for cleanup
      focusHandlerRef.current = handleWindowFocus;
      window.addEventListener('focus', handleWindowFocus);
    }, 500);

    return () => {
      clearTimeout(initTimer);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      // Remove focus event listener if it was added
      if (focusHandlerRef.current) {
        window.removeEventListener('focus', focusHandlerRef.current);
        focusHandlerRef.current = null;
      }
    };
  }, [isAuthenticated, queryClient]);
};

/**
 * Polls every few seconds while authenticated so a session revoked from
 * IzyTesting's side is noticed within seconds. The axios interceptor first
 * tries a refresh; a 401 that still reaches here means the refreshed token is
 * revoked too, so `onRevoked` must end the session - otherwise every tick
 * would refresh again and the app would sit in an endless refresh loop.
 * It also renews the server-side OpenID session when `/check` reports it gone.
 */
const IZY_ORG_POLL_MS = 1000;
const IZY_ORG_CHANGED_MESSAGE = 'izy:organization-changed';

const IZY_ORG_SCOPED_QUERY_ROOTS = [
  QueryKeys.allConversations,
  QueryKeys.archivedConversations,
  QueryKeys.pinnedConversations,
  QueryKeys.searchConversations,
  QueryKeys.conversation,
  QueryKeys.messages,
  QueryKeys.memories,
  QueryKeys.projects,
  QueryKeys.project,
  QueryKeys.projectFiles,
  QueryKeys.projectAvailableFiles,
  QueryKeys.projectConversations,
] as const;

function resetLocationForOrganizationSwitch() {
  const { pathname } = window.location;
  if (pathname.startsWith('/c/') && !pathname.endsWith('/new')) {
    window.history.pushState(null, '', '/c/new');
    window.dispatchEvent(new PopStateEvent('popstate'));
    return;
  }
  if (/^\/projects\/[^/]+/.test(pathname)) {
    window.history.pushState(null, '', '/projects');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
}

export const useIzyTestingSessionGuard = (isAuthenticated = false, onRevoked?: () => void) => {
  const queryClient = useQueryClient();
  const setIzyOrganization = useSetAtom(izyActiveOrganizationAtom);
  const onRevokedRef = useRef(onRevoked);
  onRevokedRef.current = onRevoked;
  const organizationIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isAuthenticated) {
      organizationIdRef.current = undefined;
      setIzyOrganization({ organizationId: null, organizationName: null });
      return;
    }

    let inFlight = false;
    let pendingCheck = false;
    let revoked = false;

    const dropOrganizationCaches = () => {
      for (const queryKey of IZY_ORG_SCOPED_QUERY_ROOTS) {
        queryClient.removeQueries([queryKey]);
      }
    };

    const refetchOrganizationScopedQueries = () => {
      void queryClient.refetchQueries({
        type: 'active',
        predicate: (query) => IZY_ORG_SCOPED_QUERY_ROOTS.some((root) => query.queryKey[0] === root),
      });
    };

    const applyOrganization = (
      organizationId?: string | null,
      organizationName?: string | null,
    ) => {
      /** A missing org on one poll is a lookup miss, not a switch. Resetting to
       *  /c/new here was wiping chats that had just been created. */
      if (typeof organizationId !== 'string' || organizationId.trim() === '') {
        izyDiag('org-skip-empty', {
          previous: organizationIdRef.current,
          incoming: organizationId ?? null,
        });
        return;
      }
      const next = organizationId.trim();
      const nextName =
        typeof organizationName === 'string' && organizationName.trim()
          ? organizationName.trim()
          : null;
      if (organizationIdRef.current === undefined) {
        console.log('[IzyWipe] applyOrganization init', {
          href: window.location.href,
          next,
        });
        organizationIdRef.current = next;
        setIzyOrganization({ organizationId: next, organizationName: nextName });
        return;
      }
      if (next === organizationIdRef.current) {
        setIzyOrganization({ organizationId: next, organizationName: nextName });
        return;
      }
      const previous = organizationIdRef.current;
      izyDiag('org-switch', {
        previous,
        next,
        pathname: window.location.pathname,
      });
      logger.log('IzyTesting organization changed; refreshing conversation history');
      dropOrganizationCaches();
      organizationIdRef.current = next;
      setIzyOrganization({ organizationId: next, organizationName: nextName });
      resetLocationForOrganizationSwitch();
      refetchOrganizationScopedQueries();
    };

    const endSession = (reason: string) => {
      revoked = true;
      clearInterval(interval);
      logger.log(reason);
      onRevokedRef.current?.();
    };

    /**
     * The server lost the OpenID tokens behind this bearer (session expiry or a
     * restart); refreshing rebuilds them before the next message needs them.
     * A failed refresh means IzyTesting no longer backs this session.
     */
    const recoverSession = () =>
      dataService.recoverAuthSession().then(
        (token) => {
          if (!token) {
            endSession('IzyBot session could not be renewed; logging out');
          }
        },
        () => endSession('IzyBot session could not be renewed; logging out'),
      );

    const checkSession = () => {
      if (revoked) {
        return;
      }
      if (inFlight) {
        pendingCheck = true;
        return;
      }
      inFlight = true;
      dataService
        .checkIzyTestingSession()
        .then((response) => {
          applyOrganization(response?.organizationId, response?.organizationName);
          if (response?.refreshRequired === true) {
            return recoverSession();
          }
        })
        .catch((error) => {
          if (error?.response?.status !== 401) {
            return;
          }
          endSession('IzyTesting session revoked; logging out');
        })
        .finally(() => {
          inFlight = false;
          if (pendingCheck) {
            pendingCheck = false;
            checkSession();
          }
        });
    };

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      checkSession();
    };

    const onParentMessage = (event: MessageEvent) => {
      const payload = event.data as {
        type?: string;
        organizationId?: string;
        organizationName?: string | null;
      } | null;
      if (payload?.type !== IZY_ORG_CHANGED_MESSAGE) {
        return;
      }
      applyOrganization(payload.organizationId, payload.organizationName);
    };

    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      checkSession();
    }, IZY_ORG_POLL_MS);
    checkSession();
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    window.addEventListener('message', onParentMessage);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.removeEventListener('message', onParentMessage);
    };
  }, [isAuthenticated, queryClient, setIzyOrganization]);
};

export const useInteractionHealthCheck = () => {
  const queryClient = useQueryClient();
  const lastInteractionTimeRef = useRef(Date.now());

  const checkHealthOnInteraction = useCallback(() => {
    const currentTime = Date.now();
    if (currentTime - lastInteractionTimeRef.current > Time.FIVE_MINUTES) {
      logger.log(
        'Checking health on interaction. Time elapsed:',
        currentTime - lastInteractionTimeRef.current,
      );
      queryClient.invalidateQueries([QueryKeys.health]);
      lastInteractionTimeRef.current = currentTime;
    }
  }, [queryClient]);

  return checkHealthOnInteraction;
};
