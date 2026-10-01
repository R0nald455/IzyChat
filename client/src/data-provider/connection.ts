import { useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, Time, dataService } from 'librechat-data-provider';
import { logger } from '~/utils';

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
 * IzyTesting's side is noticed within seconds. A 401 here already flows
 * through the normal axios response interceptor (attempts a refresh, then
 * redirects to login when that refresh also fails) - this hook only needs to
 * keep asking, not handle the failure itself.
 */
export const useIzyTestingSessionGuard = (isAuthenticated = false) => {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const checkSession = () => {
      dataService.checkIzyTestingSession().catch(() => {
        /** Handled by the axios response interceptor (refresh + redirect). */
      });
    };

    intervalRef.current = setInterval(checkSession, 5000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isAuthenticated]);
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
