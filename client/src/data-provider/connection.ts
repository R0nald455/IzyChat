import { useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, Time, dataService } from 'librechat-data-provider';
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
export const useIzyTestingSessionGuard = (isAuthenticated = false, onRevoked?: () => void) => {
  const queryClient = useQueryClient();
  const onRevokedRef = useRef(onRevoked);
  onRevokedRef.current = onRevoked;
  const organizationIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isAuthenticated) {
      organizationIdRef.current = undefined;
      return;
    }

    let inFlight = false;
    let revoked = false;

    const applyOrganization = (organizationId?: string | null) => {
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
      if (organizationIdRef.current === undefined) {
        console.log('[IzyWipe] applyOrganization init', {
          href: window.location.href,
          next,
        });
        organizationIdRef.current = next;
        return;
      }
      if (next === organizationIdRef.current) {
        return;
      }
      const previous = organizationIdRef.current;
      organizationIdRef.current = next;
      const shouldResetChat =
        window.location.pathname.startsWith('/c/') && !window.location.pathname.endsWith('/new');
      izyDiag('org-switch', {
        previous,
        next,
        shouldResetChat,
      });
      logger.log('IzyTesting organization changed; refreshing conversation history');
      queryClient.invalidateQueries([QueryKeys.allConversations]);
      queryClient.invalidateQueries([QueryKeys.archivedConversations]);
      queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
      queryClient.invalidateQueries([QueryKeys.searchConversations]);
      queryClient.removeQueries([QueryKeys.conversation]);
      queryClient.removeQueries([QueryKeys.messages]);
      queryClient.invalidateQueries([QueryKeys.memories]);
      if (shouldResetChat) {
        window.history.pushState(null, '', '/c/new');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
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
      if (inFlight || revoked) {
        return;
      }
      inFlight = true;
      dataService
        .checkIzyTestingSession()
        .then((response) => {
          applyOrganization(response?.organizationId);
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
        });
    };

    const interval = setInterval(checkSession, 5000);
    checkSession();

    return () => clearInterval(interval);
  }, [isAuthenticated, queryClient]);
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
