import type { ErrorRendererProps } from './parts';
import { ErrorBody } from './parts';
import { useLocalize } from '~/hooks';

export default function BalanceError({}: ErrorRendererProps) {
  const localize = useLocalize();
  return (
    <ErrorBody>
      <p>{localize('com_error_token_balance')}</p>
    </ErrorBody>
  );
}
